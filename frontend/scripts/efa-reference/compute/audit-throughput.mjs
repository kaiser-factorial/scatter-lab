import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { build } from 'esbuild';
import ts from 'typescript';
const root = 'scripts/efa-reference/compute', hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async name => JSON.parse(await readFile(`${root}/${name}.json`, 'utf8'));
const insist = (condition, message) => { if (!condition) throw new Error(message); };
const regression = await json('throughput-regression-v3'), sequence = await json('throughput-sequence-v3');
insist(regression.status === 'passed' && sequence.status === 'qualified', 'Incomplete regression or numerical qualification');
for (const name of ['throughput-guards-v3', 'throughput-comparison-guards-v3', 'throughput-kernels-v3', 'throughput-native256-paired-v3']) insist((await json(name)).status === 'passed', `${name} did not pass`);
const temporary = await mkdtemp('/tmp/scatter-throughput-audit-');
const browserReference = await json('throughput-browser-r-v3c'), nativeReference = await json('throughput-scala-r-v3');
const bundles = [
  ['pipeline.worker.mjs', 'browser', browserReference.workerSha256],
  ['pipeline.worker.mjs', 'node', nativeReference.pipelineSha256],
  ['rotation-worker.mjs', 'browser', browserReference.rotationWorkerSha256],
  ['rotation-node-worker.mjs', 'node', nativeReference.rotationWorkerSha256],
  ['rotation-pool.mjs', 'node', nativeReference.rotationPoolSha256],
];
const executableChecks = [];
for (const [entry, platform, expected] of bundles) {
  const outfile = `${temporary}/${platform}-${entry}`;
  await build({ entryPoints: [`${root}/${entry}`], bundle: true, format: 'esm', platform, outfile });
  const actual = hash(await readFile(outfile));
  insist(actual === expected, `${platform}/${entry} changed since qualification`);
  executableChecks.push({ entry, platform, sha256: actual });
}
// The post-run cleanup changes only indentation/comments. Compare emitted TS
// without comments to the exact source copy used by the passing build.
const production = ['weighted-rotation.ts', 'weighted-inference.ts', 'fit.ts', 'efa.worker.ts', 'service.ts', 'telemetry.ts', 'types.ts'];
const productionChecks = [];
for (const file of production) {
  const path = `src/lib/efa/${file}`, current = await readFile(path, 'utf8'), tested = await readFile(`${regression.buildDirectory}/${path}`, 'utf8');
  const emit = source => ts.transpileModule(source, { fileName: file, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020, removeComments: true } }).outputText;
  insist(emit(current) === emit(tested), `${file} differs from regression-tested implementation`);
  productionChecks.push({ path, sourceSha256: hash(current), emittedSha256: hash(emit(current)), matchesTestedBuild: true });
}
const benchmarks = [], archives = new Set(), evidence = [];
const retain = async name => { const path = `${root}/${name}.json`, bytes = await readFile(path); evidence.push({ path, sha256: hash(bytes) }); };
for (const name of ['throughput-regression-v3', 'throughput-sequence-v3', 'throughput-browser-r-v3c', 'throughput-scala-r-v3', 'throughput-guards-v3', 'throughput-comparison-guards-v3', 'throughput-kernels-v3', 'throughput-native128-paired-v3', 'throughput-native256-paired-v3']) await retain(name);
for (const backend of ['browser', 'scala']) for (const fixture of ['large', 'large-holdout']) {
  const name = `throughput-${backend}-${fixture}-v3`, report = await json(name), fit = report.results[0];
  const comparisonName = `throughput-${backend}-${fixture}-comparison-v3`, comparison = await json(comparisonName);
  insist(comparison.status === 'passed', `${comparisonName} failed`);
  const oldName = backend === 'browser' ? `browser-${fixture}-portable-optimized-v2` : `scala-${fixture}-blocked-optimized-v2`;
  const old = await json(oldName), previous = old.results[0];
  const phaseTotal = (f, suffix) => Object.entries(f.phaseTimings).filter(([name]) => name.endsWith(suffix)).reduce((sum, [, value]) => sum + value, 0);
  const memory = backend === 'browser' ? report.memory : await json(`${name}.memory`);
  const priorMemory = backend === 'browser' ? old.memory : await json(`${oldName}.memory`);
  benchmarks.push({ backend, fixture, dimensions: fit.dimensions,
    beforeMs: previous.totalMs, afterMs: fit.totalMs, observedRatio: previous.totalMs / fit.totalMs,
    traceBeforeMs: phaseTotal(previous, 'Exact robust trace blocks'), traceAfterMs: phaseTotal(fit, 'Exact robust trace blocks'),
    derivativeBeforeMs: phaseTotal(previous, 'Rotated standard errors'), derivativeAfterMs: phaseTotal(fit, 'Rotated standard errors'),
    peakRssBeforeBytes: priorMemory.peakBrowserProcessRssBytes ?? priorMemory.peakRssBytes,
    peakRssAfterBytes: memory.peakBrowserProcessRssBytes ?? memory.peakRssBytes,
    gpuOwnedBufferBytes: fit.kernelTimingsCumulative.peakOwnedGpuBufferBytes,
    versionBefore: old.browser ?? old.node, versionAfter: report.browser ?? report.node,
    heartbeat: report.heartbeat, cancellation: report.cancellation,
    comparison: comparison.comparisons[0], hardware: report.hardware,
  });
  for (const value of [report, backend === 'browser' ? browserReference : nativeReference]) {
    if (value.workerArchive) archives.add(value.workerArchive);
    if (value.rotationWorkerArchive) archives.add(value.rotationWorkerArchive);
    for (const archive of Object.values(value.sourceArchives ?? {})) archives.add(archive);
  }
  await retain(name); await retain(comparisonName);
}
const archiveChecks = [];
for (const path of archives) {
  const actual = hash(gunzipSync(await readFile(path))), expected = path.match(/([a-f0-9]{64})\.(?:js|mjs|scala)\.gz$/)?.[1];
  insist(actual === expected, `Archive mismatch: ${path}`); archiveChecks.push({ path, sha256: actual });
}
const sources = [...production.map(file => `src/lib/efa/${file}`), ...[
  'TraceServerPanel.scala', 'webgpu-kernel.mjs', 'split-shader.mjs', 'portable-shader.mjs', 'panel-shader.mjs', 'rotation-pool.mjs', 'rotation-worker.mjs', 'rotation-node-worker.mjs', 'pipeline.worker.mjs', 'check-pipeline.mjs', 'check-scala-pipeline.mjs', 'compare-candidate.mjs', 'qualify-throughput.mjs', 'audit-throughput.mjs',
].map(file => `${root}/${file}`)];
const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async path => [path, hash(await readFile(path))])));
const result = { status: 'qualified-and-regression-passed', recordedAt: new Date().toISOString(), checkpoint: 'd8bf5db', engine: 'scatter-efa/6', executableChecks, productionChecks, archiveChecks, evidence, sourceHashes, benchmarks,
  limits: ['Single-machine retained before/after timings; Chrome changed between checkpoints. Not a controlled cross-device speed claim.', 'RSS is summed sampled process RSS, not total physical memory. Do not add it to GPU-owned buffer accounting.', 'WebGPU cancellation measures the worker termination call, not GPU command retirement.', 'Accelerated kernels remain qualification backends; the app now parallelizes rotation derivatives.', 'Original full JavaScript CPU baseline skipped by user. Public/synthetic inputs only.'],
};
await writeFile(`${root}/throughput-completion-audit-v3.json`, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: result.status, executableChecks: executableChecks.length, productionChecks: productionChecks.length, archives: archiveChecks.length, benchmarks: benchmarks.map(({ backend, fixture, beforeMs, afterMs }) => ({ backend, fixture, beforeMinutes: beforeMs / 60000, afterMinutes: afterMs / 60000 })) }));
