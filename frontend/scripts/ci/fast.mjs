import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const frontend = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const output = resolve(process.env.CI_ARTIFACT_DIR ?? join(frontend, '.ci-artifacts'), 'fast');
mkdirSync(output, { recursive: true });
const commands = [
  ['unit-component-worker', ['node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=2', '--reporter=default', '--reporter=json', `--outputFile=${join(output, 'vitest.json')}`]],
  ['current-source-and-ci-contracts', ['--test', 'scripts/efa-reference/formal/source-contract.check.mjs', 'scripts/ci/contracts.check.mjs', 'scripts/generate-app-reference.check.mjs']],
  ['typescript', ['node_modules/typescript/bin/tsc', '--noEmit', '--incremental', 'false']],
];
const results = [];
for (const [name, args] of commands) {
  const start = performance.now();
  const child = spawnSync(process.execPath, args, { cwd: frontend, stdio: 'inherit', timeout: 300000, env: { ...process.env, EFA_LARGE_PARITY: '0', EFA_BENCHMARK: '0' } });
  const result = { name, status: child.status === 0 && !child.error ? 'passed' : 'failed', exitCode: child.status, error: child.error ? String(child.error) : null, milliseconds: performance.now() - start };
  results.push(result);
}
const summary = { runtime: process.version, status: results.every(r => r.status === 'passed') ? 'passed' : 'failed', scope: 'Current numerical/unit, real Node worker, happy-dom component, source-contract mutation tests and type checking. No retained solver receipt is treated as a fresh proof; browser geometry is not measured.', results };
writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
if (summary.status !== 'passed') process.exitCode = 1;
