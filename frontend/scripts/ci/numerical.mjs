import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyNumericalReport } from './contracts.mjs';
import { currentPackageBuild } from './package-build.mjs';
const frontend = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const output = resolve(process.env.CI_ARTIFACT_DIR ?? join(frontend, '.ci-artifacts'), 'numerical');
mkdirSync(output, { recursive: true });
const fresh = process.env.CONGRUENCE_FIXTURE_ROOT;
if (fresh && !process.env.STATISTICS_REFERENCE_ROOT) throw new Error('Fresh-reference mode requires STATISTICS_REFERENCE_ROOT as well as CONGRUENCE_FIXTURE_ROOT; do not silently reuse retained public references.');
currentPackageBuild();
const expected = [
  ['main', 'check.ts', 340, 3230],
  ['ordinal', 'check-ordinal.ts', 8, 344],
  ['extensions', 'check-extensions.ts', 22, 507],
  ['weighted-se', 'check-weighted-se.ts', 5, 158],
];
if (!fresh) {
  const integrity = spawnSync(process.execPath, ['scripts/ci/reference-integrity.mjs'], { cwd: frontend, stdio: 'inherit' });
  if (integrity.status !== 0) process.exit(integrity.status ?? 1);
}
const results = [];
for (const [name, entry, groups, checks] of expected) {
  const reportPath = join(output, `${name}.json`);
  for (const suffix of ['', '.inputs.json', '.drift.json']) rmSync(`${reportPath}${suffix}`, { force: true });
  const start = performance.now();
  const child = spawnSync(process.execPath, ['scripts/efa-reference/congruence/run.mjs'], {
    cwd: frontend, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CONGRUENCE_ENTRY: `scripts/efa-reference/congruence/${entry}`, CONGRUENCE_OUTPUT: reportPath,
      CONGRUENCE_CASES: '', CONGRUENCE_SKIP_ML: '0', CONGRUENCE_SKIP_PCA: '0' },
  });
  writeFileSync(join(output, `${name}.log`), `${child.stdout ?? ''}\n${child.stderr ?? ''}`);
  let result;
  try {
    if (child.error || child.status !== 0) throw new Error(`Numerical process failed (${child.status}): ${child.error ?? child.stderr}`);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    verifyNumericalReport(report, groups, checks);
    const receipt = JSON.parse(readFileSync(`${reportPath}.inputs.json`, 'utf8'));
    const drift = JSON.parse(readFileSync(`${reportPath}.drift.json`, 'utf8'));
    if (drift.changedAfterBundle.length) throw new Error('Sources changed during numerical execution');
    for (const [path, hash] of Object.entries(receipt.sourceHashes)) if (createHash('sha256').update(readFileSync(resolve(frontend, path))).digest('hex') !== hash) throw new Error(`Current source differs from executed bundle: ${path}`);
    result = { name, status: 'passed', groups, checks, milliseconds: performance.now() - start, report: reportPath };
  } catch (error) { result = { name, status: 'failed', error: String(error), milliseconds: performance.now() - start, report: reportPath }; }
  results.push(result); console.log(JSON.stringify(result));
}
const publicReport = join(output, 'public-package.json');
rmSync(publicReport, { force: true });
const publicStart = performance.now();
const publicChild = spawnSync(process.execPath, ['../packages/statistics/test/canonical.check.mjs'], {
  cwd: frontend, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024,
  env: { ...process.env, STATISTICS_REFERENCE_OUTPUT: publicReport },
});
writeFileSync(join(output, 'public-package.log'), `${publicChild.stdout ?? ''}\n${publicChild.stderr ?? ''}`);
try {
  if (publicChild.error || publicChild.status !== 0) throw new Error(`Public package reference process failed (${publicChild.status}): ${publicChild.error ?? publicChild.stderr}`);
  const report = JSON.parse(readFileSync(publicReport, 'utf8'));
  if (report.status !== 'passed' || report.groups !== 73 || report.scalarChecks !== 23969 || report.results.length !== 73) throw new Error('Public numerical reference coverage or comparison failed');
  results.push({ name: 'public-package', status: 'passed', groups: 73, checks: 23969, milliseconds: performance.now() - publicStart, report: publicReport });
} catch (error) { results.push({ name: 'public-package', status: 'failed', error: String(error), milliseconds: performance.now() - publicStart, report: publicReport }); }
const summary = { status: results.every(r => r.status === 'passed') ? 'passed' : 'failed', runtime: process.version, fixtureMode: fresh ? 'newly generated R references' : 'retained independently generated R fixtures', fixtureRoot: fresh ?? 'src/lib/__tests__/fixtures plus packages/statistics/test/fixtures', groups: 448, checks: 28208, applicationMetricChecks: 4239, publicScalarComparisons: 23969, coverageUnits: 'Application checks are scalar error metrics, often aggregated over matrices; public comparisons count individual values. These denominators are not independent statistical trials.', applicationKernelGroups: 375, publicPackageGroups: 73, scope: 'Finite explicit-contract numerical comparisons, not universal psych/lavaan/stats default equivalence; public KS p-values use a separately matched Stephens formula and record deviations from R exact/asymptotic tests. See docs/EFA-CONGRUENCE.md and packages/statistics/VALIDATION.md.', results };
writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
if (summary.status !== 'passed') process.exitCode = 1;
