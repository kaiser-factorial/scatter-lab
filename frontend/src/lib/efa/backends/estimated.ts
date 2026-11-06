import { createTraceOperator, type TraceOperator } from "./trace-operator.mjs";
import { computeSettings, type EfaExecution, type KernelSelfCheck } from "./types";
import { EfaError, type EfaSpec, type Progress } from "../types";
import { applyTraceOperatorCpu, rademacherProbes, probeSquaredNorms, traceEstimate, type TraceEstimateTask } from "../trace-estimation";
import type { OrdinalTraceSource } from "../trace-kernel";

/** Synthetic-only self-checks before any analysis data reaches the operator.
 * Exercise the target reduction axes separately to bound Float64 oracle work. */
export function operatorCheckSource(n: number, p: number, q: number): OrdinalTraceSource {
  const codes = new Uint16Array(n * p), observed = new Uint8Array(n * p), pairs: OrdinalTraceSource["pairs"] = [];
  for (let i = 0; i < codes.length; i++) { codes[i] = (i * 7 + Math.floor(i / n)) % 3; observed[i] = i % 11 ? 1 : 0; }
  for (let i = 0; i < p; i++) for (let j = 0; j < i; j++) pairs.push({ i, j, n, columns: 3, values: Float64Array.from({ length: 9 }, (_, c) => Math.sin(c + i * 2 + j)), variance: 1 });
  return { nRows: n, codes, observed, pairs, rootWeights: Float64Array.from(pairs, () => 1 / Math.sqrt(n)), projection: Array.from({ length: n }, (_, r) => Float64Array.from({ length: q }, (_, c) => Math.cos(r + 2 * c) / Math.sqrt(n))) };
}

export async function createEstimatedBackend(spec: EfaSpec, publish: (value: EfaExecution) => void, progress: Progress) {
  const settings = computeSettings(spec);
  if (settings.correction !== "estimated" || settings.backend !== "webgpu") throw new EfaError("trace-settings", "Select estimated MV correction with WebGPU.");
  const execution: EfaExecution = { backend: "webgpu", state: "self-check", precision: "portable split-f32 / host-f64", blockSize: settings.blockSize, budgetBytes: settings.budgetBytes, kernelVersion: "ordinal-trace-probes/1" };
  const emit = () => publish(structuredClone(execution));
  let gpu: TraceOperator | undefined;
  const destroy = () => { gpu?.destroy(); gpu = undefined; };
  emit();
  try {
    const started = performance.now(); let checks = 0, maxScaledError = 0;
    const cases = [[35, 50, 3, 7], [270, 5, 3, 16], [31, 500, 3, 1], [20000, 5, 3, 1], [35, 5, 2490, 7]];
    for (let c = 0; c < cases.length; c++) {
      progress({ stage: "MV operator numerical self-check", completed: c, total: cases.length });
      const [n, p, q, count] = cases[c], source = operatorCheckSource(n, p, q), probes = rademacherProbes(n, count, 83019);
      gpu = await createTraceOperator(source);
      const expected = applyTraceOperatorCpu(source, probes, count), { products } = await gpu.apply(probes, count);
      if (products.length !== expected.length) throw new Error("Invalid operator output shape");
      for (let i = 0; i < expected.length; i++) {
        const error = Math.abs(products[i] - expected[i]) / Math.max(1, Math.abs(expected[i]));
        if (!Number.isFinite(error) || error > 1e-10) throw new EfaError("trace-self-check", "Estimated MV numerical self-check failed. No estimator was substituted.");
        maxScaledError = Math.max(maxScaledError, error); checks++;
      }
      execution.adapter = Object.values(gpu.metadata.adapter).join(" / ");
      execution.kernelSha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(gpu.metadata.shader + gpu.metadata.reductionShader))), b => b.toString(16).padStart(2, "0")).join("");
      destroy();
    }
    const selfCheck: KernelSelfCheck = { version: "ordinal-trace-probes/1", passed: true, checks, tolerance: 1e-10, maxScaledError, elapsedMs: performance.now() - started };
    execution.selfCheck = selfCheck; execution.state = "ready"; emit();
    progress({ stage: "MV operator numerical self-check", completed: cases.length, total: cases.length });
    return {
      async estimate(task: TraceEstimateTask) {
        const values: number[] = [], timings: Record<string, number> = { probes: 0, operatorMs: 0, peakOwnedGpuBufferBytes: 0 };
        execution.state = "running"; execution.timings = timings; emit();
        try {
          const before = performance.now();
          gpu = await createTraceOperator(task.source, p => progress({ ...p, stage: `MV matrix products · ${p.stage}` }));
          timings.startupMs = performance.now() - before;
          progress({ stage: "Estimated MV probes", completed: 0, total: task.probes });
          while (values.length < task.probes) {
            const count = Math.min(32, task.probes - values.length), probes = rademacherProbes(task.source.nRows, count, task.seed, values.length);
            const result = await gpu.apply(probes, count);
            values.push(...probeSquaredNorms(result.products, count));
            timings.probes = values.length; timings.operatorMs += result.elapsedMs;
            timings.peakOwnedGpuBufferBytes = Math.max(timings.peakOwnedGpuBufferBytes, result.peakOwnedGpuBufferBytes);
            for (const stage of result.stages) timings[stage.stage] = (timings[stage.stage] ?? 0) + stage.elapsedMs;
            progress({ stage: "Estimated MV probes", completed: values.length, total: task.probes, traceEstimation: traceEstimate(values, task.seed, task.probes) });
            emit();
          }
          return traceEstimate(values, task.seed, task.probes);
        } catch (error) {
          execution.state = "failed"; execution.failure = "trace-estimate"; emit();
          if (error instanceof EfaError) throw error;
          throw new EfaError("trace-estimate", "Estimated MV correction failed. No partial estimate or substitute estimator was published.");
        }
      },
      finish() { execution.state = "completed"; emit(); return structuredClone(execution); }, destroy,
    };
  } catch (error) {
    destroy(); execution.state = "failed"; execution.failure = "trace-self-check"; emit();
    if (error instanceof EfaError) throw error;
    throw new EfaError("trace-self-check", "The WebGPU MV operator could not initialize or pass its numerical self-check. No fallback was used.");
  }
}
