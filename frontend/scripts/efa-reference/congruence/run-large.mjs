import { build } from 'esbuild';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
const folder = 'scripts/efa-reference/congruence';
const reportFolder = process.env.BENCHMARK_REPORT_DIR ?? folder;
await mkdir(reportFolder, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'efa-large-congruence-'));
const bundlePath = join(temporary, 'large.mjs');
const bundle = await build({ entryPoints: [`${folder}/large-benchmark.ts`], outfile: bundlePath, bundle: true, platform: 'node', format: 'esm', metafile: true });
const sourceHashes = {};
for (const input of Object.keys(bundle.metafile.inputs)) sourceHashes[input] = createHash('sha256').update(await readFile(input)).digest('hex');
const requested = (process.env.BENCHMARK_METHODS ?? 'pca,minres,weighted,ml,fiml-block').split(',');
const limits = { pca: 120, minres: 180, weighted: 180, ml: 180, 'fiml-block': 240, 'fiml-fragmented': 90 };
const receipt = { recordedAt: new Date().toISOString(), driverSha256: createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'), bundle: bundlePath, bundleSha256: createHash('sha256').update(await readFile(bundlePath)).digest('hex'), sourceHashes, scope: 'Largest synthetic executed after small-data accuracy matrix. Sequential Node processes on a shared workstation, hard wall-clock limits in seconds. Not an idle controlled benchmark. Child reports peak RSS; optional external sampling may be unavailable.', results: [] };
const receiptPath = `${reportFolder}/large-benchmark-receipt.json`;
await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
for (const method of requested) {
  if (!(method in limits)) throw new Error(`Unknown benchmark method ${method}`);
  const output = `${reportFolder}/large-${method}-report.json`, start = Date.now();
  await rm(output, { force: true });
  const child = spawn(process.execPath, ['--max-old-space-size=4096', bundlePath], { detached: true, stdio: 'inherit', env: { ...process.env, BENCHMARK_METHOD: method, BENCHMARK_OUTPUT: output } });
  let timedOut = false, memoryLimit = false, peakRssKiB = null, measurementFailure = null;
  const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
  const timer = setTimeout(() => { timedOut = true; stop(); }, limits[method] * 1000);
  const monitor = setInterval(async () => { try { const rss = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim()); if (rss > 0) peakRssKiB = Math.max(peakRssKiB ?? 0, rss); if (rss > 3 * 1024 * 1024) { memoryLimit = true; stop(); } } catch (error) { measurementFailure = String(error); try { const latest = JSON.parse(await readFile(output,'utf8')); if (latest.peakRssKiB > 3 * 1024 * 1024) { memoryLimit = true; stop(); } } catch {} } }, 1000);
  const exitCode = await new Promise(resolve => child.on('exit', resolve));
  clearTimeout(timer); clearInterval(monitor);
  let result;
  try { result = JSON.parse(await readFile(output, 'utf8')); } catch { result = { status: 'no-child-report' }; }
  if (exitCode !== 0 && !timedOut && !memoryLimit) result.status = 'process-error';
  if (timedOut || memoryLimit) { result.status = timedOut ? 'timeout' : 'memory-limit'; result.limits = { wallSeconds: limits[method], rssGiB: 3 }; await writeFile(output, JSON.stringify(result, null, 2) + '\n'); }
  const record = { method, status: result.status, exitCode, wallSeconds: (Date.now() - start) / 1000, wallLimitSeconds: limits[method], sampledPeakRssKiB: peakRssKiB, measurementFailure, childReportedRssKiB: result.peakRssKiB, rssQualification: result.status === 'passed' ? 'Child peak RSS over its complete run' : 'Last child-reported RSS is a lower bound on whole-run peak', report: output };
  receipt.results.push(record); await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify(record));
}
receipt.changedAfterBundle = [];
for (const [file, hash] of Object.entries(sourceHashes)) if (createHash('sha256').update(await readFile(file)).digest('hex') !== hash) receipt.changedAfterBundle.push(file);
await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
if (receipt.changedAfterBundle.length || receipt.results.some(r => r.status !== 'passed' && !(r.method === 'fiml-fragmented' && r.status === 'timeout'))) process.exitCode = 1;
