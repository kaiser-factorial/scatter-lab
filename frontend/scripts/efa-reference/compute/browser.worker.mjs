import { cpuTraceBlock } from "../../../src/lib/efa/trace-kernel.ts";
import { decodeBlock, difference } from "./binary.ts";
import { createGpuKernel } from "./webgpu-kernel.mjs";
const hash = async buffer => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)), v => v.toString(16).padStart(2, "0")).join("");
self.onmessage = async () => {
  let gpu;
  const started = performance.now(), results = [], metadata = [];
  try {
    const manifest = await (await fetch("./fixtures/manifest.json")).json();
    for (const backend of ["cpu", "gpu-f32", "gpu-compensated", "gpu-split"]) {
      if (backend !== "cpu") {
        gpu = await createGpuKernel({ compensated: backend === "gpu-compensated", split: backend === "gpu-split" });
        metadata.push({ ...gpu.metadata, variant: backend, startupMs: gpu.timings.startupMs });
      }
      for (const fixture of manifest.fixtures) {
        self.postMessage({ stage: `${backend}: ${fixture.name}` });
        const raw = await (await fetch(`./fixtures/${fixture.name}.bin`)).arrayBuffer();
        const expected = await (await fetch(`./fixtures/${fixture.name}.reference.bin`)).arrayBuffer();
        if (await hash(raw) !== fixture.inputSha256 || await hash(expected) !== fixture.referenceSha256) throw new Error(`Fixture hash mismatch: ${fixture.name}`);
        const block = decodeBlock(raw), reference = new Float64Array(expected), times = [];
        const before = gpu ? { ...gpu.timings } : undefined;
        let output;
        for (let i = 0; i < 5; i++) {
          const start = performance.now();
          output = gpu ? await gpu.run(block) : cpuTraceBlock(block);
          times.push(performance.now() - start);
        }
        const errors = difference(block, reference, output, gpu ? 1e-5 : 1e-10);
        const timing = gpu ? Object.fromEntries(Object.keys(gpu.timings).filter(k => k !== "startupMs" && k !== "peakOwnedGpuBufferBytes").map(k => [k, gpu.timings[k] === null ? null : gpu.timings[k] - before[k]])) : undefined;
        results.push({ fixture: fixture.name, backend, precision: gpu?.metadata.precision ?? 'float64', inputSha256: fixture.inputSha256, outputSha256: await hash(output.buffer), errors, iterationMs: times,
          measurements: timing, ownedGpuBufferBytes: gpu?.timings.peakOwnedGpuBufferBytes, output: Array.from(output) });
      }
      gpu?.destroy(); gpu = undefined;
    }
    self.postMessage({ result: { status: results.every(r => r.errors.passed) ? "passed" : "numerical-failures", scope: "Targeted WLSMV case-block kernels; not full pipeline or full 500x20000 qualification", elapsedMs: performance.now() - started, browser: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, metadata, results } });
  } catch (error) {
    gpu?.destroy();
    self.postMessage({ result: { status: "failed", error: String(error), results, metadata } });
  }
};
