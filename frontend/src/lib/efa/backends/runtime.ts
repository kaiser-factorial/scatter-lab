import { createGpuKernel } from "./webgpu-kernel.mjs";
import { ordinalSourceSize, ordinalSourceChunks, encodeOrdinalRange } from "./native-protocol";
import { companionRequest } from "./companion";
import { numericalSelfCheck } from "./self-check";
import { computeSettings, NATIVE_KERNEL_SHA, type CompanionSession, type EfaExecution } from "./types";
import { EfaError, type EfaSpec, type Progress } from "../types";
import type { TraceKernel, OrdinalTraceSource } from "../trace-kernel";

export async function createBackend(spec: EfaSpec, session: CompanionSession | undefined, publish: (value: EfaExecution) => void, progress: Progress) {
  const settings = computeSettings(spec);
  let destroy = () => {};
  const execution: EfaExecution = { backend: settings.backend, blockSize: settings.blockSize, budgetBytes: settings.budgetBytes, state: "initializing", precision: settings.backend === "scala" ? "float64 / native BLAS" : "portable split-f32 / host-f64", kernelVersion: "ordinal-trace/1" };
  const emit = () => publish(structuredClone(execution));
  emit();
  try {
    let kernel: TraceKernel;
    if (settings.backend === "webgpu") {
      const gpu = await createGpuKernel({ split: true, resident: true, portable: true, reduce: true, dotChunkSize: 1024 });
      destroy = () => gpu.destroy();
      execution.precision = gpu.metadata.precision;
      execution.adapter = Object.values(gpu.metadata.adapter).join(" / ").slice(0, 400);
      execution.kernelSha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(gpu.metadata.shader + (gpu.metadata.triangularShader ?? "") + (gpu.metadata.reductionShader ?? ""))))).map(v => v.toString(16).padStart(2, "0")).join("");
      execution.timings = gpu.timings;
      kernel = block => gpu.run(block);
    } else if (settings.backend === "scala" && session) {
      let resident: OrdinalTraceSource | undefined;
      const timings = { packMs: 0, roundTripMs: 0, nativeMs: 0, materializeMs: 0, blasMs: 0, calls: 0, sentBytes: 0 };
      execution.kernelSha256 = NATIVE_KERNEL_SHA;
      const identity = await (await companionRequest(session, `/v1/jobs/${session.id}`)).json();
      execution.runtime = String(identity.runtime).slice(0, 400);
      execution.timings = timings;
      const request = async (path: string, body: ArrayBuffer) => {
        const at = performance.now();
        const reply = await (await companionRequest(session, `/v1/jobs/${session.id}/${path}`, "POST", body, 120000)).arrayBuffer();
        timings.roundTripMs += performance.now() - at; timings.sentBytes += body.byteLength;
        return reply;
      };
      kernel = async block => {
        if (!block.ordinal) throw new Error("Missing ordinal block");
        if (resident !== block.ordinal.source) {
          const source = block.ordinal.source, size = ordinalSourceSize(source);
          const header = new ArrayBuffer(4); new DataView(header).setUint32(0, size, true);
          await request("source-start", header);
          let offset = 0;
          const chunks = ordinalSourceChunks(source);
          while (true) {
            const at = performance.now(), chunk = chunks.next();
            if (chunk.done) break;
            const packet = new Uint8Array(chunk.value.byteLength + 4);
            new DataView(packet.buffer).setUint32(0, offset, true); packet.set(new Uint8Array(chunk.value), 4);
            timings.packMs += performance.now() - at;
            await request("source-chunk", packet.buffer);
            offset += chunk.value.byteLength;
            if (execution.state !== "self-check") progress({ stage: "Scala resident source upload", completed: offset, total: size });
          }
          await request("source-finish", new ArrayBuffer(4));
          resident = source;
        }
        const reply = await request("block", encodeOrdinalRange(block));
        const count = block.ordinal.leftRows * block.ordinal.rightRows;
        if (reply.byteLength !== 24 + count * 8) throw new Error("Invalid native result");
        const view = new DataView(reply), out = new Float64Array(count);
        timings.nativeMs += view.getFloat64(0, true); timings.materializeMs += view.getFloat64(8, true); timings.blasMs += view.getFloat64(16, true); timings.calls++;
        for (let i = 0; i < count; i++) out[i] = view.getFloat64(24 + i * 8, true);
        return out;
      };
    } else throw new EfaError("companion-unavailable", "Connect the Scala companion before running this analysis.");
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
        } catch { execution.state = "failed"; execution.failure = "backend-computation"; emit(); throw new EfaError("backend-computation", "The selected backend failed during trace computation. No result was published. Check the companion or GPU availability and rerun explicitly."); }
      },
      finish() { execution.state = "completed"; emit(); return structuredClone(execution); },
      destroy,
    };
  } catch (error) {
    destroy(); execution.state = "failed";
    execution.failure = error instanceof EfaError ? error.code : "backend-initialization"; emit();
    if (error instanceof EfaError) throw error;
    throw new EfaError("backend-initialization", "The selected backend could not initialize. WebGPU requires a supported browser, device and secure origin. Scala requires a paired local companion. No fallback was used.");
  }
}
