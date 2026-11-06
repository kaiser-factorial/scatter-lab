import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { EfaService } from "../efa/service";
import { prepareEfa } from "../efa/prepare";
import { correlate, estimatePair } from "../efa/correlation";
import { fitEfa } from "../efa/fit";
import {
  fitImputationChain,
  observedPairFloor,
} from "../efa/imputation-analysis";
import type { WorkerRequest } from "../efa/efa.worker";
import type { EfaPreparedData, EfaSpec, EfaRun } from "../efa/types";
import type { DataTable } from "../table";
import type { MiceOptions } from "../efa/mice";
const fixture = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/efa-extensions/mice-chain.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { table: DataTable & { categories: number[][] }; options: MiceOptions };
const spec: EfaSpec = {
  items: fixture.table.columns.map((column, i) => ({
    column,
    categories: fixture.table.categories[i],
    reverse: false,
  })),
  missing: "pairwise",
  rotation: "oblimin",
  nFactors: 1,
  seed: 1,
  label: "worker fixture",
  sample: { partition: "all" },
};
function harness(slow = false) {
  const workers: MockWorker[] = [],
    completed: number[] = [],
    estimatedPairs: [number, number][] = [];
  class MockWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    timers = new Set<ReturnType<typeof setTimeout>>();
    prepared?: EfaPreparedData;
    terminated = false;
    postMessage(input: WorkerRequest) {
      const request = structuredClone(input),
        timer = setTimeout(
          () => {
            this.timers.delete(timer);
            if (this.terminated) return;
            try {
              let value: unknown;
              if (request.op === "prepare") {
                this.prepared = prepareEfa(
                  request.table,
                  request.spec,
                  request.rows,
                );
                value = this.prepared;
              }
              if (request.op === "initialize") {
                this.prepared = request.data;
                value = true;
              }
              if (request.op === "pairs") {
                estimatedPairs.push(...request.pairs);
                value = request.pairs.map(([i, j]) => estimatePair(this.prepared!, i, j));
              }
              if (request.op === "fit")
                value = fitEfa(this.prepared!, request.correlation, request.spec, undefined, request.extraction);
              if (request.op === "observed-support")
                value = observedPairFloor(this.prepared!);
              if (request.op === "imputation") {
                value = fitImputationChain(
                  this.prepared!,
                  request.spec,
                  request.options,
                  request.index,
                );
                completed.push(request.index);
              }
              if (request.op === "parallel-observed")
                value = [1, 0, -0.1, -0.2];
              if (request.op === "parallel-replicate") {
                if (request.seed === 2)
                  throw new Error("deliberate replicate failure");
                value = [request.seed / 100, 0, -0.1, -0.2];
                completed.push(request.seed);
              }
              this.onmessage?.({ data: { id: request.id, value } });
            } catch (error) {
              this.onmessage?.({
                data: {
                  id: request.id,
                  error: { code: "fixture", message: String(error) },
                },
              });
            }
          },
          slow
            ? 500
            : request.op === "imputation" && request.index === 0
              ? 80
              : 1,
        );
      this.timers.add(timer);
    }
    terminate() {
      this.terminated = true;
      this.timers.forEach(clearTimeout);
      this.timers.clear();
    }
  }
  const service = new EfaService(() => {
    const worker = new MockWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  }, 99);
  return { service, workers, completed, estimatedPairs };
}

it('keeps original incomplete respondents while fitting each ordinal MICE completion with Gaussian ML', async () => {
  const h = harness(), rows = Array.from({ length: fixture.table.nRows }, (_, i) => i);
  const candidate: EfaSpec = { ...spec, extraction: 'ml', correlation: 'pearson', missing: 'complete', likelihood: { starts: 1 } };
  const result = await h.service.impute(fixture.table, candidate, rows, { ...fixture.options, imputations: 2, iterations: 2 }).promise;
  expect(result.fittingRows).toEqual(rows);
  expect(result.missingPositions.length).toBeGreaterThan(0);
  expect(result.completed).toBe(2);
  expect(result.fits.every(fit => fit.result.extraction.estimator === 'ml' && fit.result.likelihood?.kind === 'ml')).toBe(true);
  expect(h.workers.every(worker => worker.terminated)).toBe(true);
});

