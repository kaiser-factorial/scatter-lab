import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { EfaController, type EfaContext } from "../efa/controller";
import { EfaService, type EfaJob } from "../efa/service";
import { emptyEfaState } from "../efa/state";
import { prepareEfa } from "../efa/prepare";
import { correlate } from "../efa/correlation";
import { fitEfa } from "../efa/fit";
import { ComputeTrace } from "../efa/telemetry";
import type { DataTable } from "../table";
import type { EfaResult, EfaRun, EfaSpec, ItemReview } from "../efa/types";

const table = JSON.parse(readFileSync(new URL("./fixtures/efa/mixed.input.json", import.meta.url), "utf8")) as DataTable & { categories: number[][] };
const spec: EfaSpec = {
  items: table.columns.map((column, i) => ({ column, categories: table.categories[i], reverse: false })),
  nFactors: 2, rotation: "oblimin", missing: "pairwise", label: "Original", seed: 73021,
  sample: { partition: "all" },
};
const rows = Array.from({ length: table.nRows }, (_, i) => i);
const prepared = prepareEfa(table, spec, rows);
const result = fitEfa(prepared, correlate(prepared), spec);

function harness() {
  const service = new EfaService();
  const parent: EfaRun = {
    id: "parent", revision: 1, createdAt: "2026-11-06", datasetRevision: service.revision(table),
    spec: structuredClone(spec), result, eligibleRows: rows, kind: "fit", reviews: {}, reviewRevision: 0,
    reasons: "", revisedAfterHoldout: false, scoreColumns: [],
  };
  let context: EfaContext = {
    datasetId: 1, table, eligibleRows: rows, state: { ...emptyEfaState(), runs: [parent] },
    privateMode: false, afterFullExploration: true, filterKey: "all",
  };
  const jobs: { job: EfaJob<EfaResult>; resolve: (value: EfaResult) => void }[] = [];
  vi.spyOn(service, "fit").mockImplementation(() => {
    let resolve!: (value: EfaResult) => void;
    const promise = new Promise<EfaResult>((yes) => { resolve = yes; });
    const job: EfaJob<EfaResult> = {
      id: String(jobs.length), trace: new ComputeTrace(String(jobs.length)), promise,
      status: "running", progress: { stage: "test", completed: 0, total: 1 },
      // Deliberately permit a late completion after cancellation: the controller
      // must reject it even if a worker or transport does not stop in time.
      cancel: vi.fn(() => { job.status = "cancelled"; }),
    };
    jobs.push({ job, resolve: (value) => { if (job.status === "running") job.status = "completed"; resolve(value); } });
    return job;
  });
  const scores = vi.fn();
  const controller = new EfaController(service, () => ({
    context: () => context,
    state: (_id, _table, update) => { context = { ...context, state: update(context.state) }; },
    scores,
  }));
  const reviews = (columns: string[]) => Object.fromEntries(spec.items.map(({ column }) => [column, {
    status: columns.includes(column) ? "retain" : "exclude", note: "",
  } as ItemReview]));
  const preview = (columns: string[]) => {
    const changes = reviews(columns);
    controller.reviews(parent.id, changes);
    return controller.previewRefit(parent.id, columns, changes);
  };
  return { service, controller, jobs, parent, preview, reviews, scores, get: () => context,
    set: (patch: Partial<EfaContext>) => { context = { ...context, ...patch }; } };
}

