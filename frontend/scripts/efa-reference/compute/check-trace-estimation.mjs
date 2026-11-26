import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

const mode = process.argv[2] ?? 'pilot';
if (!['pilot', 'large', 'tradeoff'].includes(mode)) throw new Error('Choose pilot, large or tradeoff');
const output = process.argv[3] ?? `scripts/efa-reference/compute/trace-estimation-${mode}-v5.json`;
const options = mode === 'large' ? { fixtures: ['large'], n: 20000, p: 500, seeds: [61001, 61002] }
  : mode === 'tradeoff' ? { scenarios: [{name:'normal'}, {name:'synthetic',n:1000,p:20}, {name:'synthetic',n:2000,p:60}, {name:'synthetic',n:5000,p:120}], seeds: Array.from({length:10}, (_,i)=>61001+i) }
  : { fixtures: ['normal', 'pairwise', 'complete', 'skew', 'heavy-tail', 'synthetic'], n: 2000, p: 60, seeds: [61001, 61002, 61003] };
let exactReference;
if (mode === 'large') {
  const path = 'scripts/efa-reference/compute/throughput-browser-large-v3.json', bytes = await readFile(path), saved = JSON.parse(bytes);
  const fit = saved.results.find(r => r.fixture === 'large');
  options.exactReference = { inputSha256: fit.inputSha256, dimensions: fit.dimensions, test: fit.test };
  exactReference = { path, sha256: createHash('sha256').update(bytes).digest('hex'), workerSha256: saved.workerSha256, browser: saved.browser, hardware: saved.hardware, timings: fit.timings, phaseTimings: fit.phaseTimings };
}
const bytes = await readFile('public/efa-qualification/compute/trace-estimation-worker.js');
const workerSha256 = createHash('sha256').update(bytes).digest('hex'), archive = `scripts/efa-reference/compute/archives/${workerSha256}.js.gz`;
await mkdir('scripts/efa-reference/compute/archives', { recursive: true });
try { await writeFile(archive, gzipSync(bytes), { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const exec = promisify(execFile); let timer, memoryTimer, peakRss = 0, samples = 0, samplingErrors = 0, served = 0;
try {
  const page = await browser.newPage(), cdp = await browser.newBrowserCDPSession();
  const args = (await cdp.send('Browser.getBrowserCommandLine')).arguments;
  const webgpuRuntimeFlags = args.filter(arg => /webgpu|dawn/i.test(arg));
  await page.route('**/trace-estimation-worker.js', route => { served++; return route.fulfill({ body: bytes, contentType: 'text/javascript' }); });
  await page.goto('http://localhost:3000/efa-qualification/compute/index.html');
  await page.evaluate(options => {
    window.traceExperiment = { partials: [], estimates: [] };
    const w = new Worker('./trace-estimation-worker.js', { type: 'module' });
    window.traceWorker = w;
    w.onmessage = ({ data }) => {
      if (data.progress) window.traceExperiment.progress = data.progress;
      if (data.selfChecks) window.traceExperiment.selfChecks = data.selfChecks;
      if (data.partial) window.traceExperiment.partials.push(data.partial);
      if (data.estimate) window.traceExperiment.estimates.push(data.estimate);
      if (data.result) { window.traceExperiment.result = data.result; w.terminate(); }
    };
    w.onerror = event => { window.traceExperiment.result = { status: 'failed', error: event.message }; w.terminate(); };
    w.postMessage(options);
  }, options);
  timer = setInterval(async () => {
    try {
      const progress = await page.evaluate(() => ({ progress: window.traceExperiment.progress, lastEstimate: window.traceExperiment.estimates.at(-1), completedFixtures: window.traceExperiment.partials.length }));
      await writeFile(output.replace('.json', '.progress.json'), JSON.stringify(progress, null, 2)); console.log(JSON.stringify(progress));
    } catch (error) { console.error(String(error)); }
  }, 30000);
  memoryTimer = setInterval(async () => {
    try {
      const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
      const { stdout } = await exec('ps', ['-o', 'rss=', '-p', processInfo.map(p => p.id).join(',')]);
      peakRss = Math.max(peakRss, stdout.trim().split(/\s+/).reduce((sum, value) => sum + Number(value), 0) * 1024); samples++;
    } catch { samplingErrors++; }
  }, 1000);
  await page.waitForFunction(() => window.traceExperiment.result, {}, { timeout: 30 * 60 * 1000 });
  const result = await page.evaluate(() => window.traceExperiment.result);
  const report = { ...result, recordedAt: new Date().toISOString(), browser: await browser.version(), hardware: { cpu: os.cpus()[0].model, architecture: os.arch(), memoryBytes: os.totalmem() }, webgpuRuntimeFlags, workerSha256, workerArchive: archive, workerSnapshotsServed: served, options: { ...options, exactReference: undefined }, exactReference, memory: { peakBrowserProcessRssBytes: peakRss, samples, samplingErrors, method: 'One-second RSS sum over isolated Chrome processes; shared pages may be counted more than once' }, heartbeat: await page.evaluate(() => ({ count: Number(document.querySelector('#heartbeat').textContent), maxGapMs: window.maxHeartbeatGap })) };
  if (served !== 1 || webgpuRuntimeFlags.length) { report.status = 'failed'; report.error = 'Invalid worker snapshot delivery or WebGPU flags'; }
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, error: report.error, results: report.results?.map(r => ({ fixture: r.fixture, exact: r.exact.traceSquared, estimates: r.estimates.map(e => ({ seed: e.seed, probes: e.probes, elapsedMs: e.elapsedMs, relativeError: e.relativeTraceSquaredError, delta: e.delta })) })) }));
  if (report.status === 'failed') process.exitCode = 1;
} catch (error) {
  await writeFile(output, JSON.stringify({ status: 'failed', error: String(error), workerSha256, workerArchive: archive }, null, 2)); throw error;
} finally { clearInterval(timer); clearInterval(memoryTimer); await browser.close(); }
