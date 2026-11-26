import { createGpuKernel } from "./webgpu-kernel.mjs";
import { numericalSelfCheck } from "./self-check";
import { computeSettings, type EfaExecution } from "./types";
import { EfaError, type EfaSpec, type Progress } from "../types";
import type { TraceKernel } from "../trace-kernel";

export async function createBackend(spec: EfaSpec, publish: (value: EfaExecution) => void, progress: Progress) {
  const settings = computeSettings(spec);
  if (settings.backend !== "webgpu") throw new EfaError("backend-method", "The accelerated backend requires an explicit WebGPU selection. No fallback was used.");
  let destroy = () => {};
  const execution: EfaExecution = { backend: settings.backend, blockSize: settings.blockSize, budgetBytes: settings.budgetBytes, state: "initializing", precision: "portable split-f32 / host-f64", kernelVersion: "ordinal-trace/1" };
  const emit = () => publish(structuredClone(execution));
  emit();
  try {
    const gpu = await createGpuKernel({ split: true, resident: true, portable: true, reduce: true, dotChunkSize: 1024 });
    destroy = () => gpu.destroy();
    execution.precision = gpu.metadata.precision;
    execution.adapter = Object.values(gpu.metadata.adapter).join(" / ").slice(0, 400);
    execution.kernelSha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(gpu.metadata.shader + (gpu.metadata.triangularShader ?? "") + (gpu.metadata.reductionShader ?? ""))))).map(v => v.toString(16).padStart(2, "0")).join("");
    execution.timings = gpu.timings;
    const kernel: TraceKernel = block => gpu.run(block);
    execution.state = "self-check"; emit();
    execution.selfCheck = await numericalSelfCheck(kernel, settings.blockSize, (completed, total) => progress({ stage: "Backend numerical self-check", completed, total }));
    execution.state = "ready"; emit();
    let last = 0;
    return {
      async run(block: Parameters<TraceKernel>[0]) {
        try {
          execution.state = "running";
          const result = await kernel(block);
          if (result.length !== block.ordinal!.leftRows * block.ordinal!.rightRows || result.some(v => !Number.isFinite(v))) throw new Error("Invalid backend result");
          if (performance.now() - last > 500) { emit(); last = performance.now(); }
          return result;
        } catch { execution.state = "failed"; execution.failure = "backend-computation"; emit(); throw new EfaError("backend-computation", "The selected backend failed during trace computation. No result was published. Check GPU availability and rerun explicitly."); }
      },
      finish() { execution.state = "completed"; emit(); return structuredClone(execution); },
      destroy,
    };
  } catch (error) {
    destroy(); execution.state = "failed";
    execution.failure = error instanceof EfaError ? error.code : "backend-initialization"; emit();
    if (error instanceof EfaError) throw error;
    throw new EfaError("backend-initialization", "The selected backend could not initialize. WebGPU requires a supported browser, device and secure origin. No fallback was used.");
  }
}