it("retains the original correlation pool through repeated exclusions and reinclusion, but never across changed rows", async () => {
  const table = JSON.parse(readFileSync(new URL("./fixtures/efa/mixed.input.json", import.meta.url), "utf8")) as DataTable & { categories: number[][] };
  const full: EfaSpec = { ...spec, items: table.columns.map((column, i) => ({ column, categories: table.categories[i], reverse: false })) };
  const rows = Array.from({ length: table.nRows }, (_, i) => i), h = harness();
  const baseline = await h.service.fit(table, full, rows).promise;
  const parent: EfaRun = {
    id: "original", revision: 1, createdAt: "2026-11-06", datasetRevision: h.service.revision(table),
    spec: full, result: baseline, eligibleRows: rows, kind: "fit", reviews: {}, reasons: "", revisedAfterHoldout: false, scoreColumns: [],
  };
  const initialPairs = h.estimatedPairs.length;
  expect(initialPairs).toBe(28);
  h.service.retainRefitBaseline(table, parent);
  for (const count of [7, 6, 5, 8]) {
    const job = h.service.fit(table, { ...full, items: full.items.slice(0, count) }, rows);
    const fit = await job.promise;
    expect(fit.correlation.matrix).toHaveLength(count);
    expect(h.estimatedPairs).toHaveLength(initialPairs);
  }
  const changed = await h.service.fit(table, { ...full, items: full.items.slice(0, 5) }, rows.slice(1)).promise;
  expect(h.estimatedPairs).toHaveLength(initialPairs + 10);
  expect(changed.fittingRows).toEqual(rows.slice(1));
});
it("never reuses ordinal or different-imputation pairs, but reuses numeric subset pairs on fixed rows", async () => {
  const table = structuredClone(fixture.table), rows = Array.from({ length: table.nRows }, (_, i) => i), h = harness();
  const ordinal = await h.service.fit(table, spec, rows).promise;
  const pairCount = ordinal.correlation.pairs.length;
  for (const missing of ["mean", "median"] as const) {
    const next = { ...spec, missing }, prepared = prepareEfa(table, next, rows),
      result = await h.service.fit(table, next, rows).promise;
    expect(result.correlation).toEqual(correlate(prepared));
    expect(result.imputation?.method).toBe(missing);
  }
  expect(h.estimatedPairs).toHaveLength(pairCount * 3);
  const reduced = { ...spec, missing: "median" as const, items: spec.items.slice(0, -1) },
    result = await h.service.fit(table, reduced, rows).promise;
  expect(result.correlation).toEqual(correlate(prepareEfa(table, reduced, rows)));
  expect(h.estimatedPairs).toHaveLength(pairCount * 3);
});
it("column imputation cannot inflate original observed support past the private floor", async () => {
  const table = structuredClone(fixture.table), rows = Array.from({ length: table.nRows }, (_, i) => i), h = harness();
  table.data[table.columns[0]] = rows.map(i => i < 4 ? i : null);
  await expect(h.service.fit(table, { ...spec, missing: "mean" }, rows, undefined, 5).promise)
    .rejects.toThrow(/private aggregate floor/);
  expect(h.workers.every(w => w.terminated)).toBe(true);
});
it('separates explicit correlation caches while preserving an auto-inferred refit baseline', async () => {
  const table = structuredClone(fixture.table), rows = Array.from({ length: table.nRows }, (_, i) => i), h = harness(),
    automatic: EfaSpec = { ...spec, correlation: 'auto', missing: 'median' };
  const baseline = await h.service.fit(table, automatic, rows).promise, pairCount = baseline.correlation.pairs.length;
  expect(baseline.correlationMethod).toBe('polychoric');
  const parent: EfaRun = { id: 'auto', revision: 1, createdAt: '2026-11-06', datasetRevision: h.service.revision(table),
    spec: automatic, result: baseline, eligibleRows: rows, kind: 'fit', reviews: {}, reasons: '', revisedAfterHoldout: false, scoreColumns: [] };
  h.service.retainRefitBaseline(table, parent);
  const numeric = { ...automatic, correlation: 'pearson' as const };
  const pearson = await h.service.fit(table, numeric, rows).promise;
  expect(pearson.correlationMethod).toBe('pearson'); expect(h.estimatedPairs).toHaveLength(pairCount * 2);
  const subset = { ...automatic, items: automatic.items.slice(0, -1) };
  expect((await h.service.fit(table, subset, rows).promise).correlation).toEqual(correlate(prepareEfa(table, subset, rows)));
  expect(h.estimatedPairs).toHaveLength(pairCount * 2);
});
it('rejects continuous ordinal-MICE inputs before creating workers', () => {
  const h = harness(), rows = Array.from({ length: fixture.table.nRows }, (_, i) => i);
  expect(() => h.service.impute(fixture.table, { ...spec, correlation: 'auto', items: spec.items.map((item, i) => ({ ...item, measurement: i === 0 ? 'continuous' : 'auto' })) }, rows, fixture.options)).toThrow(/ordered categorical items/);
  expect(h.workers).toHaveLength(0);
});
it("bounds imputation workers and preserves independent chain order despite out-of-order completion", async () => {
  const h = harness(),
    rows = Array.from({ length: fixture.table.nRows }, (_, i) => i),
    options = { ...fixture.options, imputations: 6, iterations: 1 };
  const job = h.service.impute(fixture.table, spec, rows, options);
  // Caller edits after launch must not affect the immutable job snapshot.
  options.imputations = 2;
  rows.pop();
  const result = await job.promise;
  expect(h.workers).toHaveLength(4);
  expect(h.workers.every((w) => w.terminated)).toBe(true);
  expect(h.completed[0]).not.toBe(0);
  expect(result.requested).toBe(6);
  expect(result.fittingRows).toHaveLength(400);
  expect(result.fits.map((f) => f.imputation)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(result.failures).toEqual([]);
  expect(job.status).toBe("completed");
  const report = h.service.report(job.id)!;
  expect(report.activeWorkers).toBe(0);
  expect(report.workersCreated).toBe(4);
  expect(report.requests.imputation.count).toBe(6);
  expect(report.requests.initialize.count).toBe(3);
  expect(report.transport.sentTypedBufferBytes).toBe(3 * 400 * spec.items.length * 3);
  expect(report.transport.receivedTypedBufferBytes).toBe(400 * spec.items.length * 3);
  expect(JSON.stringify(report)).not.toContain("worker fixture");
});
it("retains failed parallel replicates, orders successful draws and withholds an incomplete suggestion", async () => {
  const h = harness(),
    job = h.service.parallel(
      fixture.table,
      spec,
      Array.from({ length: 400 }, (_, i) => i),
      6,
    );
  const result = await job.promise;
  expect(h.workers).toHaveLength(4);
  expect(result.failures).toEqual([
    { replicate: 1, error: "Error: deliberate replicate failure" },
  ]);
  expect(result.nullEigenvalues.map((v) => v[0])).toEqual([
    0.01, 0.03, 0.04, 0.05, 0.06,
  ]);
  expect(result.completed).toBe(5);
  expect(result.suggested).toBeNull();
});
it("cancels preparation and never publishes a cancelled or superseded batch", async () => {
  const h = harness(true),
    rows = Array.from({ length: 400 }, (_, i) => i);
  const first = h.service.impute(fixture.table, spec, rows, fixture.options);
  const second = h.service.parallel(fixture.table, spec, rows, 3);
  expect(first.status).toBe("cancelled");
  expect(h.workers[0].terminated).toBe(true);
  second.cancel();
  await expect(first.promise).rejects.toThrow(/cancelled/);
  await expect(second.promise).rejects.toThrow(/cancelled/);
  expect(first.result).toBeUndefined();
  expect(second.result).toBeUndefined();
  expect(h.service.report(first.id)?.status).toBe("cancelled");
  expect(h.service.report(second.id)?.activeWorkers).toBe(0);
  expect(h.workers.every((w) => w.terminated)).toBe(true);
});
it("rejects invalid imputation settings before allocating workers", () => {
  const h = harness();
  expect(() =>
    h.service.impute(fixture.table, spec, [], {
      ...fixture.options,
      imputations: 10001,
    }),
  ).toThrow(/2–100/);
  expect(() =>
    h.service.impute(
      fixture.table,
      { ...spec, missing: "complete" },
      [],
      fixture.options,
    ),
  ).toThrow(/incomplete respondents/);
  expect(h.workers).toHaveLength(0);
});
it("checks original observed support in a worker before private imputation begins", async () => {
  const h = harness(),
    table = structuredClone(fixture.table),
    first = table.columns[0];
  table.data[first] = table.data[first].map((_, i) =>
    i < 4 ? 1 + (i % 2) : null,
  );
  const job = h.service.impute(
    table,
    spec,
    Array.from({ length: table.nRows }, (_, i) => i),
    fixture.options,
    5,
  );
  await expect(job.promise).rejects.toThrow(/Original observed pairs/);
  expect(h.completed).toEqual([]);
  expect(h.workers).toHaveLength(1);
  expect(h.workers[0].terminated).toBe(true);
});
