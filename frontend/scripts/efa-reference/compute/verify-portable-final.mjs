// Run application checks only after serial numerical qualification finishes.
import { readFile, writeFile, mkdtemp, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const root = resolve('scripts/efa-reference/compute');
const statusFile = `${root}/portable-regression-v2.json`;
const report = { status: 'waiting-for-numerical-qualification', startedAt: new Date().toISOString(), checks: [] };
await writeFile(statusFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
const save = () => writeFile(statusFile, JSON.stringify(report, null, 2) + '\n');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function run(name, command, args, { cwd = process.cwd(), expected = [0] } = {}) {
  const log = `${root}/portable-${name}-v2.log`, file = await open(log, 'wx');
  const check = { name, command, args, cwd, log, status: 'running', startedAt: new Date().toISOString() };
  report.checks.push(check); await save();
  const code = await new Promise((resolveExit, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', file.fd, file.fd] });
    child.once('error', reject); child.once('exit', (code, signal) => resolveExit(code ?? signal));
  }).finally(() => file.close());
  Object.assign(check, { exitCode: code, status: expected.includes(code) ? 'passed' : 'failed', endedAt: new Date().toISOString(), logSha256: hash(await readFile(log)) }); await save();
  if (!expected.includes(code)) throw new Error(`${name} failed (${code}); see ${log}`);
}
try {
  for (;;) {
    let sequence;
    try { sequence = JSON.parse(await readFile(`${root}/portable-final-sequence-v2.json`, 'utf8')); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    if (sequence?.status === 'failed') throw new Error('Numerical qualification failed; application checks not substituted');
    if (sequence?.status === 'qualified') break;
    await new Promise(resolveWait => setTimeout(resolveWait, 5000));
  }
  report.status = 'running'; await save();
  const units = `${root}/portable-unit-verification-v2.json`;
  await run('units', process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--reporter=json', `--outputFile=${units}`]);
  const unitReport = JSON.parse(await readFile(units, 'utf8'));
  report.units = { passed: unitReport.numPassedTests, failed: unitReport.numFailedTests, skipped: unitReport.numPendingTests, reportSha256: hash(await readFile(units)) };
  await run('typescript', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--incremental', 'false']);
  const lintFile = `${root}/portable-eslint-v2.json`;
  await run('eslint', process.execPath, ['node_modules/eslint/bin/eslint.js', '.', '--format', 'json', '--output-file', lintFile], { expected: [0, 1] });
  const baselineBytes = await readFile('/tmp/scatter-compute-lint-final.json'), currentBytes = await readFile(lintFile);
  if (hash(baselineBytes) !== '97d57c4e89edd3808dd202ca0a681330b7e0065a4aa700e6f934fbd0bf34bf5b') throw new Error('Lint baseline hash mismatch');
  const count = bytes => {
    const entries = JSON.parse(bytes), groups = new Map(); let errors = 0, warnings = 0;
    for (const file of entries) for (const message of file.messages) {
      const key = JSON.stringify([file.filePath, message.ruleId, message.severity]);
      groups.set(key, (groups.get(key) ?? 0) + 1);
      if (message.severity === 2) errors++; else if (message.severity === 1) warnings++;
    }
    return { groups, errors, warnings };
  };
  const before = count(baselineBytes), after = count(currentBytes), increased = [...after.groups].filter(([key, value]) => value > (before.groups.get(key) ?? 0));
  report.lint = { baselineSha256: hash(baselineBytes), currentSha256: hash(currentBytes), errors: after.errors, warnings: after.warnings, increased, status: increased.length ? 'failed' : 'passed' }; await save();
  if (increased.length) throw new Error('Lint regression detected');
  const buildDirectory = await mkdtemp('/tmp/scatter-portable-build-');
  report.buildDirectory = buildDirectory;
  report.buildExclusions = ['node_modules (copied separately)', '.next', 'public/efa-qualification', '.env*', '*.tsbuildinfo'];
  await run('copy-build-source', 'rsync', ['-a', '--exclude=node_modules', '--exclude=.next', '--exclude=public/efa-qualification', '--exclude=.env*', '--exclude=*.tsbuildinfo', './', `${buildDirectory}/`]);
  await run('copy-build-dependencies', 'cp', [process.platform === 'darwin' ? '-cR' : '-R', 'node_modules', `${buildDirectory}/node_modules`]);
  await run('production-build', 'npm', ['run', 'build'], { cwd: buildDirectory });
  await run('dev-readiness', `${process.env.HOME}/.local/bin/dev`, ['start', 'frontend', '--detach', '--json', '--yes']);
  const artifacts = `${root}/portable-ui-v2`;
  await run('weighted-ui', process.execPath, ['scripts/efa-reference/check-weighted-ui.mjs', 'http://localhost:3000', artifacts]);
  await run('inspector-ui', process.execPath, ['scripts/efa-reference/check-inspector-ui.mjs', 'http://localhost:3000', artifacts]);
  report.status = 'passed'; report.completedAt = new Date().toISOString(); await save();
} catch (error) {
  report.status = 'failed'; report.error = String(error); await save(); process.exitCode = 1;
}
