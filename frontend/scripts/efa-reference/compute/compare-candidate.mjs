import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { createFitComparator } from './fit-comparison.mjs';

const [baselineFile, candidateFile, qualificationFile, outputFile] = process.argv.slice(2);
if (!outputFile) throw new Error('Provide baseline, candidate, independent-R qualification and new output paths');
const read = async path => {
  const bytes = await readFile(path);
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), data: JSON.parse(bytes) };
};
const baseline = await read(baselineFile), candidate = await read(candidateFile), qualification = await read(qualificationFile);
const bundle = `/tmp/scatter-candidate-matching-${process.pid}.mjs`;
await build({ entryPoints: ['src/lib/efa/compare.ts'], bundle: true, format: 'esm', platform: 'node', outfile: bundle });
const { matchFactors } = await import(bundle);
const { compareFit, maximumError } = createFitComparator(matchFactors);
const fits = candidate.data.results;
if (!fits?.length || ['failed', 'numerical-failures'].includes(candidate.data.status)) throw new Error('Candidate did not complete successfully');
const native = fits.every(fit => fit.backend === 'scala-resident');
if (!native && fits.some(fit => fit.backend !== 'gpu-portable-reduced')) throw new Error('Unexpected candidate backend');
const referenceNames = ['normal', 'pairwise', 'complete', 'skew', 'heavy-tail'];
const rQualified = qualification.data.status === 'passed' && referenceNames.every(name => qualification.data.results.some(fit => fit.fixture === name && fit.backend === fits[0].backend && fit.passed === true));
const same = (a, b) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
const provenance = native ? {
  independentReferencesPassed: rQualified,
  samePipeline: same(candidate.data.pipelineSha256, qualification.data.pipelineSha256),
  sameScalaSource: same(candidate.data.scalaSourceSha256, qualification.data.scalaSourceSha256),
  sameNativeBytecode: same(candidate.data.nativeBytecode, qualification.data.nativeBytecode),
  sameProtocol: same(candidate.data.protocolSha256, qualification.data.protocolSha256),
  sameNativeOptions: same(candidate.data.nativeArguments, qualification.data.nativeArguments),
  sameThreadRequest: fits[0].kernelMetadata.requestedBlasThreads === qualification.data.results.find(fit => fit.backend === 'scala-resident')?.kernelMetadata.requestedBlasThreads,
} : {
  independentReferencesPassed: rQualified,
  sameWorker: same(candidate.data.workerSha256, qualification.data.workerSha256),
  noDeveloperFlags: [candidate.data, qualification.data].every(report => report.developerOnly === false && Array.isArray(report.browserArguments) && report.browserArguments.length === 0 && (report.webgpuRuntimeFlags === undefined || (Array.isArray(report.webgpuRuntimeFlags) && report.webgpuRuntimeFlags.length === 0)) && report.results.every(fit => fit.developerOnly === false && fit.kernelMetadata?.developerOnly === false && fit.kernelMetadata.strictMathRequested === null)),
};
// New parallel executables/configuration are part of the qualified method.
// Legacy reports remain readable; a new candidate cannot omit these fields.
if ([...fits, ...qualification.data.results].some(fit => fit.rotationExecution)) {
  provenance.sameRotationWorker = same(candidate.data.rotationWorkerSha256, qualification.data.rotationWorkerSha256);
  if (native) provenance.sameRotationPool = same(candidate.data.rotationPoolSha256, qualification.data.rotationPoolSha256);
  provenance.sameRotationExecution = fits.every(fit => qualification.data.results.some(ref => ref.backend === fit.backend && same(fit.rotationExecution, ref.rotationExecution)));
}
if (!native && [...fits, ...qualification.data.results].some(fit => fit.kernelMetadata?.dotChunkSize)) {
  const settings = fit => [fit.kernelMetadata?.dotChunkSize, fit.kernelMetadata?.materializePanels, fit.kernelMetadata?.preSplit];
  provenance.sameTraceSettings = fits.every(fit => qualification.data.results.some(ref => ref.backend === fit.backend && same(settings(fit), settings(ref))));
}
if (Object.values(provenance).some(value => value !== true)) throw new Error(`Unqualified candidate provenance: ${JSON.stringify(provenance)}`);
const comparisons = fits.map(fit => {
  const reference = baseline.data.results.find(r => r.fixture === fit.fixture && r.backend === 'scala-resident');
  if (!reference) throw new Error('Missing native comparison fixture');
  if (fit.fixture === 'large' || fit.fixture === 'large-holdout') {
    if (fit.dimensions.items !== 500 || fit.dimensions.factors !== 5 || fit.dimensions.rows !== (fit.fixture === 'large' ? 20000 : 6000)) throw new Error('Incorrect full workload dimensions');
  }
  let sameMembership;
  if (fit.fixture === 'large-holdout') {
    for (const value of [fit.sample, reference.sample]) {
      if (value?.sourceRows !== 20000 || value.development?.length !== 14000 || value.holdout?.length !== 6000 || value.afterFullExploration !== true) throw new Error('Missing saved holdout membership or history');
      const rows = [...value.development, ...value.holdout];
      if (new Set(rows).size !== 20000 || rows.some(row => !Number.isSafeInteger(row) || row < 0 || row >= 20000)) throw new Error('Invalid saved membership');
    }
    sameMembership = maximumError(fit.sample.development, reference.sample.development) === 0 && maximumError(fit.sample.holdout, reference.sample.holdout) === 0;
    if (!sameMembership) throw new Error('Holdout memberships differ');
  }
  return { fixture: fit.fixture, dimensions: fit.dimensions, inputSha256: fit.inputSha256, sameMembership, ...compareFit(reference, fit) };
});
const report = {
  recordedAt: new Date().toISOString(), status: comparisons.every(value => value.passed) ? 'passed' : 'numerical-failures',
  provenance, comparisons, evidence: [baseline, candidate, qualification].map(({ path, sha256 }) => ({ path, sha256 })),
  runtimeFlagObservation: native ? undefined : { candidate: candidate.data.webgpuRuntimeFlags ?? null, qualification: qualification.data.webgpuRuntimeFlags ?? null, missingMeaning: "Earlier harness records launch configuration only; null is not an observed runtime command line" },
  scope: 'Exact saved inputs; unchanged full-output tolerances. Candidate source qualified against five independent R fixtures. No cross-device guarantee or automatic production promotion.',
};
await writeFile(outputFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: report.status, provenance, comparisons: comparisons.map(({ fixture, errors, passed }) => ({ fixture, errors, passed })) }));
if (report.status !== 'passed') process.exitCode = 1;
