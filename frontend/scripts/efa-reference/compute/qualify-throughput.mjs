// Serial qualification of the measured configurations. The original full-size
// JavaScript/CPU baseline remains skipped; small R reference fits still run.
import { readFile, writeFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const root = 'scripts/efa-reference/compute';
const statusFile = `${root}/throughput-sequence-v3.json`;
const report = {
  startedAt: new Date().toISOString(), status: 'running', stages: [],
  selected: { projectionTileRows: 32, nativeSource: 'TraceServerPanel.scala', requestedBlasThreads: 4, nativeBlockRows: 256, gpuDotChunk: 1024, rotationWorkers: 4 },
  selectionScope: 'Measured candidates on this M1; close native rankings are not a cross-device claim',
  originalJavaScriptFullSizeBaseline: 'skipped-by-user',
};
await writeFile(statusFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
const save = () => writeFile(statusFile, JSON.stringify(report, null, 2) + '\n');
const fresh = async path => {
  try { await access(path); throw new Error(`Preserve existing evidence: ${path}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
};
const run = async (name, args, output) => {
  if (output) await fresh(output);
  const stage = { name, args, status: 'running', startedAt: new Date().toISOString() };
  report.stages.push(stage); await save();
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? `signal:${signal}`));
  });
  Object.assign(stage, { exitCode, status: exitCode === 0 ? 'completed' : 'failed', endedAt: new Date().toISOString() }); await save();
  if (exitCode !== 0) throw new Error(`${name} failed (${exitCode})`);
};
const browser = (fixture, output, archive, derivativeArchive) => run(`Default-browser GPU: ${fixture ?? 'five R references'}`, [
  `${root}/check-pipeline.mjs`,
  `http://localhost:3000/efa-qualification/compute/index.html?pipeline=1&backend=gpu-portable-reduced&block=128&budgetMiB=1536${fixture ? `&fixture=${fixture}&probeCancellation=1` : ''}`,
  output, ...(archive ? [`--worker-archive=${archive}`, `--rotation-worker-archive=${derivativeArchive}`] : []),
], output);
const native = (fixture, output, archive, derivativeArchive, poolArchive) => run(`Native blocked layout: ${fixture ?? 'five R references'}`, [
  `${root}/run-monitored.mjs`, output.replace(/\.json$/, ''), process.execPath, `${root}/check-scala-pipeline.mjs`, output,
  '--block=256', '--budget-mib=1536', `--source=${root}/TraceServerPanel.scala`, '--class=TraceServerPanel', '--threads=4',
  ...(fixture ? [`--fixture=${fixture}`] : []), ...(archive ? [`--pipeline-archive=${archive}`, `--rotation-worker-archive=${derivativeArchive}`, `--rotation-pool-archive=${poolArchive}`] : []),
], output);
const compare = (baseline, candidate, qualification, output) => run('Full-output comparison', [
  `${root}/compare-candidate.mjs`, `${root}/${baseline}.json`, candidate, qualification, output,
], output);
try {
  if (JSON.parse(await readFile(`${root}/throughput-regression-v3.json`, 'utf8')).status !== 'passed') throw new Error('Application regressions must pass before isolated timings');
  const gpuQualification = `${root}/throughput-browser-r-v3c.json`, nativeQualification = `${root}/throughput-scala-r-v3.json`;
  const gpu = JSON.parse(await readFile(gpuQualification, 'utf8')), scala = JSON.parse(await readFile(nativeQualification, 'utf8'));
  if (gpu.status !== 'passed' || scala.status !== 'passed') throw new Error('R qualification missing');
  for (const fixture of ['large', 'large-holdout']) {
    const baseline = fixture === 'large' ? 'scala-large-blocked-optimized-v2' : 'scala-large-holdout-blocked-optimized-v2';
    const output = `${root}/throughput-browser-${fixture}-v3.json`;
    await browser(fixture, output, gpu.workerArchive, gpu.rotationWorkerArchive);
    await compare(baseline, output, gpuQualification, `${root}/throughput-browser-${fixture}-comparison-v3.json`);
  }
  for (const fixture of ['large', 'large-holdout']) {
    const baseline = fixture === 'large' ? 'scala-large-blocked-optimized-v2' : 'scala-large-holdout-blocked-optimized-v2';
    const output = `${root}/throughput-scala-${fixture}-v3.json`;
    await native(fixture, output, scala.sourceArchives.pipeline, scala.sourceArchives.rotationWorker, scala.sourceArchives.rotationPool);
    await compare(baseline, output, nativeQualification, `${root}/throughput-scala-${fixture}-comparison-v3.json`);
  }
  report.status = 'qualified'; report.completedAt = new Date().toISOString(); await save();
} catch (error) {
  report.status = 'failed'; report.error = String(error); await save(); process.exitCode = 1;
}
