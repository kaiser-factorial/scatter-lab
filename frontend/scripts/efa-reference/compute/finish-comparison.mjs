// Continue the explicitly authorized experimental comparison in serial order.
// Never launches the original full-size JavaScript CPU baseline or publishes
// application results. The already-running strict GPU fit is observed only.
import { readFile, writeFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const root = 'scripts/efa-reference/compute';
const statusPath = `${root}/remaining-suite.json`;
try { await access(statusPath); throw new Error('Suite status already exists; inspect it before starting another coordinator'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const status = { status: 'running', startedAt: new Date().toISOString(), stages: [], originalJavaScriptFullSizeBaseline: 'skipped-by-user' };
const save = () => writeFile(statusPath, JSON.stringify(status, null, 2) + '\n');
let activeChild;
const stop = signal => { status.status = 'interrupted'; void save(); activeChild?.kill(signal); };
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
const read = async filename => JSON.parse(await readFile(`${root}/${filename}`, 'utf8'));
async function run(name, args, outputFile) {
  if (status.status !== 'running') throw new Error('Suite interrupted');
  if (outputFile) {
    try { await access(`${root}/${outputFile}`); throw new Error(`Refusing to overwrite ${outputFile}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const stage = { name, args, startedAt: new Date().toISOString(), status: 'running' };
  status.stages.push(stage); await save();
  const exitCode = await new Promise((resolve, reject) => {
    activeChild = spawn(process.execPath, args, { stdio: 'inherit' });
    activeChild.once('error', reject);
    activeChild.once('exit', (code, signal) => resolve(code ?? signal));
  });
  activeChild = undefined;
  Object.assign(stage, { status: exitCode === 0 ? 'completed' : 'failed', exitCode, endedAt: new Date().toISOString() });
  await save();
  if (exitCode !== 0) throw new Error(`${name} exited ${exitCode}`);
}
try {
  await save();
  const observed = { name: 'Observe existing strict GPU full-size fit', status: 'waiting', startedAt: new Date().toISOString() };
  status.stages.push(observed); await save();
  const deadline = Date.now() + 2 * 60 * 60 * 1000;
  let full;
  while (!full && status.status === 'running') {
    try { full = await read('browser-large-gpu-strict-reduced.json'); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (Date.now() > deadline) throw new Error('Observation deadline reached; existing GPU process was not stopped');
    if (!full) await new Promise(resolve => setTimeout(resolve, 5000));
  }
  if (status.status !== 'running') throw new Error('Suite interrupted');
  Object.assign(observed, { status: full.status, endedAt: new Date().toISOString() }); await save();
  if (!['completed-unqualified', 'passed'].includes(full.status)) throw new Error('Strict GPU full-size execution failed; inspect retained evidence');
  await run('Verify full-size numerical agreement', [`${root}/compare-results.mjs`]);
  const comparison = await read('comparison.json');
  const strict = comparison.largeComparison.find(result => result.candidate === 'browser-large-gpu-strict-reduced.json');
  if (strict?.passed !== true) throw new Error('Strict GPU full-size numerical comparison failed; no tolerances changed');
  await run('Strict GPU holdout refit', [`${root}/check-pipeline.mjs`, 'http://localhost:3000/efa-qualification/compute/index.html?pipeline=1&fixture=large-holdout&backend=gpu-strict-reduced&block=128&budgetMiB=1536&probeCancellation=1', `${root}/browser-holdout-gpu-strict-reduced.json`, `--worker-archive=${full.workerArchive}`], 'browser-holdout-gpu-strict-reduced.json');
  const experiments = [];
  for (const rowCache of [false, true]) for (const threads of [1, 2, 4]) {
    const label = `native-reuse-${rowCache ? 'row-cache' : 'direct'}-${threads}`, filename = `${label}.json`;
    const args = [`${root}/run-monitored.mjs`, `${root}/${label}`, process.execPath,
      `${root}/check-native-resident.mjs`, `${root}/${filename}`, '--source=scripts/efa-reference/compute/TraceServerOptimized.scala', '--class=TraceServerOptimized', `--threads=${threads}`, '--repeats=5', `--reference=${root}/native-resident-reference.json`, ...(rowCache ? ['--row-cache'] : [])];
    await run(label, args, filename);
    const result = await read(filename);
    if (result.status !== 'passed' || !Number.isFinite(result.subsequentMedianMs)) throw new Error(`Native optimization failed: ${label}`);
    experiments.push({ filename, threads, rowCache, subsequentMedianMs: result.subsequentMedianMs });
  }
  experiments.sort((a, b) => a.subsequentMedianMs - b.subsequentMedianMs);
  const selected = experiments[0];
  status.nativeSelection = { criterion: 'Lowest subsequent median on ten representative case blocks, after all six configurations passed Float64 parity. This is a kernel selection, not a full-fit speed guarantee.', candidates: experiments, selected };
  await save();
  const nativeOptions = ['--source=scripts/efa-reference/compute/TraceServerOptimized.scala', '--class=TraceServerOptimized', `--threads=${selected.threads}`, ...(selected.rowCache ? ['--row-cache'] : [])];
  await run('Optimized native R qualification', [`${root}/check-scala-pipeline.mjs`, `${root}/scala-optimized-qualified.json`, ...nativeOptions], 'scala-optimized-qualified.json');
  const qualified = await read('scala-optimized-qualified.json');
  if (qualified.status !== 'passed' || qualified.results.length !== 10) throw new Error('Optimized native reference qualification incomplete');
  await run('Optimized native holdout refit', [`${root}/run-monitored.mjs`, `${root}/scala-holdout-resident`, process.execPath, `${root}/check-scala-pipeline.mjs`, `${root}/scala-holdout-resident.json`, '--fixture=large-holdout', '--block=128', '--budget-mib=1536', `--pipeline-archive=${qualified.sourceArchives.pipeline}`, ...nativeOptions], 'scala-holdout-resident.json');
  await run('Final numerical comparison', [`${root}/compare-results.mjs`]);
  const final = await read('comparison.json');
  if (final.holdoutComparison?.passed !== true) throw new Error('Holdout comparison failed; inspect retained evidence');
  status.status = 'completed'; status.completedAt = new Date().toISOString();
  status.defaultBrowserGpu = 'Numerical failure preserved separately; developer-only strict-math success does not qualify default WebGPU';
} catch (error) {
  status.status = status.status === 'interrupted' ? 'interrupted' : 'failed'; status.error = String(error);
  process.exitCode = 1;
} finally { await save(); console.log(JSON.stringify({ status: status.status, error: status.error, nativeSelection: status.nativeSelection })); }
