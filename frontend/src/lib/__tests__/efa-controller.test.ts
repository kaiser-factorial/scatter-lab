import { it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { EfaController, type EfaContext } from "../efa/controller";
import { EfaService, type EfaJob } from "../efa/service";
import { prepareEfa } from "../efa/prepare";
import { correlate } from "../efa/correlation";
import { fitEfa } from "../efa/fit";
import { emptyEfaState } from "../efa/state";
import type { DataTable } from "../table";
import type { EfaSpec, EfaResult } from "../efa/types";

const table = JSON.parse(
  readFileSync(
    new URL("./fixtures/efa/mixed.input.json", import.meta.url),
    "utf8",
  ),
) as DataTable & { categories: number[][] };
const spec: EfaSpec = {
  items: table.columns.map((column, i) => ({
    column,
    categories: table.categories[i],
    reverse: false,
  })),
  nFactors: 2,
  rotation: "oblimin",
  missing: "pairwise",
  label: "fixture",
  seed: 73021,
  sample: { partition: "all" },
};
const rows = Array.from({ length: table.nRows }, (_, i) => i),
  data = prepareEfa(table, spec, rows),
  result = fitEfa(data, correlate(data), spec);
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(deferState = false) {
  let context: EfaContext = {
    datasetId: 1,
    table,
    eligibleRows: rows,
    state: emptyEfaState(),
    privateMode: true,
    afterFullExploration: false,
    filterKey: "all",
  };
  const service = new EfaService(),
    pending = deferred<EfaResult>();
  const job: EfaJob<EfaResult> = {
    id: "job",
    status: "running",
    progress: { stage: "test", completed: 0, total: 1 },
    promise: pending.promise,
    cancel: () => {
      job.status = "cancelled";
      pending.reject(new Error("cancelled"));
    },
  };
  vi.spyOn(service, "fit").mockReturnValue(job);
  vi.spyOn(service, "getJob").mockReturnValue(job);
  vi.spyOn(service, "cancelAll").mockImplementation(() => job.cancel());
  const controller = new EfaController(service, () => ({
    context: () => context,
    state: (_id, _table, update) => {
      if (deferState) return;
      context = { ...context, state: update(context.state) };
    },
    scores: (_id, _table, next, id, columns) => {
      context = {
        ...context,
        table: next,
        state: {
          ...context.state,
          runs: context.state.runs.map((r) =>
            r.id === id ? { ...r, scoreColumns: columns } : r,
          ),
        },
      };
    },
  }));
  return {
    controller,
    service,
    pending,
    job,
    get: () => context,
    set: (patch: Partial<EfaContext>) => {
      context = { ...context, ...patch };
    },
  };
}
it("never publishes a completion after dataset or filter changes", async () => {
  for (const patch of [
    { datasetId: 2 },
    { table: { ...table } },
    { filterKey: "new-filter" },
  ]) {
    const t = setup(),
      fit = t.controller.run(spec);
    t.set(patch);
    t.pending.resolve(result);
    await expect(fit).rejects.toThrow(/not published/);
    expect(t.get().state.runs).toHaveLength(0);
  }
});
it("workspace restoration / undo invalidates even a same-table completion", async () => {
  const t = setup(),
    fit = t.controller.run(spec);
  t.controller.cancel();
  t.pending.resolve(result);
  await expect(fit).rejects.toThrow();
  expect(t.get().state.runs).toHaveLength(0);
});
it("snapshots specifications and substantive review reasons before an asynchronous fit", async () => {
  const t = setup(),
    candidate = structuredClone(spec),
    options = {
      reviews: {
        item1: {
          status: "investigate" as const,
          note: "Original content rationale",
        },
      },
      reasons: "Original item set",
    };
  const pending = t.controller.run(candidate, options);
  candidate.label = "Edited later";
  options.reviews.item1.note = "Edited while running";
  options.reasons = "Later reasons";
  t.pending.resolve(result);
  await pending;
  const saved = t.get().state.runs[0];
  expect(saved.spec.label).toBe(spec.label);
  expect(saved.reviews.item1.note).toBe("Original content rationale");
  expect(saved.reasons).toBe("Original item set");
});
it("saved child results retain the parent and record the chosen item reviews", async () => {
  const t = setup(),
    fit = t.controller.run(spec);
  t.pending.resolve(result);
  const id = await fit;
  const baseline = t.get().state.runs[0];
  t.controller.reviews(id, {
    item1: { status: "investigate", note: "Content coverage" },
  });
  expect(baseline.reviews).toEqual({});
  expect(t.get().state.runs[0].reviews.item1.note).toBe("Content coverage");
  expect(t.get().state.runs[0].result).toBe(result);
});
it("private diagnostics never disclose respondent membership, thresholds, scores, or rare combinations", async () => {
  const t = setup(),
    fit = t.controller.run(spec);
  t.pending.resolve(result);
  const runId = await fit;
  const summary = JSON.parse(
    await t.controller.tool("get_efa_diagnostics", { runId }),
  );
  expect(summary.pattern).toHaveLength(8);
  expect(summary).not.toHaveProperty("fittingRows");
  expect(summary).not.toHaveProperty("pairs");
  expect(summary).not.toHaveProperty("means");
  expect(summary).not.toHaveProperty("weights");
  const rare = {
    ...result,
    correlation: {
      ...result.correlation,
      pairs: result.correlation.pairs.map((p, i) =>
        i === 0 ? { ...p, n: 2 } : p,
      ),
    },
  };
  t.set({
    state: {
      ...t.get().state,
      runs: [{ ...t.get().state.runs[0], result: rare }],
    },
  });
  expect(await t.controller.tool("get_efa_diagnostics", { runId })).toContain(
    "withheld",
  );
  expect(
    await t.controller.tool("run_efa", { spec: { secret: "hidden-response" } }),
  ).not.toContain("hidden-response");
});
it("structure replication refuses a changed development specification", async () => {
  const t = setup();
  t.set({
    state: {
      runs: [],
      splits: [
        {
          id: "s",
          label: "split",
          seed: 1,
          fraction: 0.7,
          development: rows.slice(0, 1000),
          holdout: rows.slice(1000),
          eligible: rows,
          createdAt: "2026-10-30",
          afterFullExploration: false,
        },
      ],
    },
  });
  const dev = {
      ...spec,
      sample: { partition: "development" as const, splitId: "s" },
    },
    fit = t.controller.run(dev);
  t.pending.resolve(result);
  const parentId = await fit;
  await expect(
    t.controller.run(
      {
        ...dev,
        rotation: "varimax",
        sample: { partition: "holdout", splitId: "s" },
      },
      { parentId, kind: "structure-replication" },
    ),
  ).rejects.toThrow(/freezes/);
  const holdoutId = await t.controller.run(
    { ...dev, sample: { partition: "holdout", splitId: "s" } },
    { parentId, kind: "structure-replication" },
  );
  expect(t.get().state.splits[0].holdoutOpenedAt).toBeUndefined();
  await t.controller.tool("get_efa_diagnostics", { runId: holdoutId });
  expect(t.get().state.splits[0].holdoutOpenedAt).toBeTruthy();
  await t.controller.run(spec);
  expect(t.get().state.runs.at(-1)?.revisedAfterHoldout).toBe(true);
});

it("allows same-turn assistant diagnostics before React commits, then forgets them on undo", async () => {
  const t = setup(true),
    fit = t.controller.run(spec);
  t.pending.resolve(result);
  const runId = await fit;
  expect(t.get().state.runs).toHaveLength(0);
  expect(
    JSON.parse(await t.controller.tool("get_efa_diagnostics", { runId }))
      .pattern,
  ).toHaveLength(8);
  t.controller.cancel();
  expect(await t.controller.tool("get_efa_diagnostics", { runId })).toContain(
    "failed",
  );
});

it("private assistant rejects tiny selections and passes the pairwise privacy floor to workers", async () => {
  const t = setup();
  t.set({ eligibleRows: [0, 1, 2, 3] });
  expect(await t.controller.tool("run_efa", { spec })).toContain("privacy");
  expect(t.service.fit).not.toHaveBeenCalled();
  t.set({ eligibleRows: rows });
  expect(await t.controller.tool("run_efa", { spec })).toContain("jobId");
  expect(t.service.fit).toHaveBeenLastCalledWith(
    table,
    spec,
    rows,
    undefined,
    5,
  );
  t.pending.resolve(result);
});

it("rotation comparisons reject changed items or preprocessing before launching", async () => {
  const t = setup(),
    fit = t.controller.run(spec);
  t.pending.resolve(result);
  const parentId = await fit;
  await expect(
    t.controller.run(
      { ...spec, missing: "complete" },
      { parentId, kind: "rotation" },
    ),
  ).rejects.toThrow(/preserves/);
  await expect(t.controller.run(spec, { kind: "rotation" })).rejects.toThrow(
    /requires/,
  );
});
