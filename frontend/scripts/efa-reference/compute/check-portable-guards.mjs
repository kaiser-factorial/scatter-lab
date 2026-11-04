import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const root = 'scripts/efa-reference/compute', exec = promisify(execFile);
const baseline = process.argv[2] ?? `${root}/scala-full-bundle-reference.json`, source = process.argv[3] ?? `${root}/browser-portable-optimized-qualified-v1.json`;
const outputPath = process.argv[4] ?? `${root}/portable-guards-v1.json`;
const original = await readFile(source), parsed = JSON.parse(original);
const scenarios = [
  { name: 'ordinary-browser control', expected: null, change() {} },
  { name: 'hidden runtime developer flag', expected: 'Unqualified candidate provenance', change(report) { report.webgpuRuntimeFlags = ['--enable-webgpu-developer-features']; } },
  { name: 'explicit developer flag', expected: 'Unqualified candidate provenance', change(report) { report.browserArguments = ['--enable-webgpu-developer-features']; } },
  { name: 'strictMath metadata', expected: 'Unqualified candidate provenance', change(report) { report.results[0].kernelMetadata.strictMathRequested = true; } },
  { name: 'different executable worker', expected: 'Unqualified candidate provenance', change(report) { report.workerSha256 = 'different-source'; } },
  { name: 'truncated candidate scores', expected: 'Missing complete score vectors', change(report) { report.results[0].rotations.oblimin.scores.values = []; } },
];
if (parsed.results.some(fit => fit.rotationExecution)) scenarios.push(
  { name: 'different derivative worker', expected: 'Unqualified candidate provenance', change(report) { report.rotationWorkerSha256 = 'different-source'; } },
  { name: 'missing derivative executable', expected: 'Unqualified candidate provenance', change(report) { delete report.rotationWorkerSha256; } },
  { name: 'missing derivative execution records', expected: 'Unqualified candidate provenance', change(report) { report.results.forEach(fit => { delete fit.rotationExecution; }); } },
  { name: 'different rotation pool size', expected: 'Unqualified candidate provenance', change(report) { report.results[0].rotationExecution.concurrency = 1; } },
  { name: 'different trace chunk', expected: 'Unqualified candidate provenance', change(report) { report.results[0].kernelMetadata.dotChunkSize = 64; } },
  { name: 'unqualified panel path', expected: 'Unqualified candidate provenance', change(report) { report.results[0].kernelMetadata.materializePanels = true; } },
);
const results = [];
for (const scenario of scenarios) {
  const directory = await mkdtemp('/tmp/scatter-portable-guard-');
  try {
    const candidate = structuredClone(parsed); scenario.change(candidate);
    const path = `${directory}/candidate.json`, output = `${directory}/comparison.json`;
    await writeFile(path, JSON.stringify(candidate));
    let rejection;
    try { await exec(process.execPath, [`${root}/compare-candidate.mjs`, baseline, path, source, output], { maxBuffer: 1024 ** 2 }); }
    catch (error) { rejection = String(error.stderr || error); }
    let passed = scenario.expected ? !!rejection?.includes(scenario.expected) : !rejection;
    if (!scenario.expected && passed) passed = JSON.parse(await readFile(output, 'utf8')).status === 'passed';
    results.push({ name: scenario.name, passed, expected: scenario.expected, rejection });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const report = { recordedAt: new Date().toISOString(), status: results.every(value => value.passed) ? 'passed' : 'failed', source, sourceSha256: createHash('sha256').update(original).digest('hex'), results };
await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: report.status, checks: results.length }));
if (report.status !== 'passed') process.exitCode = 1;