it("keeps original rows/settings, stays ephemeral, and saves the completed numerical result once", async () => {
  const h = harness(), selected = table.columns.slice(1), pending = h.preview(selected);
  const [, candidateSpec, candidateRows] = vi.mocked(h.service.fit).mock.calls[0];
  expect(candidateSpec.items.map((item) => item.column)).toEqual(selected);
  expect(candidateSpec.sample.fixedRows).toEqual(result.fittingRows);
  expect(candidateRows).toEqual(result.fittingRows);
  expect(candidateSpec.nFactors).toBe(spec.nFactors);
  expect(candidateSpec.rotation).toBe(spec.rotation);
  expect(h.get().state.runs).toHaveLength(1);
  h.jobs[0].resolve(result);
  const candidate = await pending;
  expect(h.get().state.runs).toHaveLength(1);
  expect(candidate.parentId).toBe(h.parent.id);
  expect(candidate.scoreColumns).toEqual([]);
  expect(h.scores).not.toHaveBeenCalled();
  const notes = h.reviews(selected);
  notes[selected[0]] = { status: "investigate", note: "Content rationale added after completion" };
  h.controller.reviews(h.parent.id, notes);
  h.controller.cancelRefitPreview({ preserveCompleted: true });
  expect(await h.controller.saveRefitPreview(candidate.id, notes, "  Removed redundant content  ")).toBe(candidate.id);
  expect(h.service.fit).toHaveBeenCalledTimes(1);
  expect(h.get().state.runs).toHaveLength(2);
  expect(h.get().state.runs[1].result).toBe(candidate.result);
  expect(h.get().state.runs[1].reviews[selected[0]].note).toContain("after completion");
  expect(h.get().state.runs[1].reasons).toBe("Removed redundant content");
  await expect(h.controller.saveRefitPreview(candidate.id)).rejects.toThrow(/no completed/);
});

it("rejects late A after rapid A-to-B selection and permits re-including from the original pool", async () => {
  const h = harness(), a = h.preview(table.columns.slice(1));
  const rejectedA = expect(a).rejects.toThrow(/no longer current|not published/);
  h.controller.cancelRefitPreview();
  const b = h.preview(table.columns.slice(0, -1));
  h.jobs[0].resolve(result);
  h.jobs[1].resolve(result);
  await rejectedA;
  const candidate = await b;
  expect(h.jobs[0].job.cancel).toHaveBeenCalledOnce();
  expect(candidate.spec.items.map((item) => item.column)).toEqual(table.columns.slice(0, -1));
  expect(candidate.spec.items[0].column).toBe(table.columns[0]);
  expect(h.get().state.runs).toHaveLength(1);
});

it("invalidates during debounce, on invalid selection, and when live is turned off while still pending", async () => {
  for (const invalidate of [
    (h: ReturnType<typeof harness>) => h.controller.cancelRefitPreview(),
    (h: ReturnType<typeof harness>) => h.controller.cancelRefitPreview({ preserveCompleted: true }),
    async (h: ReturnType<typeof harness>) => {
      await expect(h.controller.previewRefit(h.parent.id, [table.columns[0]], {})).rejects.toThrow(/3 and 500/);
    },
  ]) {
    const h = harness(), pending = h.preview(table.columns.slice(1));
    const rejection = expect(pending).rejects.toThrow(/no longer current/);
    await invalidate(h);
    h.jobs[0].resolve(result);
    await rejection;
    expect(h.get().state.runs).toHaveLength(1);
  }
});

it("rejects saving after context changes, parent replacement, selection changes, or undo", async () => {
  for (const invalidate of [
    (h: ReturnType<typeof harness>) => h.set({ datasetId: 2 }),
    (h: ReturnType<typeof harness>) => h.set({ table: { ...table } }),
    (h: ReturnType<typeof harness>) => h.set({ filterKey: "changed" }),
    (h: ReturnType<typeof harness>) => h.set({ state: structuredClone(h.get().state) }),
    (h: ReturnType<typeof harness>) => h.controller.reviews(h.parent.id, h.reviews(table.columns)),
    (h: ReturnType<typeof harness>) => h.controller.cancel(),
  ]) {
    const h = harness(), pending = h.preview(table.columns.slice(1));
    h.jobs[0].resolve(result);
    const candidate = await pending;
    invalidate(h);
    await expect(h.controller.saveRefitPreview(candidate.id)).rejects.toThrow(/not published|no longer current|no completed/);
    expect(h.get().state.runs).toHaveLength(1);
  }
});

it("rejects changed inclusion on save and an active filter missing original rows", async () => {
  const h = harness(), pending = h.preview(table.columns.slice(1));
  h.jobs[0].resolve(result);
  const candidate = await pending;
  await expect(h.controller.saveRefitPreview(candidate.id, h.reviews(table.columns))).rejects.toThrow(/selected items changed/);
  h.set({ eligibleRows: rows.slice(1) });
  await expect(h.preview(table.columns)).rejects.toThrow(/original fitting rows/);
  expect(h.service.fit).toHaveBeenCalledTimes(1);
});
