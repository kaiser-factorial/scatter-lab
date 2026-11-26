// Production service/worker qualification, synthetic inputs only, ordinary Chrome.
import { build } from 'esbuild';
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { chromium } from '@playwright/test';
const out = 'public/efa-qualification/cache';
await mkdir(out, { recursive: true });
await build({ entryPoints: ['src/lib/efa/efa.worker.ts'], bundle: true, format: 'esm', outfile: `${out}/efa.worker.js` });
await build({ stdin: { resolveDir: process.cwd(), contents: `
import { EfaService } from './src/lib/efa/service.ts';
import { validateEfaState } from './src/lib/efa/persistence.ts';
window.run = async (backend, blockSize) => {
  const results = [], service = new EfaService(() => new Worker('./efa.worker.js', { type: 'module' }), 4);
  for (const name of ['normal', 'pairwise', 'complete', 'skew', 'heavy-tail']) {
    const input = await (await fetch('./reference/' + name + '.input.json')).json();
    const spec = { items: input.columns.map((column, i) => ({ column, categories: input.categories[i], reverse: input.reverse.includes(i) })), nFactors: input.nFactors, extraction: 'wlsmv', rotation: 'oblimin', missing: input.missing, label: 'Cache qualification', seed: 73021, sample: { partition: 'all' }, compute: { backend, blockSize } };
    let origin;
    for (const rotation of ['oblimin', 'promax', 'varimax']) {
      const job = service.fit(input, { ...spec, rotation }, Array.from({ length: input.nRows }, (_, i) => i));
      const result = await job.promise, report = service.report(job.id);
      if (rotation === 'oblimin') origin = job.id;
      else {
        if (result.provenance.execution.reusedFromJobId !== origin) throw new Error('Invariant cache was not used');
        if (report.execution.timings || report.requests['fit-cache']) throw new Error('Cache hit presented fresh trace work');
        if (Object.keys(report.workerStages).some(stage => /Ordinal uncertainty|Robust trace|Case projection/.test(stage))) throw new Error('Invariant work repeated');
      }
      const saved = { runs: [{ id: job.id, revision: 1, createdAt: new Date().toISOString(), datasetRevision: 'synthetic', spec: { ...spec, rotation }, result, eligibleRows: Array.from({ length: input.nRows }, (_, i) => i), kind: 'fit', reviews: {}, reasons: 'qualification', revisedAfterHoldout: false, scoreColumns: [] }], splits: [] };
      validateEfaState(JSON.parse(JSON.stringify(saved)), input.nRows);
      results.push({ name, rotation, result, report });
    }
  }
  return results;
};` }, bundle: true, format: 'esm', outfile: `${out}/client.js` });
await cp('src/lib/__tests__/fixtures/efa-weighted', `${out}/reference`, { recursive: true });
await writeFile(`${out}/index.html`, '<!doctype html><html lang="en"><title>EFA cache qualification</title><script type="module" src="./client.js"></script></html>');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const reports = {}, comparisons = [];
const error = (a, b) => {
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return Math.max(0, ...a.map((v, i) => error(v, b[i])));
  if (typeof a === 'number' && Number.isFinite(a) && typeof b === 'number' && Number.isFinite(b)) return Math.abs(a - b);
  throw new Error('Invalid output dimensions or nonfinite values');
};
try {
  const page = await browser.newPage();
  for (const [backend, block] of [['cpu', 32], ['webgpu', 128], ['webgpu', 256]]) {
    await page.goto('http://localhost:3000/efa-qualification/cache/index.html');
    await page.waitForFunction(() => window.run);
    reports[`${backend}${block}`] = await page.evaluate(([backend, block]) => window.run(backend, block), [backend, block]);
    console.log(`${backend}${block}: 15 production fits completed`);
  }
  for (const key of ['webgpu128', 'webgpu256']) for (let i = 0; i < reports.cpu32.length; i++) {
    const a = reports.cpu32[i], b = reports[key][i], x = a.result, y = b.result;
    const check = { backend: key, name: a.name, rotation: a.rotation,
      pattern: error(x.rotation.pattern, y.rotation.pattern), phi: error(x.rotation.phi, y.rotation.phi),
      standardErrors: Math.max(...['pattern', 'structure', 'phi', 'communalities'].map(k => error(x.weighted.robust.standardErrors[k], y.weighted.robust.standardErrors[k]))),
      statistic: Math.abs(x.weighted.robust.test.statistic - y.weighted.robust.test.statistic), selfCheck: y.provenance.execution.selfCheck };
    if (check.pattern > 1e-3 || check.phi > 1e-3 || check.standardErrors > 1e-4 || check.statistic > 1e-4 || !check.selfCheck.passed || check.selfCheck.maxScaledError > 1e-10) throw new Error('Numerical qualification failed');
    comparisons.push(check);
  }
  const hashes = {};
  for (const name of ['efa.worker', 'client']) {
    const bytes = await readFile(`${out}/${name}.js`), hash = createHash('sha256').update(bytes).digest('hex'); hashes[name] = hash;
    await writeFile(`scripts/efa-reference/compute/archives/${hash}.js.gz`, gzipSync(bytes), { flag: 'wx' }).catch(e => { if (e.code !== 'EEXIST') throw e; });
  }
  const developerFlags = (await (await browser.newBrowserCDPSession()).send('Browser.getBrowserCommandLine')).arguments.filter(arg => /webgpu|dawn/i.test(arg));
  if (developerFlags.length) throw new Error('Unexpected WebGPU flags');
  await writeFile(process.argv[2] ?? 'scripts/efa-reference/compute/cache-workflow-v4.json', JSON.stringify({ status: 'passed', recordedAt: new Date().toISOString(), browser: browser.version(), hashes, developerFlags, comparisons, reports }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', fits: 45, comparisons: comparisons.length }));
} finally { await browser.close(); }
