import { prepareEfa } from "../../../src/lib/efa/prepare.ts";
import { correlate } from "../../../src/lib/efa/correlation.ts";
import { weightedMoments } from "../../../src/lib/efa/weighted-moments.ts";
import { extractDwls } from "../../../src/lib/efa/dwls.ts";
import { weightedInferenceWithKernel } from "../../../src/lib/efa/weighted-inference.ts";
import { cpuTraceBlock } from "../../../src/lib/efa/trace-kernel.ts";
import { rotate } from "../../../src/lib/efa/rotation.ts";
import { rotatedUncertaintyParallel } from "../../../src/lib/efa/weighted-rotation.ts";
import { matchFactors } from "../../../src/lib/efa/compare.ts";
import { Matrix, solve } from "../../../src/lib/efa/math.ts";
import { createGpuKernel } from "./webgpu-kernel.mjs";
import { benchmarkData } from "../benchmark-data.ts";
import { fingerprintPrepared } from "../../../src/lib/efa/fingerprint.ts";
import { createSampleSplit } from "../../../src/lib/efa/state.ts";

import { createRotationPool } from "./rotation-pool.mjs";

const difference = (a, b) => Math.max(0, ...a.flatMap((row, i) => row.map((v, j) => Math.abs(v - b[i][j]))));
export async function runPipeline(options, hooks = {}) {
  const results = [];
  let gpu, active;
  const concurrency = Math.min(options.rotationWorkers ?? 4, typeof navigator === "undefined" ? 4 : Math.max(1, navigator.hardwareConcurrency || 1));
  const rotationUrl = options.rotationWorkerSource ? URL.createObjectURL(new Blob([options.rotationWorkerSource], { type: 'text/javascript' })) : undefined;
  const rotationPool = hooks.rotationPool ?? createRotationPool(() => new Worker(rotationUrl ?? './rotation-worker.js', { type: 'module' }), concurrency);
  if (rotationUrl) {
    rotationPool.metadata.workerSha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(options.rotationWorkerSource))), value => value.toString(16).padStart(2, '0')).join('');
    rotationPool.metadata.workerDelivery = 'Immutable source message, verified in coordinator, instantiated from Blob URL';
  }
  const emitProgress = hooks.progress ?? (p => self.postMessage({ progress: p }));
  let phase, phaseStarted;
  const finishPhase = () => {
    if (active && phase) active.phaseTimings[phase] = (active.phaseTimings[phase] ?? 0) + performance.now() - phaseStarted;
  };
  const progress = p => {
    if (p.stage !== phase) { finishPhase(); phase = p.stage; phaseStarted = performance.now(); }
    emitProgress(p);
  };
  try {
    for (const backend of options.backends ?? ["cpu", "gpu-resident"]) {
      let probeBlock;
      if (!["cpu", "gpu-split", "gpu-resident", "gpu-strict-reduced", "gpu-portable-reduced", "scala-blas", "scala-resident"].includes(backend)) throw new Error(`Unknown benchmark backend: ${backend}`);
      if (backend.startsWith("scala") && !hooks.kernelFactory) throw new Error("Scala benchmarks require the explicit local child-process harness");
      if (backend !== "cpu") gpu = hooks.kernelFactory ? await hooks.kernelFactory(backend) : await createGpuKernel({ dotChunkSize: options.dotChunkSize, materializePanels: !!options.materializePanels, preSplit: !!options.preSplit, split: true, resident: backend !== "gpu-split", ...(backend === "gpu-strict-reduced" ? { compensatedSplit: true, reduce: true, strictMath: true } : backend === "gpu-portable-reduced" ? { portable: true, reduce: true } : {}) });
      for (const name of options.fixtures ?? ["normal", "pairwise", "complete", "skew", "heavy-tail"]) {
        probeBlock = undefined;
        let input, spec, reference, sample;
        if (name === "large" || name === "large-holdout") {
          ({ table: input, spec } = benchmarkData(options.n ?? 20000, options.p ?? 500));
          if (name === "large-holdout") {
            const split = createSampleSplit(input, Array.from({ length: input.nRows }, (_, i) => i), { seed: 93821, fraction: 0.7, afterFullExploration: true });
            sample = { sourceRows: input.nRows, seed: split.seed, developmentFraction: split.fraction, development: split.development, holdout: split.holdout, afterFullExploration: true, scope: "Synthetic performance refit of saved holdout membership; no validation claim" };
            spec = { ...spec, sample: { partition: "holdout", fixedRows: split.holdout } };
          }
        } else {
          if (hooks.loadReference) ({ input, reference } = await hooks.loadReference(name));
          else {
            input = await (await fetch(`./reference/${name}.input.json`)).json();
            reference = await (await fetch(`./reference/${name}.reference.json`)).json();
          }
          spec = { items: input.columns.map((column, i) => ({ column, categories: input.categories[i], reverse: input.reverse.includes(i) })), nFactors: input.nFactors, rotation: "oblimin", missing: input.missing, seed: 73021, label: name, sample: { partition: "all" } };
        }
        const totalStart = performance.now(), timings = {};
        phase = undefined;
        active = { backend, fixture: name, timings, phaseTimings: {}, startedAt: new Date().toISOString() };
        let before = performance.now();
        progress({ stage: `${backend} ${name}: preparation`, completed: 0, total: 1 });
        const data = prepareEfa(input, spec, sample?.holdout ?? Array.from({ length: input.nRows }, (_, i) => i));
        const inputSha256 = await fingerprintPrepared(data);
        active.inputSha256 = inputSha256;
        timings.prepare = performance.now() - before; before = performance.now();
        const correlation = correlate(data, progress);
        timings.correlations = performance.now() - before; before = performance.now();
        const moments = weightedMoments(data, correlation, progress);
        timings.uncertainty = performance.now() - before; before = performance.now();
        const extraction = extractDwls(correlation.matrix, moments, spec.nFactors, progress);
        timings.dwls = performance.now() - before; before = performance.now();
        const inference = await weightedInferenceWithKernel(gpu ? block => { probeBlock ??= block; return gpu.run(block); } : async block => cpuTraceBlock(block), data, moments, extraction.loadings, extraction.convergence.objective, progress, { space: "cases", blockSize: options.blockSize, budgetBytes: options.budgetBytes });
        timings.robustInference = performance.now() - before;
        const rotations = {};
        Object.assign(active, { test: inference.test, plan: inference.plan, rotations });
        for (const method of ["oblimin", "promax", "varimax"]) {
          before = performance.now();
          progress({ stage: `${method}: rotation`, completed: 0, total: 1 });
          const rotation = rotate(extraction.loadings, method, spec.seed, 4, true);
          timings[`${method}Rotation`] = performance.now() - before; before = performance.now();
          const se = await rotatedUncertaintyParallel(inference.identified, inference.covariance, rotation, method, spec.seed, rotationPool.execute, rotationPool.concurrency, value => progress({ ...value, stage: `${method}: ${value.stage}` }));
          timings[`${method}SE`] = performance.now() - before;
          const pattern = new Matrix(rotation.pattern), phi = new Matrix(rotation.phi), structure = pattern.mmul(phi);
          const common = structure.mmul(pattern.transpose());
          let errors;
          if (reference) {
            const r = reference.delta[method], match = matchFactors(r.pattern, rotation.pattern);
            errors = {
              pattern: difference(rotation.pattern.map(row => match.mapping.map((j, i) => row[j] * match.signs[i])), r.pattern),
              structure: difference(structure.to2DArray().map(row => match.mapping.map((j, i) => row[j] * match.signs[i])), r.structure),
              phi: difference(match.mapping.map((i, a) => match.mapping.map((j, b) => rotation.phi[i][j] * match.signs[a] * match.signs[b])), r.phi),
              patternSE: difference(se.pattern.map(row => match.mapping.map(j => row[j])), r.se.pattern),
              structureSE: difference(se.structure.map(row => match.mapping.map(j => row[j])), r.se.structure),
              phiSE: difference(match.mapping.map(i => match.mapping.map(j => se.phi[i][j])), r.se.phi),
            };
          }
          rotations[method] = { pattern: rotation.pattern, phi: rotation.phi, structure: structure.to2DArray(), communalities: common.diag(), standardErrors: se, convergence: rotation.convergence, errors };
          if (method === "oblimin") {
            before = performance.now();
            const weights = solve(new Matrix(correlation.matrix), structure), scores = new Float64Array(data.nRows * spec.nFactors);
            const completeMask = new Uint8Array(data.nRows);
            let complete = 0;
            for (let row = 0; row < data.nRows; row++) {
              if (data.items.some((_, j) => !data.observed[j * data.nRows + row])) continue;
              complete++;
              completeMask[row] = 1;
              for (let j = 0; j < data.items.length; j++) {
                const z = (data.codes[j * data.nRows + row] + 1 - data.means[j]) / data.sds[j];
                for (let f = 0; f < spec.nFactors; f++) scores[row * spec.nFactors + f] += z * weights.get(j, f);
              }
            }
            if (scores.some(v => !Number.isFinite(v))) throw new Error("Non-finite scores");
            timings.scores = performance.now() - before;
            rotations[method].scoreCompleteRows = complete;
            // These are synthetic/public qualification datasets only. Preserve
            // actual scores and masks so full-size parity is measured, not
            // inferred from finite outputs or matching loadings.
            rotations[method].scores = { values: Array.from(scores), completeMask: Array.from(completeMask), weights: weights.to2DArray(), means: data.means, sds: data.sds };
          }
        }
        const r = reference?.fits.oblimin.test['scaled.shifted'];
        const errors = reference ? { correlation: difference(correlation.matrix, reference.correlation), trace: Math.abs(inference.test.trace - r['trace.UGamma']), traceSquared: Math.abs(inference.test.traceSquared - r['trace.UGamma2']), scalingFactor: Math.abs(inference.test.scalingFactor - r['scaling.factor']), shift: Math.abs(inference.test.shift - r['shift.parameter']), statistic: Math.abs(inference.test.statistic - r.stat), pValue: Math.abs(inference.test.pValue - r.pvalue) } : undefined;
        const passed = errors ? (errors.correlation < 1e-5 && errors.statistic < 1e-4 && errors.pValue < 1e-5 && errors.trace < 1e-4 && errors.traceSquared < 1e-4 && Object.values(rotations).every(rotation => Object.entries(rotation.errors).every(([key, value]) => value < (key.endsWith('SE') ? 1e-4 : 1e-3)))) : null;
        finishPhase();
        results.push({ backend, fixture: name, inputSha256, sample, developerOnly: backend === "gpu-strict-reduced", executionStatus: "completed", qualification: reference ? "independent R reference" : "Execution only; full-size cross-backend comparison pending", dimensions: { rows: data.nRows, items: data.items.length, factors: spec.nFactors }, totalMs: performance.now() - totalStart, timings, phaseTimings: active.phaseTimings, phaseTimingScope: "Elapsed between worker progress-stage transitions; includes unreported work until the next transition. Separate from explicit whole-stage timers.", extractionConvergence: extraction.convergence, test: inference.test, plan: inference.plan, rotations, errors, passed, kernelTimingsCumulative: gpu ? { ...gpu.timings } : undefined, rotationExecution: rotationPool.metadata, kernelMetadata: gpu?.metadata });
        if (hooks.partial) hooks.partial(results.at(-1));
        else if (typeof self !== "undefined") self.postMessage({ partial: results.at(-1) });
        active = undefined;
      }
      if (gpu && hooks.beforeDestroy) { rotationPool.destroy(); await hooks.beforeDestroy(gpu, probeBlock, results); }
      gpu?.destroy(); gpu = undefined;
    }
    return { status: results.some(r => r.passed === false) ? "numerical-failures" : results.every(r => r.passed) ? "passed" : "completed-unqualified", results };
  } catch (error) { const kernelTimings = gpu ? { ...gpu.timings } : undefined; gpu?.destroy(); return { status: "failed", error: String(error), active, kernelTimings, results }; } finally { rotationPool.destroy(); if (rotationUrl) URL.revokeObjectURL(rotationUrl); }
}
if (typeof self !== "undefined") self.onmessage = async ({ data }) => {
  const hooks = data.probeCancellation ? {
    beforeDestroy: async (kernel, block, results) => {
      // The completed fit is published as benchmark evidence before a separate
      // cancellation-only workload begins. Its elapsed time excludes this loop.
      self.postMessage({ result: { status: results.some(r => r.passed === false) ? "numerical-failures" : results.every(r => r.passed) ? "passed" : "completed-unqualified", results }, keepAlive: true });
      let notified = false;
      kernel.setDispatchObserver(() => { if (!notified) { notified = true; self.postMessage({ probeDispatched: true }); } });
      for (;;) await kernel.run(block);
    },
  } : {};
  self.postMessage({ result: await runPipeline(data, hooks) });
};
