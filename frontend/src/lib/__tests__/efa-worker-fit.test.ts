import { it, expect, beforeAll, afterAll } from "vitest";
import { build } from "esbuild";
import { Worker } from "node:worker_threads";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EfaService } from "../efa/service";
import { fitEfa, scoreEfa } from "../efa/fit";
import { correlate } from "../efa/correlation";
import { prepareEfa } from "../efa/prepare";
import type { EfaSpec, EfaRun } from "../efa/types";
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
  return { service, batch, active: () => active, peak: () => peak, fail: (value: boolean) => { failBatch = value; } };
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
it("production workers fit, permute and score numeric column imputation with the same serial semantics", async () => {
  const table = structuredClone(input);
  table.data[table.columns[0]][0] = null;
  table.data[table.columns[1]][1] = null;
  const numeric: EfaSpec = { ...spec, extraction: "minres", missing: "median", items: spec.items.map(item => ({ ...item, categories: [] })) },
    data = prepareEfa(table, numeric, rows), serial = fitEfa(data, correlate(data), numeric), h = harness(),
    job = h.service.fit(table, numeric, rows), result = await job.promise;
  expect(result.rotation).toEqual(serial.rotation); expect(result.imputation).toEqual(serial.imputation);
  expect(h.service.report(job.id)?.transport.receivedTypedBufferBytes).toBe(data.codes.byteLength + data.observed.byteLength + data.numeric!.byteLength);
  const parallel = await h.service.parallel(table, numeric, rows, 2).promise;
  expect(parallel.completed).toBe(2); expect(parallel.provenance?.correlation).toContain("Pearson");
  const run: EfaRun = { id: "numeric", revision: 1, createdAt: "2026-11-06", datasetRevision: "fixture", spec: numeric,
    result, eligibleRows: rows, kind: "fit", reviews: {}, reasons: "", revisedAfterHoldout: false, scoreColumns: [] };
  expect(await h.service.scores(table, run).promise).toEqual(scoreEfa(data, serial));
  expect(h.active()).toBe(0);
}, 30000);
it("production workers carry category median fills through WLSMV, scoring and original-support privacy gates", async () => {
  const table = structuredClone(input);
  table.data[table.columns[0]][0] = null;
  table.data[table.columns[1]][1] = null;
  const ordinal: EfaSpec = { ...spec, correlation: 'polychoric', missing: 'median' },
    data = prepareEfa(table, ordinal, rows), serial = fitEfa(data, correlate(data), ordinal), h = harness(),
    result = await h.service.fit(table, ordinal, rows).promise;
  expect(result.rotation).toEqual(serial.rotation);
  expect(result.weighted).toEqual(serial.weighted);
  expect(result.weighted?.uncertaintyMethod).toContain('conditional on single-imputation');
  expect(result.correlation.pairs[0].n).toBeLessThan(rows.length);
  expect(result.correlation.pairs[0].fittingN).toBe(rows.length);
  const run: EfaRun = { id: 'ordinal', revision: 1, createdAt: '2026-11-06', datasetRevision: 'fixture', spec: ordinal,
    result, eligibleRows: rows, kind: 'fit', reviews: {}, reasons: '', revisedAfterHoldout: false, scoreColumns: [] };
  expect(await h.service.scores(table, run).promise).toEqual(scoreEfa(data, serial));
  await expect(h.service.fit(table, ordinal, rows, undefined, rows.length).promise).rejects.toThrow(/private aggregate floor/);
  expect(h.active()).toBe(0);
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
  h.fail(false);
  expect((await h.service.fit(input, spec, rows).promise).provenance.execution?.reusedFromJobId).toBeUndefined();
}, 30000);

it("reuses invariant inference across rotations without rerunning ordinal uncertainty or leaking mutations", async () => {
  const h = harness(), first = h.service.fit(input, spec, rows), baseline = await first.promise;
  // Result objects belong to callers. Mutating one must not change the cache.
  const originalLoading = baseline.extraction.loadings[0][0];
  baseline.extraction.loadings[0][0] = 12345;
  for (const rotation of ["promax", "varimax"] as const) {
    const candidate = { ...spec, rotation, seed: spec.seed + 1, label: "new label" };
    const job = h.service.fit(input, candidate, rows), result = await job.promise;
    const data = prepareEfa(input, candidate, rows), fresh = fitEfa(data, correlate(data), candidate);
    expect(result.weighted).toEqual(fresh.weighted);
    expect(result.rotation).toEqual(fresh.rotation);
    expect(result.extraction.loadings[0][0]).toBe(originalLoading);
    expect(result.provenance.execution?.reusedFromJobId).toBe(first.id);
    const report = h.service.report(job.id)!;
    expect(report.events.some(e => e.action.startsWith("WLSMV inference hit"))).toBe(true);
    expect(Object.keys(report.workerStages).some(s => /Ordinal uncertainty|Robust trace|Case projection/.test(s))).toBe(false);
    expect(report.requests["fit-cache"]).toBeUndefined();
  }
}, 30000);

it("invalidates invariant inference for revisions, rows, preprocessing, factors and compute settings", async () => {
  const h = harness();
  const candidates: [DataTable, EfaSpec, number[]][] = [
    [structuredClone(input), spec, rows],
    [input, spec, rows.slice(0, -1)],
    [input, { ...spec, missing: "complete" }, rows],
    [input, { ...spec, nFactors: 1 }, rows],
    [input, { ...spec, items: spec.items.map((item, i) => i ? item : { ...item, reverse: !item.reverse }) }, rows],
    [input, { ...spec, compute: { backend: "cpu", blockSize: 64 } }, rows],
  ];
  for (const [table, candidate, membership] of candidates) {
    await h.service.fit(input, spec, rows).promise;
    const job = h.service.fit(table, candidate, membership), result = await job.promise;
    expect(result.provenance.execution?.reusedFromJobId).toBeUndefined();
    expect(h.service.report(job.id)!.events.some(e => e.action === "WLSMV inference miss")).toBe(true);
  }
}, 30000);

it("does not cache a cancelled fit and still applies privacy gates before reuse", async () => {
  const h = harness(), cancelled = h.service.fit(input, spec, rows);
  await h.batch; cancelled.cancel(); await expect(cancelled.promise).rejects.toThrow(/cancel/i);
  const next = h.service.fit(input, spec, rows), result = await next.promise;
  expect(result.provenance.execution?.reusedFromJobId).toBeUndefined();
  const rejected = h.service.fit(input, spec, rows, undefined, input.nRows + 1);
  await expect(rejected.promise).rejects.toThrow(/private aggregate floor/);
  expect(rejected.result).toBeUndefined();
}, 30000);

it("cancelling a cache hit preserves the completed origin and rejects late publication", async () => {
  const h = harness(), original = h.service.fit(input, spec, rows);
  await original.promise;
  const cancelled = h.service.fit(input, { ...spec, rotation: "promax" }, rows);
  const stop = h.service.subscribe(() => {
    if (cancelled.progress.stage === "Rotated standard errors" && cancelled.status === "running") cancelled.cancel();
  });
  await expect(cancelled.promise).rejects.toThrow(/cancel/i); stop();
  expect(cancelled.result).toBeUndefined();
  const next = await h.service.fit(input, spec, rows).promise;
  expect(next.provenance.execution?.reusedFromJobId).toBe(original.id);
}, 30000);
