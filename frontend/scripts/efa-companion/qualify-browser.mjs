import { build } from 'esbuild';
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
const out = 'public/efa-qualification/workflow';
await mkdir(out, { recursive: true });
await build({ entryPoints: ['src/lib/efa/efa.worker.ts'], bundle: true, format: 'esm', outfile: `${out}/efa.worker.js` });
await build({ entryPoints: ['scripts/efa-companion/browser-client.mjs'], bundle: true, format: 'esm', outfile: `${out}/client.js` });
await cp('src/lib/__tests__/fixtures/efa-weighted', `${out}/reference`, { recursive: true });
await writeFile(`${out}/index.html`, '<!doctype html><html lang="en"><title>Public EFA workflow qualification</title><button id="run">Run workflow</button><pre id="status"></pre><script type="module" src="./client.js"></script></html>');
const pairing = JSON.parse(await readFile('/tmp/scatter-efa-companion-pairing.json', 'utf8'));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const reports = {};
try {
  const page = await browser.newPage();
  for (const backend of ['cpu', 'webgpu', 'scala']) {
    await page.goto('http://localhost:3000/efa-qualification/workflow/index.html');
    await page.evaluate(({ backend, pairing }) => { window.backend = backend; window.pairing = pairing; }, { backend, pairing });
    await page.getByRole('button', { name: 'Run workflow' }).click();
    await page.waitForFunction(() => window.finished || window.failure, { }, { timeout: 300000 });
    const failure = await page.evaluate(() => window.failure);
    if (failure) throw new Error(`${backend}: ${failure}`);
    reports[backend] = await page.evaluate(() => window.results);
    console.log(JSON.stringify({ backend, completed: reports[backend].length }));
  }
  const error = (a, b) => { if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return Math.max(0, ...a.map((v, i) => error(v, b[i]))); if (typeof a === 'number' && Number.isFinite(a) && typeof b === 'number' && Number.isFinite(b)) return Math.abs(a - b); throw new Error('Missing or nonfinite comparison output'); };
  const comparisons = [];
  for (const backend of ['webgpu', 'scala']) for (let i = 0; i < reports.cpu.length; i++) {
    const a = reports.cpu[i], b = reports[backend][i], x = a.result, y = b.result;
    const check = { backend, name: a.name, rotation: a.rotation,
      pattern: error(x.rotation.pattern, y.rotation.pattern), phi: error(x.rotation.phi, y.rotation.phi),
      standardErrors: Math.max(...['pattern', 'structure', 'phi', 'communalities'].map(k => error(x.weighted.robust.standardErrors[k], y.weighted.robust.standardErrors[k]))),
      statistic: Math.abs(x.weighted.robust.test.statistic - y.weighted.robust.test.statistic), selfCheck: y.provenance.execution.selfCheck };
    if (check.pattern > 1e-3 || check.phi > 1e-3 || check.standardErrors > 1e-4 || check.statistic > 1e-4 || !check.selfCheck.passed) throw new Error('Numerical qualification failed');
    comparisons.push(check);
  }
  await mkdir('scripts/efa-companion/evidence', { recursive: true });
  await writeFile('scripts/efa-companion/evidence/workflow.json', JSON.stringify({ recordedAt: new Date().toISOString(), browser: browser.version(), workerSha256: createHash('sha256').update(await readFile(`${out}/efa.worker.js`)).digest('hex'), developerFlags: (await (await browser.newBrowserCDPSession()).send('Browser.getBrowserCommandLine')).arguments.filter(arg => /webgpu|dawn/i.test(arg)), comparisons, reports }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', comparisons: comparisons.length }));
} finally { await browser.close(); }
