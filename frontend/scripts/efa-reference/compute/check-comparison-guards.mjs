// Exercise rejection paths using copies of retained public reference reports.
// These mutations are verification inputs, never numerical reference evidence.
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const exec = promisify(execFile), root = 'scripts/efa-reference/compute';
const files = ['browser-resident-qualified.json', 'scala-resident-pipeline.json'];
const originals = await Promise.all(files.map(async file => {
  const bytes = await readFile(`${root}/${file}`);
  return { file, sha256: createHash('sha256').update(bytes).digest('hex'), report: JSON.parse(bytes) };
}));
const cases = [
  { name: 'valid reference outputs', expected: null },
  { name: 'identically truncated scores', mutate: fit => { fit.rotations.oblimin.scores.values = []; }, expected: 'Missing complete score vectors' },
  { name: 'identically invalid score masks', mutate: fit => { fit.rotations.oblimin.scores.completeMask[0] = 2; }, expected: 'Invalid complete-response score membership' },
  { name: 'identically negative standard errors', mutate: fit => { fit.rotations.oblimin.standardErrors.pattern[0][0] = -0.1; }, expected: 'Negative oblimin standard error' },
  { name: 'identically missing rotation matrix', mutate: fit => { fit.rotations.varimax.phi = []; }, expected: 'Incomplete varimax rotation' },
  { name: 'identically failed extraction convergence', mutate: fit => { fit.extractionConvergence = { converged: false, iterations: 2000, objective: 1, gradient: 1 }; }, expected: 'Invalid extraction convergence' },
  { name: 'identically impossible p-values', mutate: fit => { fit.test.pValue = 2; }, expected: 'Invalid robust inference outputs' },
  { name: 'nonidentical prepared input fingerprints', mismatch: true, expected: 'Missing or nonidentical prepared inputs' },
  { name: 'small fit relabeled as full-size evidence', smallAsLarge: true, expected: 'Incorrect workload dimensions' },
];
const results = [];
for (const scenario of cases) {
  const directory = await mkdtemp('/tmp/scatter-comparison-guard-');
  try {
    for (const original of originals) {
      const report = structuredClone(original.report);
      if (scenario.mutate) for (const fit of report.results) if (fit.fixture === 'normal') scenario.mutate(fit);
      if (scenario.mismatch && original.file.startsWith('browser')) report.results[0].inputSha256 = 'incorrect-prepared-input';
      await writeFile(`${directory}/${original.file}`, JSON.stringify(report));
      if (scenario.smallAsLarge && original.file.startsWith('scala')) {
        const fit = report.results.find(value => value.fixture === 'normal' && value.backend === 'scala-resident');
        fit.fixture = 'large';
        await writeFile(`${directory}/scala-large-resident.json`, JSON.stringify({ ...report, results: [fit] }));
      }
    }
    let rejection;
    try { await exec(process.execPath, [`${root}/compare-results.mjs`, `--reports=${directory}`], { maxBuffer: 1024 ** 2 }); }
    catch (error) { rejection = String(error.stderr || error); }
    const passed = scenario.expected ? !!rejection?.includes(scenario.expected) : !rejection;
    if (!scenario.expected && passed) {
      const report = JSON.parse(await readFile(`${directory}/comparison.json`, 'utf8'));
      if (report.residentComparisons.length !== 5 || report.residentComparisons.some(value => value.passed !== true)) throw new Error('Control reports did not pass all five resident comparisons');
    }
    results.push({ name: scenario.name, expectedRejection: scenario.expected, passed, rejection });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const report = { recordedAt: new Date().toISOString(), status: results.every(result => result.passed) ? 'passed' : 'failed', sourceReports: originals.map(({ file, sha256 }) => ({ file, sha256 })), scope: 'Comparison verifier acceptance and rejection paths; altered inputs are temporary copies, not numerical reference results.', results };
await writeFile(process.argv[2] ?? `${root}/comparison-checks-verification.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, checks: results.length }));
if (report.status !== 'passed') process.exitCode = 1;
