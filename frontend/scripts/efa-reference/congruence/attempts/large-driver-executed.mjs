import { build } from 'esbuild';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
const folder = 'scripts/efa-reference/congruence';
const temporary = await mkdtemp(join(tmpdir(), 'efa-large-congruence-'));
const bundlePath = join(temporary, 'large.mjs');
const bundle = await build({ entryPoints: [`${folder}/large-benchmark.ts`], outfile: bundlePath, bundle: true, platform: 'node', format: 'esm', metafile: true });
const sourceHashes = {};
for (const input of Object.keys(bundle.metafile.inputs)) sourceHashes[input] = createHash('sha256').update(await readFile(input)).digest('hex');
const requested = (process.env.BENCHMARK_METHODS ?? 'pca,minres,weighted,ml,fiml-block').split(',');
const limits = { pca: 120, minres: 180, weighted: 180, ml: 180, 'fiml-block': 240, 'fiml-fragmented': 90 };
const receipt = { recordedAt: new Date().toISOString(), bundle: bundlePath, bundleSha256: createHash('sha256').update(await readFile(bundlePath)).digest('hex'), sourceHashes, scope: 'Largest synthetic executed after small-data accuracy matrix. Isolated sequential Node processes, hard wall-clock limits in seconds, peak RSS sampled and also reported by successful child.', results: [] };
const receiptPath = `${folder}/large-benchmark-receipt.json`;
await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
for (const method of requested) {
  if (!(method in limits)) throw new Error(`Unknown benchmark method ${method}`);
  const output = `${folder}/large-${method}-report.json`, start = Date.now();
  const child = spawn(process.execPath, ['--max-old-space-size=4096', bundlePath], { detached: true, stdio: 'inherit', env: { ...process.env, BENCHMARK_METHOD: method, BENCHMARK_OUTPUT: output } });
  let timedOut = false, memoryLimit = false, peakRssKiB = 0;
  const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
  const timer = setTimeout(() => { timedOut = true; stop(); }, limits[method] * 1000);
  const monitor = setInterval(() => { try { const rss = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8' }).trim()); peakRssKiB = Math.max(peakRssKiB, rss); if (rss > 3 * 1024 * 1024) { memoryLimit = true; stop(); } } catch {} }, 1000);
  const exitCode = await new Promise(resolve => child.on('exit', resolve));
  clearTimeout(timer); clearInterval(monitor);
  let result;
  try { result = JSON.parse(await readFile(output, 'utf8')); } catch { result = { status: 'no-child-report' }; }
  if (timedOut || memoryLimit) { result.status = timedOut ? 'timeout' : 'memory-limit'; result.limits = { wallSeconds: limits[method], rssGiB: 3 }; await writeFile(output, JSON.stringify(result, null, 2) + '\n'); }
  const record = { method, status: result.status, exitCode, wallSeconds: (Date.now() - start) / 1000, wallLimitSeconds: limits[method], sampledPeakRssKiB: peakRssKiB, report: output };
  receipt.results.push(record); await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify(record));
}
receipt.changedAfterBundle = [];
for (const [file, hash] of Object.entries(sourceHashes)) if (createHash('sha256').update(await readFile(file)).digest('hex') !== hash) receipt.changedAfterBundle.push(file);
await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
