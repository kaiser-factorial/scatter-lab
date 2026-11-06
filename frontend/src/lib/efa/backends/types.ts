import { EfaError, type EfaSpec } from "../types";
export type EfaBackend = "cpu" | "webgpu" | "scala";
export interface EfaComputeSettings { backend: EfaBackend; blockSize?: number; memoryMiB?: number; correction?: "exact" | "estimated"; probes?: number; probeSeed?: number }
export interface CompanionConnection { url: string; token: string }
export interface CompanionSession extends CompanionConnection { id: string }
export interface KernelSelfCheck {
  version: "ordinal-trace/1" | "ordinal-trace-probes/1"; passed: boolean; checks: number; tolerance: number;
  maxScaledError: number; elapsedMs: number;
}
export interface EfaExecution {
  backend: EfaBackend;
  state: "initializing" | "self-check" | "ready" | "running" | "completed" | "failed";
  precision: string;
  kernelVersion?: string;
  kernelSha256?: string;
  adapter?: string;
  runtime?: string;
  blockSize: number;
  budgetBytes: number;
  selfCheck?: KernelSelfCheck;
  timings?: Record<string, number | null>;
  failure?: string;
  reusedFromJobId?: string;
}
export function computeSettings(spec: EfaSpec) {
  if (spec.compute !== undefined && (!spec.compute || typeof spec.compute !== "object" || Array.isArray(spec.compute) || Object.keys(spec.compute).some(key => !["backend", "blockSize", "memoryMiB", "correction", "probes", "probeSeed"].includes(key)) || !spec.compute.backend))
    throw new EfaError("backend-settings", "Compute settings accept only backend, blockSize, memoryMiB, correction, probes and probeSeed. Pairing is session-only.");
  const settings = spec.compute, backend = settings?.backend ?? "cpu";
  if (!["cpu", "webgpu", "scala"].includes(backend)) throw new EfaError("backend", "Unknown EFA compute backend.");
  if (backend !== "cpu" && spec.extraction !== "wlsmv") throw new EfaError("backend-method", "WebGPU and Scala accelerate WLSMV trace corrections. Select WLSMV or Browser CPU.");
  if ((settings?.blockSize !== undefined && ![32, 64, 128, 256].includes(settings.blockSize)) ||
      (settings?.memoryMiB !== undefined && !Number.isInteger(settings.memoryMiB)))
    throw new EfaError("backend-budget", "Use integer block and memory settings.");
  const correction = settings?.correction ?? "exact", probes = settings?.probes ?? 128, probeSeed = settings?.probeSeed ?? 61001;
  if (!["exact", "estimated"].includes(correction) || !Number.isSafeInteger(probes) || probes < 16 || probes > 4096 || !Number.isSafeInteger(probeSeed) || probeSeed < 0 || probeSeed > 0xffffffff)
    throw new EfaError("trace-settings", "Choose exact or estimated MV correction, 16–4096 integer probes and an integer seed from 0 to 4294967295.");
  if (correction === "estimated" && (backend !== "webgpu" || spec.extraction !== "wlsmv"))
    throw new EfaError("trace-backend", "Estimated MV correction requires WLSMV with WebGPU. CPU and Scala provide exact correction.");
  const blockSize = settings?.blockSize ?? (backend === "scala" ? 256 : backend === "webgpu" ? 128 : 32);
  const memoryMiB = settings?.memoryMiB ?? (backend === "cpu" ? 1024 : 1536);
  if (![32, 64, 128, 256].includes(blockSize) ||
      !Number.isInteger(memoryMiB) || memoryMiB < 256 || memoryMiB > 4096)
    throw new EfaError("backend-budget", "Choose a supported block size and a memory budget between 256 and 4096 MiB.");
  return { backend, blockSize, correction, ...(correction === "estimated" ? { probes, probeSeed } : {}), budgetBytes: memoryMiB * 1024 ** 2, ...(backend === "cpu" ? {} : { space: "cases" as const }) };
}
export const COMPANION_PROTOCOL = "scatter-efa-companion/2";
export const NATIVE_KERNEL_SHA = "21136cac2832c38efd222afa1da3d4828427590785dca5d270f00543c5554ed9";
