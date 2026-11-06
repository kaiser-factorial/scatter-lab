import { prepareEfa } from '../../../src/lib/efa/prepare.ts';
import { correlate } from '../../../src/lib/efa/correlation.ts';
import { weightedMoments } from '../../../src/lib/efa/weighted-moments.ts';
import { extractDwls } from '../../../src/lib/efa/dwls.ts';
import { weightedInferenceSteps, weightedInference } from '../../../src/lib/efa/weighted-inference.ts';
import { fingerprintPrepared } from '../../../src/lib/efa/fingerprint.ts';
import { chiSquareSf } from '../../../src/lib/statTests.ts';
import { applyTraceOperatorCpu, rademacherProbes, probeSquaredNorms, summarizeTraceProbes } from '../../../src/lib/efa/trace-estimation.ts';
import { createGpuKernel } from './webgpu-kernel.mjs';
import { createTraceOperator } from './trace-operator.mjs';
import { benchmarkData } from '../benchmark-data.ts';

const progress = value => self.postMessage({ progress: value });
const diff = (a, b) => {
  let maxAbs = 0, maxScaled = 0;
  if (a.length !== b.length) throw new Error('Operator shape mismatch');
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) throw new Error('Non-finite comparison');
    maxAbs = Math.max(maxAbs, Math.abs(a[i] - b[i]));
    maxScaled = Math.max(maxScaled, Math.abs(a[i] - b[i]) / Math.max(1, Math.abs(b[i])));
  }
  return { maxAbs, maxScaled, tolerance: 1e-10, passed: maxScaled <= 1e-10 };
};
const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');

async function selfCheck() {
  const results = [];
  // Exercise short/tail tiles, both long reduction axes, and the target q.
  // The largest axes are checked separately so the Float64 oracle stays small.
  for (const [n, p, q, counts] of [[35, 50, 3, [1, 7, 33]], [270, 5, 3, [16]], [31, 500, 3, [7]], [20000, 5, 3, [7]], [35, 5, 2490, [7]]]) {
    const codes = new Uint16Array(n * p), observed = new Uint8Array(n * p), pairs = [];
    for (let i = 0; i < codes.length; i++) { codes[i] = (i * 7 + Math.floor(i / n)) % 3; observed[i] = i % 11 ? 1 : 0; }
    for (let i = 0; i < p; i++) for (let j = 0; j < i; j++) pairs.push({ i, j, n, columns: 3, values: Float64Array.from({ length: 9 }, (_, c) => Math.sin(c + i * 2 + j)), variance: 1 });
    const source = { nRows: n, codes, observed, pairs, rootWeights: Float64Array.from(pairs, () => 1 / Math.sqrt(n)), projection: Array.from({ length: n }, (_, r) => Float64Array.from({ length: q }, (_, c) => Math.cos(r + 2 * c) / Math.sqrt(n))) };
    const gpu = await createTraceOperator(source);
    try {
      for (const count of counts) {
        const probes = rademacherProbes(n, count, 83019), expected = applyTraceOperatorCpu(source, probes, count);
        const actual = await gpu.apply(probes, count), errors = diff(actual.products, expected);
        results.push({ n, p, q, pairs: pairs.length, count, errors });
        if (!errors.passed) throw new Error(`Matrix-free operator self-check failed: ${JSON.stringify(results.at(-1))}`);
      }
    } finally { gpu.destroy(); }
  }
  return results;
}

function correction(exact, trace, traceSquared) {
  const scalingFactor = Math.sqrt(traceSquared / exact.df), shift = exact.df - trace / scalingFactor;
  const statistic = exact.rawStatistic / scalingFactor + shift;
  const test = { trace, traceSquared, scalingFactor, shift, statistic, pValue: chiSquareSf(statistic, exact.df) };
  return { test, delta: Object.fromEntries(Object.entries(test).map(([key, value]) => [key, value - exact[key]])), relativeTraceSquaredError: (traceSquared - exact.traceSquared) / exact.traceSquared };
}

