// Run application checks only after serial numerical qualification finishes.
import { readFile, writeFile, mkdtemp, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const root = resolve('scripts/efa-reference/compute');
const statusFile = `${root}/throughput-regression-v3.json`;
const report = { status: 'waiting-for-numerical-qualification', startedAt: new Date().toISOString(), checks: [] };
await writeFile(statusFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
const save = () => writeFile(statusFile, JSON.stringify(report, null, 2) + '\n');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function run(name, command, args, { cwd = process.cwd(), expected = [0] } = {}) {
  const log = `${root}/throughput-${name}-v3.log`, file = await open(log, 'wx');
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
  for (const name of ['throughput-browser-r-v3c.json', 'throughput-scala-r-v3.json']) {
    if (JSON.parse(await readFile(`${root}/${name}`, 'utf8')).status !== 'passed') throw new Error(`${name} is not qualified`);
  }
  report.status = 'running'; await save();
  const units = `${root}/throughput-unit-v3b.json`;
  const unitReport = JSON.parse(await readFile(units, 'utf8'));
  if (unitReport.numFailedTests || !unitReport.numPassedTests) throw new Error('Unit tests did not pass');
  report.unitCommand = 'npx vitest run --maxWorkers=2 --reporter=json --outputFile=scripts/efa-reference/compute/throughput-unit-v3b.json';
  report.units = { passed: unitReport.numPassedTests, failed: unitReport.numFailedTests, skipped: unitReport.numPendingTests, reportSha256: hash(await readFile(units)) };
  await run('typescript', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--incremental', 'false']);
  const lintFile = `${root}/throughput-eslint-v3b.json`;
  const baselineBytes = await readFile(`${root}/portable-eslint-v2.json`), currentBytes = await readFile(lintFile);
  if (hash(baselineBytes) !== '2a7a06d5cfcc13fd35febf21e207531aa168797a6376c0a837176eeed9903016') throw new Error('Lint baseline hash mismatch');
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
  const buildDirectory = await mkdtemp('/tmp/scatter-throughput-build-');
  report.buildDirectory = buildDirectory;
  report.buildExclusions = ['node_modules (copied separately)', '.next', 'public/efa-qualification', '.env*', '*.tsbuildinfo'];
  await run('copy-build-source', 'rsync', ['-a', '--exclude=node_modules', '--exclude=.next', '--exclude=public/efa-qualification', '--exclude=.env*', '--exclude=*.tsbuildinfo', './', `${buildDirectory}/`]);
  await run('copy-build-dependencies', 'cp', [process.platform === 'darwin' ? '-cR' : '-R', 'node_modules', `${buildDirectory}/node_modules`]);
  await run('production-build', 'npm', ['run', 'build'], { cwd: buildDirectory });
  await run('dev-readiness', `${process.env.HOME}/.local/bin/dev`, ['start', 'frontend', '--detach', '--json', '--yes']);
  const artifacts = `${root}/throughput-ui-v3`;
  await run('weighted-ui', process.execPath, ['scripts/efa-reference/check-weighted-ui.mjs', 'http://localhost:3000', artifacts]);
  await run('inspector-ui', process.execPath, ['scripts/efa-reference/check-inspector-ui.mjs', 'http://localhost:3000', artifacts]);
  report.status = 'passed'; report.completedAt = new Date().toISOString(); await save();
} catch (error) {
  report.status = 'failed'; report.error = String(error); await save(); process.exitCode = 1;
}
