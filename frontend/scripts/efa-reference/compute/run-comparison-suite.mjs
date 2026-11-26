// Serial qualification driver. It may adopt an explicitly identified live
// native benchmark, but never restarts that job merely because it is slow.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);
const directory = 'scripts/efa-reference/compute';
const output = `${directory}/serial-suite.json`;
const pid = Number(process.argv.find(arg => arg.startsWith('--wait-native-pid='))?.split('=')[1]);
const state = { startedAt: new Date().toISOString(), status: 'running', stages: [] };
const save = () => writeFile(output, JSON.stringify(state, null, 2) + '\n');
const json = async name => JSON.parse(await readFile(`${directory}/${name}`, 'utf8'));
const insist = (condition, message) => { if (!condition) throw new Error(message); };
async function archive(name) {
  try { await rename(`${directory}/${name}`, `${directory}/${name.replace('.json', `.before-suite-${Date.now()}.json`)}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function step(name, command, args, validate) {
  const record = { name, command, args, startedAt: new Date().toISOString(), status: 'running' };
  state.stages.push(record); await save(); console.log(JSON.stringify({ stage: name, status: 'started' }));
  const log = createWriteStream(`${directory}/serial-${name}.log`);
  const started = performance.now();
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      record.pid = child.pid;
      child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${name} exited ${code ?? signal}; see serial-${name}.log`)));
    });
    if (validate) await validate();
    record.status = 'passed';
  } catch (error) { record.status = 'failed'; record.error = String(error); throw error; }
  finally { log.end(); record.elapsedMs = performance.now() - started; record.finishedAt = new Date().toISOString(); await save(); }
  console.log(JSON.stringify({ stage: name, status: record.status, elapsedMs: record.elapsedMs }));
}
async function pipelineReport(name, fixture, backend, rows, independent = false) {
  const report = await json(name);
  insist(!['failed', 'numerical-failures'].includes(report.status), `${name}: ${report.error ?? report.status}`);
  const fit = report.results.find(result => result.fixture === fixture && result.backend === backend);
  insist(fit?.executionStatus === 'completed' && fit.dimensions.rows === rows, `${name}: missing completed requested fit`);
  insist(fit.dimensions.items === (independent ? 8 : 500), `${name}: incorrect item count`);
  insist(['oblimin', 'promax', 'varimax'].every(method => fit.rotations[method]?.standardErrors), `${name}: incomplete rotated uncertainty`);
  insist(fit.rotations.oblimin.scores?.values.length === rows * fit.dimensions.factors, `${name}: missing score vectors`);
  if (independent) insist(fit.passed === true, `${name}: R comparison failed`);
  return report;
}
try {
  insist(Number.isSafeInteger(pid) && pid > 0, 'Provide --wait-native-pid for the already running native benchmark');
  const waiting = { name: 'existing-native-run', pid, startedAt: new Date().toISOString(), status: 'waiting' };
  state.stages.push(waiting); await save();
  for (;;) {
    try {
      process.kill(pid, 0);
      const { stdout } = await exec('ps', ['-p', String(pid), '-o', 'command=']);
      insist(stdout.includes('check-scala-pipeline.mjs') && stdout.includes('scala-large-resident.json'), 'The PID no longer identifies the expected benchmark; inspect before continuing');
    } catch (error) {
      if (error.code === 'ESRCH') break;
      // The process may exit between the liveness check and ps. Only a fresh
      // ESRCH proves it ended; other observation errors stop for inspection.
      try { process.kill(pid, 0); } catch (fresh) { if (fresh.code === 'ESRCH') break; throw fresh; }
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  await pipelineReport('scala-large-resident.json', 'large', 'scala-resident', 20000);
  waiting.status = 'completed'; waiting.finishedAt = new Date().toISOString();
  waiting.reportSha256 = createHash('sha256').update(await readFile(`${directory}/scala-large-resident.json`)).digest('hex');
  await save();
  await step('typescript', 'npx', ['tsc', '--noEmit']);
  await step('unit-tests', 'npx', ['vitest', 'run', '--reporter=json', `--outputFile=${directory}/unit-verification.json`]);
  await step('build-harness', 'node', [`${directory}/build.mjs`]);
  await archive('browser-cancellation-probe.json');
  await step('gpu-cancellation-probe', 'node', [`${directory}/check-pipeline.mjs`, 'http://localhost:3000/efa-qualification/compute/index.html?pipeline=true&fixture=normal&backend=gpu-resident&probeCancellation=1', `${directory}/browser-cancellation-probe.json`], async () => {
    const report = await pipelineReport('browser-cancellation-probe.json', 'normal', 'gpu-resident', 1000, true);
    insist(report.cancellation?.passed && report.workerSnapshotsServed === 1, 'The browser cancellation or source-snapshot check failed');
  });
  await archive('browser-resident-pipeline.json');
  await step('gpu-reference-models', 'node', [`${directory}/check-pipeline.mjs`, 'http://localhost:3000/efa-qualification/compute/index.html?pipeline=true&backend=gpu-resident', `${directory}/browser-resident-pipeline.json`], async () => insist((await json('browser-resident-pipeline.json')).status === 'passed', 'GPU R references failed'));
  await archive('scala-resident-pipeline.json');
  await step('native-reference-models', 'node', [`${directory}/check-scala-pipeline.mjs`, `${directory}/scala-resident-pipeline.json`], async () => insist((await json('scala-resident-pipeline.json')).status === 'passed', 'Native R references failed'));
  await step('gpu-full-size', 'node', [`${directory}/check-pipeline.mjs`, 'http://localhost:3000/efa-qualification/compute/index.html?pipeline=true&fixture=large&backend=gpu-resident&block=128&budgetMiB=1536&probeCancellation=1', `${directory}/browser-large-gpu-resident.json`], async () => {
    const report = await pipelineReport('browser-large-gpu-resident.json', 'large', 'gpu-resident', 20000);
    insist(report.cancellation?.passed, 'Full-size GPU cancellation failed');
  });
  await step('compare-full-size', 'node', [`${directory}/compare-results.mjs`], async () => {
    const report = await json('comparison.json');
    insist(report.largeComparison.some(row => row.candidate === 'browser-large-gpu-resident.json' && row.passed), 'Full-size backend numerical agreement failed; inspect comparison.json before further experiments');
  });
  state.status = 'completed-through-full-size-comparison';
  state.remaining = ['Saved holdout refits', 'Original CPU baseline, subject to the pending runtime preference', 'Final inspector browser, lint, build, and evidence audit'];
} catch (error) { state.status = 'failed'; state.error = String(error); process.exitCode = 1; }
state.finishedAt = new Date().toISOString(); await save();
console.log(JSON.stringify({ status: state.status, error: state.error, remaining: state.remaining }));
