// Summarize measured experiments without conflating kernel and complete-fit costs.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = 'scripts/efa-reference/compute';
const sources = {};
async function read(filename) {
  const bytes = await readFile(`${root}/${filename}`);
  sources[filename] = createHash('sha256').update(bytes).digest('hex');
  return JSON.parse(bytes);
}
const median = values => { const sorted = values.slice().sort((a, b) => a - b); return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2; };
const baseline = await read('native-resident-reference.json');
const sameHardware = report => ['cpu', 'architecture', 'memoryBytes'].every(key => report.hardware?.[key] === baseline.hardware?.[key]);
const variants = [];
for (const rowCache of [false, true]) for (const threads of [1, 2, 4]) {
  const filename = `native-reuse-${rowCache ? 'row-cache' : 'direct'}-${threads}.json`;
  const report = await read(filename), memory = await read(filename.replace('.json', '.memory.json'));
  if (!sameHardware(report)) throw new Error(`Hardware descriptions differ; do not present this as a same-host optimization comparison: ${filename}`);
  if (report.inputSha256 !== baseline.inputSha256 || JSON.stringify(report.manifest.ranges) !== JSON.stringify(baseline.manifest.ranges)) throw new Error(`Changed optimization inputs: ${filename}`);
  if (report.status !== 'passed' || report.results.length !== 10 || report.cancellation?.passed !== true || !Number.isFinite(report.subsequentMedianMs) || report.results.some(result => result.calls.length !== 5 || result.calls.some(call => call.errors?.passed !== true || !['roundTripMs', 'nativeStageMs', 'materializeMs', 'blasMs'].every(key => Number.isFinite(call[key]) && call[key] >= 0)))) throw new Error(`Incomplete numerical, timing or cancellation evidence: ${filename}`);
  const phaseTotals = key => Array.from({ length: 5 }, (_, repeat) => report.results.reduce((sum, result) => sum + result.calls[repeat][key], 0));
  variants.push({ filename, hardware: report.hardware, metadata: report.metadata, sourceSha256: report.sourceSha256, requestedBlasThreads: threads, rowCodeCache: rowCache, firstIterationMs: report.firstIterationMs, subsequentMedianMs: report.subsequentMedianMs, subsequentRangeMs: [Math.min(...report.iterationMs.slice(1)), Math.max(...report.iterationMs.slice(1))],
    ratioToBaselineWarmMedian: report.subsequentMedianMs / baseline.subsequentMedianMs,
    materializeSubsequentMedianMs: median(phaseTotals('materializeMs').slice(1)), blasSubsequentMedianMs: median(phaseTotals('blasMs').slice(1)),
    sourceInitMs: report.sourceInitMs, compileMs: report.compileMs, startupMs: report.startupMs,
    maxScaledError: Math.max(...report.results.flatMap(result => result.calls.map(call => call.errors.maxScaled))), memory, cancellation: report.cancellation,
  });
}
const gpu = await read('gpu-resident-strict-reduced.json');
if (!sameHardware(gpu)) throw new Error('GPU/native resident hardware descriptions differ');
if (gpu.sourceSha256 !== baseline.inputSha256 || gpu.status !== 'passed' || gpu.results.length !== 10 || gpu.results.some(result => result.errors?.passed !== true)) throw new Error('Incomplete GPU resident parity evidence');
const gpuCases = gpu.results.map((result, index) => {
  if (JSON.stringify(result.range) !== JSON.stringify(baseline.results[index].range)) throw new Error('GPU/native resident case order differs');
  return { fixture: result.fixture, range: result.range, firstIterationMs: result.iterationMs[0], subsequentMedianMs: median(result.iterationMs.slice(1)), measurements: result.measurements, errors: result.errors };
});
const precision = [];
for (const filename of ['gpu-precision-default.json', 'gpu-precision-strict.json']) {
  const report = await read(filename);
  for (const backend of [...new Set(report.results.map(result => result.backend))]) {
    const fits = report.results.filter(result => result.backend === backend);
    precision.push({ filename, backend, developerOnly: report.developerOnly, cases: fits.length, passedAtTolerance1eMinus10: fits.filter(result => result.errors.passed).length, passedAtTolerance1eMinus5: fits.filter(result => result.baselineToleranceErrors.passed).length, maximumScaledError: Math.max(...fits.map(result => result.errors.maxScaled)) });
  }
}
const suite = await read('remaining-suite.json');
const report = {
  recordedAt: new Date().toISOString(), status: 'measured', hardware: baseline.hardware, inputSha256: baseline.inputSha256,
  limitations: [
    'These are resident case-block workloads, not optimized full-size fits.',
    'Native measurements execute the ten ranges in order, repeating the sequence five times; GPU measurements repeat each range five times before moving to the next. Cache/ordering differences prevent treating their aggregate times as an end-to-end speed ratio.',
    'Native thread counts are environment requests; actual BLAS thread counts were not observed.',
    'Strict-math GPU measurements require an explicitly enabled nonstandard developer feature.',
    'Phase medians need not sum to the median total.',
  ],
  nativeBaseline: { filename: 'native-resident-reference.json', firstIterationMs: baseline.firstIterationMs, subsequentMedianMs: baseline.subsequentMedianMs, requestedBlasThreads: baseline.requestedBlasThreads },
  nativeVariants: variants, nativeSelection: suite.nativeSelection, gpuResident: { developerOnly: gpu.developerOnly, cases: gpuCases, memory: gpu.memory }, precision, sourceReports: sources,
};
await writeFile(`${root}/optimization-comparison.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, nativeVariants: variants.length, gpuCases: gpuCases.length, selected: suite.nativeSelection?.selected }));
