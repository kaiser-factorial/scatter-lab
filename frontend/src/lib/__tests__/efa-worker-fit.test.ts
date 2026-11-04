import { it, expect, beforeAll, afterAll } from "vitest";
import { build } from "esbuild";
import { Worker } from "node:worker_threads";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EfaService } from "../efa/service";
import { fitEfa } from "../efa/fit";
import { correlate } from "../efa/correlation";
import { prepareEfa } from "../efa/prepare";
import type { EfaSpec } from "../efa/types";
import type { DataTable } from "../table";
const directory = mkdtempSync(join(tmpdir(), "efa-worker-fit-"));
const entry = join(directory, "worker.mjs");
beforeAll(async () => {
  await build({ stdin: { contents: `import { parentPort } from 'node:worker_threads';
    globalThis.self = { postMessage: (value, options) => parentPort.postMessage(value, options?.transfer) };
    await import(${JSON.stringify(resolve("src/lib/efa/efa.worker.ts"))});
    parentPort.on('message', data => self.onmessage({ data }));`, resolveDir: process.cwd() }, bundle: true, platform: "node", format: "esm", outfile: entry });
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const input = JSON.parse(readFileSync(new URL("./fixtures/efa-weighted/normal.input.json", import.meta.url), "utf8")) as DataTable & { categories: number[][]; nFactors: number; reverse: number[] };
const spec: EfaSpec = { items: input.columns.map((column, i) => ({ column, categories: input.categories[i], reverse: input.reverse.includes(i) })), nFactors: input.nFactors, rotation: "oblimin", extraction: "wlsmv", missing: "pairwise", seed: 73021, label: "worker fixture", sample: { partition: "all" } };
const rows = Array.from({ length: input.nRows }, (_, i) => i);
function harness(failBatch = false) {
  let active = 0, peak = 0, batchStarted: (() => void) | undefined;
  const batch = new Promise<void>(resolve => { batchStarted = resolve; });
  const service = new EfaService(() => {
    const worker = new Worker(entry); active++; peak = Math.max(peak, active);
    let terminated = false;
    const adapter = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      onerror: null as ((event: { message: string }) => void) | null,
      postMessage(value: { op: string; id: number }, transfer?: ArrayBuffer[]) {
        if (value.op === "rotation-batch") {
          batchStarted?.();
          if (failBatch) { queueMicrotask(() => adapter.onmessage?.({ data: { id: value.id, error: { code: "fixture", message: "rotation peer failed" } } })); return; }
        }
        worker.postMessage(value, transfer);
      },
      terminate() { if (!terminated) { terminated = true; active--; void worker.terminate(); } },
    };
    worker.on("message", data => adapter.onmessage?.({ data }));
    worker.on("error", error => adapter.onerror?.({ message: error.message }));
    return adapter as unknown as globalThis.Worker;
  }, 4);
  return { service, batch, active: () => active, peak: () => peak };
}
it("production workers finish weighted fits with exact serial SEs, bounded concurrency and telemetry", async () => {
  const data = prepareEfa(input, spec, rows), serial = fitEfa(data, correlate(data), spec);
  const h = harness(), job = h.service.fit(input, spec, rows), result = await job.promise;
  expect(result.weighted!.robust!.standardErrors).toEqual(serial.weighted!.robust!.standardErrors);
  expect(result.rotation).toEqual(serial.rotation);
  expect(h.peak()).toBeLessThanOrEqual(4); expect(h.active()).toBe(0);
  const report = h.service.report(job.id)!;
  expect(report.requests["rotation-batch"].count).toBeGreaterThan(1);
  expect(report.numerical).toBeDefined();
  // Reused correlations must take the same continuation path.
  expect((await h.service.fit(input, spec, rows).promise).weighted).toEqual(result.weighted);
}, 30000);
it("cancelling during derivatives terminates peers and prevents result publication", async () => {
  const h = harness(), job = h.service.fit(input, spec, rows);
  await h.batch; job.cancel();
  await expect(job.promise).rejects.toThrow(/cancel/i);
  expect(job.result).toBeUndefined(); expect(job.status).toBe("cancelled"); expect(h.active()).toBe(0);
}, 30000);
it("peer failure rejects the fit and releases every worker", async () => {
  const h = harness(true), job = h.service.fit(input, spec, rows);
  await expect(job.promise).rejects.toThrow("rotation peer failed");
  expect(job.result).toBeUndefined(); expect(job.status).toBe("failed"); expect(h.active()).toBe(0);
}, 30000);
