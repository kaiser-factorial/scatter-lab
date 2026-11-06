import { chromium } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import { gzipSync, gunzipSync } from 'node:zlib';
const url = process.argv[2] ?? "http://localhost:3000/efa-qualification/compute/index.html?pipeline=true";
const output = process.argv[3] ?? "scripts/efa-reference/compute/browser-pipeline.json";
const parameters = new URL(url).searchParams;
const workerAsset = parameters.has('optimization') ? 'optimization-worker.js' : 'pipeline-worker.js';
const developerArguments = parameters.has('strictMath') || parameters.get('backend') === 'gpu-strict-reduced' ? ['--enable-webgpu-developer-features'] : [];
if (developerArguments.length && !parameters.has('optimization') && parameters.get('backend') !== 'gpu-strict-reduced') throw new Error('Developer strict-math mode requires an explicitly labeled diagnostic backend');
const timeoutMinutes = Number(parameters.get('timeoutMinutes') ?? 48 * 60);
if (!Number.isFinite(timeoutMinutes) || timeoutMinutes < 0) throw new Error('Invalid benchmark timeout');
const workerSource = process.argv.find(arg => arg.startsWith('--worker-archive='))?.slice('--worker-archive='.length);
const workerBytes = workerSource ? gunzipSync(await readFile(workerSource)) : await readFile(`public/efa-qualification/compute/${workerAsset}`);
const workerSha256 = createHash('sha256').update(workerBytes).digest('hex');
if (workerSource && !workerSource.endsWith(`/${workerSha256}.js.gz`)) throw new Error('Archived browser worker hash mismatch');
const archive = `scripts/efa-reference/compute/archives/${workerSha256}.js.gz`;
await mkdir('scripts/efa-reference/compute/archives', { recursive: true });
try { await writeFile(archive, gzipSync(workerBytes), { flag: 'wx' }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
let rotationWorkerBytes, rotationWorkerSha256, rotationWorkerArchive;
if (parameters.has('pipeline')) {
  const rotationSource = process.argv.find(arg => arg.startsWith('--rotation-worker-archive='))?.slice('--rotation-worker-archive='.length);
  rotationWorkerBytes = rotationSource ? gunzipSync(await readFile(rotationSource)) : await readFile('public/efa-qualification/compute/rotation-worker.js');
  rotationWorkerSha256 = createHash('sha256').update(rotationWorkerBytes).digest('hex');
  if (rotationSource && !rotationSource.endsWith(`/${rotationWorkerSha256}.js.gz`)) throw new Error('Archived rotation worker hash mismatch');
  rotationWorkerArchive = `scripts/efa-reference/compute/archives/${rotationWorkerSha256}.js.gz`;
  try { await writeFile(rotationWorkerArchive, gzipSync(rotationWorkerBytes), { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
const browser = await chromium.launch({ channel: "chrome", headless: true, args: developerArguments }), exec = promisify(execFile);
let timer, memoryTimer, peakRss = 0, workerSnapshotsServed = 0, memorySamples = 0, samplingErrors = 0, latestProgress, latestResult;
try {
  const page = await browser.newPage(), cdp = await browser.newBrowserCDPSession();
  const launchCommand = await cdp.send('Browser.getBrowserCommandLine');
  // Record feature flags only; omit temporary profile paths and other launch
  // arguments. Explicit absence of developer WebGPU flags is independently
  // observable rather than inferred only from our launch configuration.
  const webgpuRuntimeFlags = launchCommand.arguments.filter(arg => /webgpu|dawn/i.test(arg));
  // Freeze the actual executable bytes for this run even if a later build
  // changes the local qualification asset while the benchmark is running.
  await page.route(`**/${workerAsset}`, route => { workerSnapshotsServed++; return route.fulfill({ body: workerBytes, contentType: 'text/javascript' }); });
  if (rotationWorkerBytes) await page.addInitScript(source => { window.__rotationWorkerSource = source; }, rotationWorkerBytes.toString('utf8'));
  await page.goto(url);
  await page.getByRole('button', { name: 'Run kernels' }).click();
  timer = setInterval(async () => {
    try {
      const progress = { recordedAt: new Date().toISOString(), backend: parameters.get('backend') ?? 'multiple', stage: await page.locator('#stage').textContent(), peakBrowserRssBytes: peakRss, completedFits: await page.evaluate(() => window.partials.length) };
      latestProgress = progress;
      await writeFile(output.replace('.json', '.progress.json'), JSON.stringify(progress, null, 2) + '\n');
      console.log(JSON.stringify(progress));
    } catch (error) { console.error(String(error)); }
  }, 30000);
  memoryTimer = setInterval(async () => {
    try {
      const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
      const { stdout } = await exec('ps', ['-o', 'rss=', '-p', processInfo.map(p => p.id).join(',')]);
      peakRss = Math.max(peakRss, stdout.trim().split(/\s+/).reduce((a, b) => a + Number(b), 0) * 1024);
      memorySamples++;
    } catch (error) { samplingErrors++; console.error(String(error)); }
  }, 1000);
  await page.waitForFunction(() => document.querySelector('#output').textContent.startsWith('{'), {}, { timeout: timeoutMinutes * 60 * 1000 });
  const result = JSON.parse(await page.locator('#output').textContent());
  latestResult = result;
  let cancellation;
  if (new URL(url).searchParams.has('probeCancellation') && !['failed', 'numerical-failures'].includes(result.status)) {
    await page.waitForFunction(() => window.probeDispatched === true, {}, { timeout: 30000 });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    const acknowledgedMs = Number(await page.locator('#cancel-time').textContent());
    const last = result.results.at(-1);
    cancellation = { acknowledgedMs, passed: acknowledgedMs < 1000, dimensions: last.dimensions, blockSize: last.plan.blockSize, scope: 'Worker termination call duration after an additional kernel dispatch using this fit\'s resident source. Does not measure GPU command retirement.' };
  }
  const report = { ...result, recordedAt: new Date().toISOString(), url, browser: await browser.version(), hardware: { cpu: os.cpus()[0].model, architecture: os.arch(), memoryBytes: os.totalmem() }, memory: { peakBrowserProcessRssBytes: peakRss, method: 'One-second RSS samples summed over isolated Chrome processes; shared pages may be counted more than once' }, heartbeat: await page.evaluate(() => ({ count: Number(document.querySelector('#heartbeat').textContent), maxGapMs: window.maxHeartbeatGap })), workerSha256, workerDelivery: 'Immutable bytes captured at launch and fulfilled by the benchmark harness' };
  Object.assign(report, { rotationWorkerSha256, rotationWorkerArchive, rotationWorkerDelivery: rotationWorkerBytes ? "Immutable source passed to coordinator; Blob workers" : undefined });
  report.workerSnapshotsServed = workerSnapshotsServed;
  report.runtimeLimitMinutes = timeoutMinutes === 0 ? null : timeoutMinutes;
  report.workerArchive = archive;
  report.workerSource = workerSource ?? `public/efa-qualification/compute/${workerAsset}`;
  report.browserArguments = developerArguments;
  report.webgpuRuntimeFlags = webgpuRuntimeFlags;
  report.developerOnly = developerArguments.length > 0;
  Object.assign(report.memory, { samples: memorySamples, samplingErrors });
  if (!memorySamples) report.memory.peakBrowserProcessRssBytes = null;
  report.cancellation = cancellation;
  if (cancellation?.passed === false) { report.status = 'failed'; report.error = 'Worker cancellation exceeded one second'; }
  if (workerSnapshotsServed !== 1) { report.status = 'failed'; report.error = 'The immutable worker snapshot was not served exactly once'; }
  if (parameters.has('pipeline') && result.results.some(fit => fit.rotationExecution?.workerSha256 !== rotationWorkerSha256)) { report.status = 'failed'; report.error = 'Rotation worker executable hash does not match the immutable source'; }
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, error: report.error, results: report.results.map(r => ({ backend: r.backend, fixture: r.fixture, passed: r.passed, totalMs: r.totalMs, errors: r.errors })) }));
  if (['failed', 'numerical-failures'].includes(report.status)) process.exitCode = 1;
} catch (error) {
  const failed = { status: 'failed', failureScope: 'Browser benchmark harness or browser runtime', recordedAt: new Date().toISOString(), error: String(error), results: latestResult?.results ?? [], latestProgress, url, workerSha256, workerSnapshotsServed, memory: { peakBrowserProcessRssBytes: peakRss, samples: memorySamples, samplingErrors } };
  await writeFile(output, JSON.stringify(failed, null, 2) + '\n');
  console.error(JSON.stringify({ status: failed.status, failureScope: failed.failureScope, error: failed.error }));
  process.exitCode = 1;
} finally { clearInterval(timer); clearInterval(memoryTimer); await browser.close(); }
