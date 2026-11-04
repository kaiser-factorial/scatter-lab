// Serial qualification of the measured configurations. The original full-size
// JavaScript/CPU baseline remains skipped; small R reference fits still run.
import { readFile, writeFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

const root = 'scripts/efa-reference/compute';
const statusFile = `${root}/portable-final-sequence-v2.json`;
const report = {
  startedAt: new Date().toISOString(), status: 'running', stages: [],
  selected: { projectionTileRows: 32, nativeSource: 'TraceServerBlocked.scala', requestedBlasThreads: 4 },
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
const browser = (fixture, output, archive) => run(`Default-browser GPU: ${fixture ?? 'five R references'}`, [
  `${root}/check-pipeline.mjs`,
  `http://localhost:3000/efa-qualification/compute/index.html?pipeline=1&backend=gpu-portable-reduced&block=128&budgetMiB=1536${fixture ? `&fixture=${fixture}&probeCancellation=1` : ''}`,
  output, ...(archive ? [`--worker-archive=${archive}`] : []),
], output);
const native = (fixture, output, archive) => run(`Native blocked layout: ${fixture ?? 'five R references'}`, [
  `${root}/run-monitored.mjs`, output.replace(/\.json$/, ''), process.execPath, `${root}/check-scala-pipeline.mjs`, output,
  '--block=128', '--budget-mib=1536', `--source=${root}/TraceServerBlocked.scala`, '--class=TraceServerBlocked', '--threads=4',
  ...(fixture ? [`--fixture=${fixture}`] : []), ...(archive ? [`--pipeline-archive=${archive}`] : []),
], output);
const compare = (baseline, candidate, qualification, output) => run('Full-output comparison', [
  `${root}/compare-candidate.mjs`, `${root}/${baseline}.json`, candidate, qualification, output,
], output);
try {
  for (const name of ['portable-measurement-sequence-v1.json', 'blocked-measurement-sequence-v1.json']) {
    if (JSON.parse(await readFile(`${root}/${name}`, 'utf8')).status !== 'measurements-complete') throw new Error('Earlier measurements are still active');
  }
  await build({ entryPoints: [`${root}/pipeline.worker.mjs`], bundle: true, format: 'esm', outfile: 'public/efa-qualification/compute/pipeline-worker.js' });
  const gpuQualification = `${root}/browser-portable-final-qualified-v2.json`;
  const nativeQualification = `${root}/scala-blocked-final-qualified-v2.json`;
  await browser(undefined, gpuQualification);
  await native(undefined, nativeQualification);
  const gpuArchive = JSON.parse(await readFile(gpuQualification, 'utf8')).workerArchive;
  const nativeArchive = JSON.parse(await readFile(nativeQualification, 'utf8')).sourceArchives.pipeline;
  for (const fixture of ['large', 'large-holdout']) {
    const baseline = fixture === 'large' ? 'scala-large-resident' : 'scala-holdout-resident';
    const gpuOutput = `${root}/browser-${fixture}-portable-optimized-v2.json`;
    await browser(fixture, gpuOutput, gpuArchive);
    await compare(baseline, gpuOutput, gpuQualification, `${root}/portable-${fixture}-optimized-comparison-v2.json`);
    const nativeOutput = `${root}/scala-${fixture}-blocked-optimized-v2.json`;
    await native(fixture, nativeOutput, nativeArchive);
    await compare(baseline, nativeOutput, nativeQualification, `${root}/native-${fixture}-optimized-comparison-v2.json`);
  }
  report.status = 'qualified'; report.completedAt = new Date().toISOString(); await save();
} catch (error) {
  report.status = 'failed'; report.error = String(error); await save(); process.exitCode = 1;
}
