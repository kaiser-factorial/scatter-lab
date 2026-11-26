import { createFitComparator } from './fit-comparison.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { build } from 'esbuild';
await build({ entryPoints: ['src/lib/efa/compare.ts'], bundle: true, format: 'esm', platform: 'node', outfile: '/tmp/scatter-compare-factors.mjs' });
const { matchFactors } = await import('/tmp/scatter-compare-factors.mjs');
const { maximumError, validateFit, compareFit } = createFitComparator(matchFactors);
const root = resolve(process.argv.find(arg => arg.startsWith('--reports='))?.slice('--reports='.length) ?? 'scripts/efa-reference/compute') + '/';
const records = {};
for (const filename of ['browser-kernels.json', 'scala-kernels.json', 'browser-pipeline.json', 'scala-pipeline.json', 'browser-resident-pipeline.json', 'browser-resident-qualified.json', 'browser-strict-qualified.json', 'scala-resident-pipeline.json', 'scala-full-bundle-reference.json', 'scala-optimized-qualified.json', 'scala-large-resident.json', 'browser-large-cpu.json', 'browser-large-gpu-resident.json', 'browser-large-gpu-strict-reduced.json', 'scala-holdout-resident.json', 'browser-holdout-gpu-resident.json', 'browser-holdout-gpu-strict-reduced.json']) {
  try {
    const bytes = await readFile(root + filename);
    records[filename] = { sha256: createHash('sha256').update(bytes).digest('hex'), report: JSON.parse(bytes) };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const auxiliary = {};
for (const filename of ['scala-large-resident.suspension.json', 'scala-large-resident.memory.json', 'scala-holdout-resident.memory.json', 'native-large-bytecode-snapshot.json']) {
  try { auxiliary[filename] = JSON.parse(await readFile(root + filename, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const median = a => { const s = a.slice().sort((a,b) => a-b); return s.length % 2 ? s[(s.length-1)/2] : (s[s.length/2-1]+s[s.length/2])/2; };
const kernelGroups = new Map();
for (const [file, { report }] of Object.entries(records)) {
  if (!file.includes('kernels')) continue;
  for (const r of report.results) {
    const times = r.iterationMs ?? r.kernelMs;
    const group = kernelGroups.get(r.fixture) ?? [];
    // Early browser reports kept the generic backend="webgpu" in metadata.
    // Match their distinct, recorded precision signatures; never default a GPU
    // result to Float64 merely because its variant metadata key was absent.
    const legacyPrecision = { 'gpu-f32': 'f32/host-f64', 'gpu-compensated': 'f32-compensated/host-f64', 'gpu-split': 'split-f32/chunked-host-f64' }[r.backend];
    const metadata = report.metadata?.find(m => m.variant === r.backend || m.backend === r.backend)
      ?? report.metadata?.find(m => legacyPrecision && m.precision === legacyPrecision);
    const precision = r.precision ?? metadata?.precision ?? (r.backend === 'cpu' ? 'float64' : undefined);
    if (!precision) throw new Error(`Missing precision provenance for ${file}: ${r.backend}`);
    group.push({ file, backend: r.backend, precision, inputSha256: r.inputSha256,
      firstIterationMs: times[0], subsequentMedianMs: median(times.slice(1)), iterationsMs: times,
      timingScope: file === 'scala-kernels.json' ? 'Resident JVM numerical kernel; input decoding, process launch and IPC excluded' : 'Worker host call; GPU variants include packing, upload, readback and host reduction',
      processMs: r.processMs, errors: r.errors });
    kernelGroups.set(r.fixture, group);
  }
}
const kernels = [...kernelGroups].map(([fixture, candidates]) => {
  if (new Set(candidates.map(c => c.inputSha256)).size !== 1) throw new Error(`Nonidentical inputs: ${fixture}`);
  return { fixture, inputSha256: candidates[0].inputSha256, candidates };
});
const pipelines = Object.entries(records).filter(([file]) => !file.includes('kernels')).flatMap(([file, { report }]) =>
  report.results.map(r => ({ file, backend: r.backend, fixture: r.fixture, dimensions: r.dimensions, inputSha256: r.inputSha256 ?? null,
    status: r.executionStatus ?? 'completed', independentRPassed: r.passed, totalMs: r.totalMs, timings: r.timings, errors: r.errors,
    rotationErrors: Object.fromEntries(Object.entries(r.rotations ?? {}).map(([name, value]) => [name, value.errors ?? null])),
    kernelStartupMs: (r.kernelTimingsCumulative ?? r.gpuTimingsCumulative)?.startupMs,
    blockSize: r.plan?.blockSize, inferenceBudgetBytes: r.plan?.budgetBytes,
  })));
const largeInputs = pipelines.filter(p => p.fixture === 'large' && p.inputSha256);
if (new Set(largeInputs.map(p => p.inputSha256)).size > 1) throw new Error('Full-size inputs do not match');
const largeComparison = [];
const native = records['scala-large-resident.json']?.report.results.find(r => r.fixture === 'large');
const completeFit = fit => fit?.executionStatus === 'completed' && fit.test && ['oblimin', 'promax', 'varimax'].every(name => fit.rotations?.[name]?.standardErrors);
const completedWorkloads = [];
for (const file of ['scala-large-resident.json', 'browser-large-gpu-resident.json', 'browser-large-gpu-strict-reduced.json', 'scala-holdout-resident.json', 'browser-holdout-gpu-resident.json', 'browser-holdout-gpu-strict-reduced.json']) {
  const fixture = file.includes('holdout') ? 'large-holdout' : 'large';
  const fit = records[file]?.report.results.find(value => value.fixture === fixture);
  if (!completeFit(fit)) continue;
  validateFit(fit);
  const rows = fixture === 'large' ? 20000 : 6000;
  if (fit.dimensions.rows !== rows || fit.dimensions.items !== 500 || fit.dimensions.factors !== 5) throw new Error(`Incorrect workload dimensions: ${file}`);
  if (fixture === 'large-holdout') {
    const sample = fit.sample;
    if (!sample || sample.sourceRows !== 20000 || sample.development?.length !== 14000 || sample.holdout?.length !== 6000 || sample.afterFullExploration !== true) throw new Error(`Missing saved holdout membership or history: ${file}`);
    const all = [...sample.development, ...sample.holdout];
    if (new Set(all).size !== 20000 || all.some(row => !Number.isInteger(row) || row < 0 || row >= 20000)) throw new Error(`Invalid or overlapping split membership: ${file}`);
  }
  completedWorkloads.push({ file, fixture, dimensions: fit.dimensions, outputSchemaValidated: true, extractionConvergence: fit.extractionConvergence ?? null, convergenceEvidence: fit.extractionConvergence ? 'Recorded convergence diagnostics' : 'Legacy report omitted the metrics; archived DWLS extractor throws on optimizer nonconvergence', numericalAgreement: 'Reported separately; execution alone is not qualification' });
}
if (completeFit(native)) for (const file of ['browser-large-cpu.json', 'browser-large-gpu-resident.json', 'browser-large-gpu-strict-reduced.json']) {
  const candidate = records[file]?.report.results.find(r => r.fixture === 'large');
  if (!completeFit(candidate)) continue;
  if ([native, candidate].some(fit => fit.dimensions?.rows !== 20000 || fit.dimensions.items !== 500 || fit.dimensions.factors !== 5)) throw new Error('Full-size comparison has the wrong workload dimensions');
  largeComparison.push({ baseline: 'scala-large-resident.json', candidate: file, inputSha256: native.inputSha256, ...compareFit(native, candidate) });
}
const gpuReferenceFile = records['browser-resident-qualified.json'] ? 'browser-resident-qualified.json' : 'browser-resident-pipeline.json';
const nativeReferenceFile = records['scala-full-bundle-reference.json'] ? 'scala-full-bundle-reference.json' : 'scala-resident-pipeline.json';
const residentComparisons = (records[gpuReferenceFile]?.report.results ?? []).map(candidate => {
  const reference = records[nativeReferenceFile]?.report.results.find(r => r.fixture === candidate.fixture && r.backend === 'scala-resident');
  return reference ? { fixture: candidate.fixture, ...compareFit(reference, candidate) } : { fixture: candidate.fixture, passed: null };
});
const strictComparisons = (records['browser-strict-qualified.json']?.report.results ?? []).map(candidate => {
  const reference = records[nativeReferenceFile]?.report.results.find(r => r.fixture === candidate.fixture && r.backend === 'scala-resident');
  return reference ? { fixture: candidate.fixture, developerOnly: true, ...compareFit(reference, candidate) } : { fixture: candidate.fixture, passed: null };
});
const holdoutReference = records['scala-holdout-resident.json']?.report.results.find(r => r.fixture === 'large-holdout');
const holdoutCandidateFile = records['browser-holdout-gpu-strict-reduced.json'] ? 'browser-holdout-gpu-strict-reduced.json' : 'browser-holdout-gpu-resident.json';
const holdoutCandidate = records[holdoutCandidateFile]?.report.results.find(r => r.fixture === 'large-holdout');
const holdoutComparison = completeFit(holdoutReference) && completeFit(holdoutCandidate) ? {
  baseline: 'scala-holdout-resident.json', candidate: holdoutCandidateFile,
  developerOnly: records[holdoutCandidateFile].report.developerOnly === true,
  sameMembership: maximumError(holdoutReference.sample.holdout, holdoutCandidate.sample.holdout) === 0 && maximumError(holdoutReference.sample.development, holdoutCandidate.sample.development) === 0,
  ...compareFit(holdoutReference, holdoutCandidate),
} : null;
if (holdoutComparison && !holdoutComparison.sameMembership) holdoutComparison.passed = false;
const suspension = auxiliary['scala-large-resident.suspension.json'];
const suspendedMs = suspension?.resumedAt ? Date.parse(suspension.resumedAt) - Date.parse(suspension.requestedAt) : null;
if (suspendedMs !== null && (!Number.isFinite(suspendedMs) || suspendedMs < 0)) throw new Error('Invalid native suspension record');
const performanceRecords = ['browser-large-gpu-resident.json', 'browser-large-gpu-strict-reduced.json', 'scala-large-resident.json', 'browser-holdout-gpu-resident.json', 'browser-holdout-gpu-strict-reduced.json', 'scala-holdout-resident.json'].flatMap(file => {
  const report = records[file]?.report;
  if (!report) return [];
  return report.results.map(fit => ({
    file, backend: fit.backend, fixture: fit.fixture, status: report.status,
    hardware: report.hardware, browser: report.browser, node: report.node, developerOnly: report.developerOnly === true,
    totalMs: fit.totalMs, stageMs: fit.timings, kernel: fit.kernelTimingsCumulative, kernelMetadata: fit.kernelMetadata,
    memory: report.memory ?? auxiliary[file.replace('.json', '.memory.json')],
    heartbeat: report.heartbeat, cancellation: report.cancellation,
    ...(file === 'scala-large-resident.json' ? {
      interruption: suspension ?? null,
      activeElapsedEstimateMs: suspendedMs === null ? null : fit.totalMs - suspendedMs,
      activeRobustInferenceEstimateMs: suspendedMs === null ? null : fit.timings.robustInference - suspendedMs,
      timingCaveat: 'The saved wall times include a user-requested suspension during robust inference. Active estimates subtract its recorded duration, not scheduler or resume overhead. In-flight kernel timings may include that pause and are not corrected.',
    } : {}),
  }));
});
const nativeFullReport = records['scala-large-resident.json']?.report;
const nativeReferenceReport = records[nativeReferenceFile]?.report;
const gpuFullReport = records['browser-large-gpu-resident.json']?.report;
const gpuReferenceReport = records[gpuReferenceFile]?.report;
const referencesPassed = report => ['normal', 'pairwise', 'complete', 'skew', 'heavy-tail'].every(name => report?.results.some(fit => fit.fixture === name && fit.backend !== 'cpu' && fit.passed === true));
const sameMap = (a, b) => !!a && !!b && JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
const capturedBytecode = auxiliary['native-large-bytecode-snapshot.json']?.files.filter(file => file.path.endsWith('.class'));
const sourceQualification = {
  native: { referenceFile: nativeReferenceFile, independentReferencesPassed: referencesPassed(nativeReferenceReport), samePipelineBundle: !!nativeFullReport?.pipelineSha256 && nativeFullReport.pipelineSha256 === nativeReferenceReport?.pipelineSha256, sameScalaSource: !!nativeFullReport?.scalaSourceSha256 && nativeFullReport.scalaSourceSha256 === nativeReferenceReport?.scalaSourceSha256, sameProtocolBundle: !!nativeFullReport?.protocolSha256 && nativeFullReport.protocolSha256 === nativeReferenceReport?.protocolSha256, sameCapturedBytecode: capturedBytecode?.length > 0 && sameMap(Object.fromEntries(capturedBytecode.map(file => [file.path.split('/').at(-1), file.sha256])), nativeReferenceReport?.nativeBytecode) },
  webgpu: { referenceFile: gpuReferenceFile, independentReferencesPassed: referencesPassed(gpuReferenceReport), sameWorkerBundle: !!gpuFullReport?.workerSha256 && gpuFullReport.workerSha256 === gpuReferenceReport?.workerSha256 },
};
for (const [key, fullFile, referenceFile] of [
  ['webgpuStrict', 'browser-large-gpu-strict-reduced.json', 'browser-strict-qualified.json'],
  ['webgpuHoldout', holdoutCandidateFile, holdoutCandidateFile.includes('strict') ? 'browser-strict-qualified.json' : gpuReferenceFile],
  ['nativeHoldout', 'scala-holdout-resident.json', records['scala-optimized-qualified.json'] ? 'scala-optimized-qualified.json' : nativeReferenceFile],
]) {
  const full = records[fullFile]?.report, reference = records[referenceFile]?.report;
  if (!full) continue;
  const native = key === 'nativeHoldout';
  sourceQualification[key] = { referenceFile, independentReferencesPassed: referencesPassed(reference), developerOnly: full.developerOnly === true,
    ...(native ? { samePipelineBundle: !!full.pipelineSha256 && full.pipelineSha256 === reference?.pipelineSha256, sameScalaSource: !!full.scalaSourceSha256 && full.scalaSourceSha256 === reference?.scalaSourceSha256, sameProtocolBundle: !!full.protocolSha256 && full.protocolSha256 === reference?.protocolSha256, sameNativeBytecode: sameMap(full.nativeBytecode, reference?.nativeBytecode), sameNativeOptions: JSON.stringify(full.nativeArguments) === JSON.stringify(reference?.nativeArguments), sameBlasThreadRequest: full.results[0]?.kernelMetadata?.requestedBlasThreads === reference?.results.find(fit => fit.backend === 'scala-resident')?.kernelMetadata?.requestedBlasThreads }
      : { sameWorkerBundle: !!full.workerSha256 && full.workerSha256 === reference?.workerSha256 }),
  };
}
const comparisons = [...residentComparisons, ...strictComparisons, ...largeComparison, ...(holdoutComparison ? [holdoutComparison] : [])];
const report = {
  recordedAt: new Date().toISOString(), status: comparisons.some(result => result.passed === false) ? 'numerical-failures' : 'partial',
  coverage: { fullSizeCompared: largeComparison.length > 0, holdoutCompared: !!holdoutComparison, experimentalStrictMathFullSizeCompared: largeComparison.some(result => result.candidate.includes('strict')), deploymentQualification: 'No experimental backend is promoted by this report; strict-math WebGPU requires nonstandard developer features.' },
  limits: ['Warm kernel timings do not include the same costs in every runtime; compare their timingScope.', 'A native BLAS kernel is not a full Scala EFA implementation.', 'Earlier prototype pipeline files may lack a per-fit input fingerprint; do not treat that missing provenance as verified.', 'Full-size acceptance requires completed runs, identical input fingerprints, all numerical outputs, memory, responsiveness and cancellation; kernel dimensions alone do not establish it.'],
  originalJavaScriptFullSizeBaseline: { status: 'skipped-by-user', reason: 'Latest instruction: WebGPU first, then native, with the original JavaScript CPU full-size baseline skipped for now.' },
  sourceReports: Object.fromEntries(Object.entries(records).map(([name, value]) => [name, value.sha256])), sourceQualification, completedWorkloads, kernels, pipelines, residentComparisons, strictComparisons, largeComparison, holdoutComparison, performance: performanceRecords,
};
await writeFile(root + 'comparison.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ kernelFixtures: kernels.length, completedPipelineFits: pipelines.length, fullSizeComparisons: largeComparison.length, status: report.status }));