self.onmessage = async ({ data: options }) => {
  const results = []; let gpu, exactGpu, checks;
  try {
    checks = await selfCheck(); self.postMessage({ selfChecks: checks });
    for (const scenario of options.scenarios ?? options.fixtures.map(name => ({ name }))) {
      const { name, n = options.n, p = options.p } = scenario;
      const started = performance.now(), timings = {}; let input, spec, reference;
      if (name === 'synthetic' || name === 'large') ({ table: input, spec } = benchmarkData(n, p));
      else {
        input = await (await fetch(`./reference/${name}.input.json`)).json();
        reference = await (await fetch(`./reference/${name}.reference.json`)).json();
        spec = { items: input.columns.map((column, i) => ({ column, categories: input.categories[i], reverse: input.reverse.includes(i) })), nFactors: input.nFactors, rotation: 'oblimin', missing: input.missing, seed: 73021, label: name, sample: { partition: 'all' } };
      }
      let before = performance.now();
      progress({ stage: `${name}: preparation`, completed: 0, total: 1 });
      const data = prepareEfa(input, spec, Array.from({ length: input.nRows }, (_, i) => i));
      const inputSha256 = await fingerprintPrepared(data);
      timings.preparation = performance.now() - before; before = performance.now();
      const correlations = correlate(data, progress); timings.correlations = performance.now() - before; before = performance.now();
      const moments = weightedMoments(data, correlations, progress); timings.uncertainty = performance.now() - before; before = performance.now();
      const extraction = extractDwls(correlations.matrix, moments, spec.nFactors, progress); timings.dwls = performance.now() - before; before = performance.now();
      const steps = weightedInferenceSteps(data, moments, extraction.loadings, extraction.convergence.objective, progress, { space: 'cases', blockSize: 128, budgetBytes: 1536 * 1024 ** 2 });
      let cpuExact;
      if (data.items.length <= 20) {
        const samples = [];
        for (let repeat = 0; repeat < 7; repeat++) {
          const at = performance.now(), inference = weightedInference(data, moments, extraction.loadings, extraction.convergence.objective);
          samples.push(performance.now() - at);
          cpuExact = { space: inference.plan.space, test: inference.test, elapsedMs: samples, scope: "Complete CPU inference (information, covariance and exact traces), excluding preparation/correlations/extraction/rotation" };
        }
      }
      before = performance.now();
      let state = steps.next();
      if (state.done || !state.value.ordinal) throw new Error('Missing case-space source');
      const source = state.value.ordinal.source;
      timings.projectionAndCovariance = performance.now() - before;
      let projectionNorm = 0, compensation = 0;
      for (const row of source.projection) for (const z of row) { const term = z * z - compensation, next = projectionNorm + term; compensation = next - projectionNorm - term; projectionNorm = next; }
      const trace = moments.pairs.length - projectionNorm;
      let exact, exactScope, exactErrors;
      if (name === 'large') {
        const saved = options.exactReference;
        if (!saved || saved.inputSha256 !== inputSha256 || saved.dimensions.rows !== data.nRows || saved.dimensions.items !== data.items.length || saved.dimensions.factors !== spec.nFactors) throw new Error('Saved exact reference does not match the input snapshot');
        exact = saved.test;
        exactErrors = diff([trace, (data.nRows - 1) * extraction.convergence.objective], [exact.trace, exact.rawStatistic]);
        if (!exactErrors.passed) throw new Error('Current source does not reproduce saved exact normalization/objective');
        exactScope = 'Previously completed full exact WebGPU fit; matching prepared-input hash, dimensions, trace and DWLS objective. Timing comparison is historical, not a paired rerun.';
        steps.return();
      } else {
        before = performance.now();
        exactGpu = await createGpuKernel({ split: true, resident: true, portable: true, reduce: true, dotChunkSize: 1024 });
        timings.exactStartup = performance.now() - before; before = performance.now();
        while (!state.done) state = steps.next(await exactGpu.run(state.value));
        timings.exactTrace = performance.now() - before;
        exact = state.value.test; exactScope = 'Full exact triangular WebGPU trace on the same current source';
        exactGpu.destroy(); exactGpu = undefined;
        // Moment-space Float64 is an independent algebraic reference for public fixtures.
        if (reference) {
          const cpu = weightedInference(data, moments, extraction.loadings, extraction.convergence.objective, undefined, { space: 'moments' });
          exactErrors = diff(Object.values(exact), Object.values(cpu.test));
          if (!exactErrors.passed) throw new Error('Exact GPU versus Float64 moment-space comparison failed');
        }
      }
      before = performance.now(); gpu = await createTraceOperator(source, progress);
      timings.operatorStartup = performance.now() - before;
      const metadata = { ...gpu.metadata, shaderSha256: await hash(new TextEncoder().encode(gpu.metadata.shader)), reductionShaderSha256: await hash(new TextEncoder().encode(gpu.metadata.reductionShader)) };
      delete metadata.shader; delete metadata.reductionShader;
      const estimates = [];
      for (const seed of options.seeds) {
        const values = [], batches = []; let elapsedMs = 0;
        for (const count of [32, 32, 64]) {
          const offset = values.length, probes = rademacherProbes(data.nRows, count, seed, offset);
          const result = await gpu.apply(probes, count); elapsedMs += result.elapsedMs;
          let numericalErrors;
          if (reference && offset === 0) {
            numericalErrors = diff(result.products, applyTraceOperatorCpu(source, probes, count));
            if (!numericalErrors.passed) throw new Error('Actual fixture operator failed Float64 oracle');
          }
          values.push(...probeSquaredNorms(result.products, count));
          batches.push({ count, offset, elapsedMs: result.elapsedMs, stages: result.stages, peakOwnedGpuBufferBytes: result.peakOwnedGpuBufferBytes, numericalErrors });
          const summary = summarizeTraceProbes(values);
          estimates.push({ seed, ...summary, elapsedMs, batches: batches.slice(), probeNorms: values.slice(), ...correction(exact, trace, summary.traceSquared) });
          self.postMessage({ estimate: { fixture: name, seed, probes: values.length, elapsedMs, relativeTraceSquaredError: estimates.at(-1).relativeTraceSquaredError } });
        }
      }
      gpu.destroy(); gpu = undefined;
      const r = reference?.fits.oblimin.test['scaled.shifted'];
      results.push({ fixture: name, inputSha256, dimensions: { rows: data.nRows, items: data.items.length, factors: spec.nFactors, pairs: moments.pairs.length, parameters: source.projection[0].length }, exact, exactScope, exactErrors, cpuExact, independentRDelta: r ? { trace: exact.trace - r['trace.UGamma'], traceSquared: exact.traceSquared - r['trace.UGamma2'], statistic: exact.statistic - r.stat } : undefined, timings, totalMs: performance.now() - started, estimates, metadata, extractionConvergence: extraction.convergence });
      self.postMessage({ partial: results.at(-1) });
    }
    self.postMessage({ result: { status: 'completed-experiment', scope: 'Fixed-budget stochastic trace experiment; not an application estimator or an accuracy certification', selfChecks: checks, results } });
  } catch (error) {
    gpu?.destroy(); exactGpu?.destroy();
    self.postMessage({ result: { status: 'failed', error: String(error), selfChecks: checks, results } });
  }
};
