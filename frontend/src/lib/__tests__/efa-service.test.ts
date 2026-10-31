import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { EfaService } from "../efa/service";
import { prepareEfa } from "../efa/prepare";
import {
  fitImputationChain,
  observedPairFloor,
} from "../efa/imputation-analysis";
import type { WorkerRequest } from "../efa/efa.worker";
import type { EfaPreparedData, EfaSpec } from "../efa/types";
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
    completed: number[] = [];
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
  return { service, workers, completed };
}
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
