// Continue serial measurements after the already-running immutable GPU fit.
// This coordinator never launches the skipped original full JS/CPU baseline.
import { readFile, writeFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const root = 'scripts/efa-reference/compute', statusFile = `${root}/portable-measurement-sequence-v1.json`;
try { await access(statusFile); throw new Error('Preserve the existing sequence report; use a new explicit version'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const report = { startedAt: new Date().toISOString(), status: 'running', stages: [], originalJavaScriptFullSizeBaseline: 'skipped-by-user' };
const save = () => writeFile(statusFile, JSON.stringify(report, null, 2) + '\n');
const run = async (name, args) => {
  const stage = { name, args, status: 'running', startedAt: new Date().toISOString() }; report.stages.push(stage); await save();
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? `signal:${signal}`));
  });
  Object.assign(stage, { exitCode, status: exitCode === 0 ? 'completed' : 'failed', endedAt: new Date().toISOString() }); await save();
  if (exitCode !== 0) throw new Error(`${name} failed (${exitCode})`);
};
await save();
try {
  const observation = { name: 'Observe immutable no-flags GPU full fit', status: 'waiting', startedAt: new Date().toISOString() }; report.stages.push(observation); await save();
  for (;;) {
    let full;
    try { full = JSON.parse(await readFile(`${root}/browser-large-gpu-portable-v1.json`, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (full) {
      if (full.status !== 'completed-unqualified') throw new Error(`No-flags GPU fit did not finish: ${full.status}`);
      Object.assign(observation, { status: 'completed', endedAt: new Date().toISOString() }); await save(); break;
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  await run('Full no-flags numerical comparison', [`${root}/compare-candidate.mjs`, `${root}/scala-large-resident.json`, `${root}/browser-large-gpu-portable-v1.json`, `${root}/browser-portable-qualified-v1.json`, `${root}/portable-full-comparison-v1.json`]);
  for (const threads of [1, 4]) await run(`Pair-major native blocks: ${threads} requested threads`, [
    `${root}/run-monitored.mjs`, `${root}/native-pair-major-${threads}-v1`, process.execPath, `${root}/check-native-resident.mjs`, `${root}/native-pair-major-${threads}-v1.json`,
    `--source=${root}/TraceServerTiled.scala`, '--class=TraceServerTiled', `--threads=${threads}`, '--repeats=5', `--reference=${root}/native-resident-reference.json`,
  ]);
  await run('Targeted TypeScript linear-algebra comparison', [`${root}/run-monitored.mjs`, `${root}/linalg-optimization-v1`, process.execPath, '--expose-gc', `${root}/benchmark-linalg.mjs`, `${root}/linalg-optimization-v1.json`]);
  report.status = 'measurements-complete'; report.completedAt = new Date().toISOString(); await save();
} catch (error) {
  report.status = 'failed'; report.error = String(error); await save(); process.exitCode = 1;
}
