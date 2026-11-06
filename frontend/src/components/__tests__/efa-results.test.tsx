// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EfaResults } from "../EfaResults";
import type { EfaActions } from "../EfaPanel";
import { prepareEfa } from "../../lib/efa/prepare";
import { correlate } from "../../lib/efa/correlation";
import { fitEfa } from "../../lib/efa/fit";
import { emptyEfaState } from "../../lib/efa/state";
import type { EfaRun, EfaSpec, EfaState, ItemReview } from "../../lib/efa/types";
import fixture from "../../lib/__tests__/fixtures/efa/mixed.input.json";

const table = fixture;
const spec: EfaSpec = {
  items: table.columns.map((column, i) => ({ column, categories: table.categories[i], reverse: false })),
  nFactors: 2, rotation: "oblimin", missing: "pairwise", label: "UI fixture", seed: 73021,
  sample: { partition: "all" },
};
const rows = Array.from({ length: table.nRows }, (_, i) => i);
const prepared = prepareEfa(table, spec, rows);
const baseline: EfaRun = {
  id: "base", revision: 1, createdAt: "2026-11-06", datasetRevision: "fixture",
  spec, result: fitEfa(prepared, correlate(prepared), spec), eligibleRows: rows,
  kind: "fit", reviews: {}, reviewRevision: 0, reasons: "", revisedAfterHoldout: false, scoreColumns: [],
};
let root: Root | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class {
    observe() {} unobserve() {} disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(() => {});
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function button(name: string) {
  const found = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((node) => node.textContent?.trim() === name);
  if (!found) throw new Error("Missing button: " + name);
  return found;
}
function include(column: string) {
  const found = document.querySelector<HTMLInputElement>(`input[aria-label="Include ${column}"]`);
  if (!found) throw new Error("Missing inclusion control: " + column);
  return found;
}
function live() {
  const label = Array.from(document.querySelectorAll("label")).find((node) => node.textContent === "Live refit");
  const found = label?.querySelector<HTMLInputElement>("input");
  if (!found) throw new Error("Missing live toggle");
  return found;
}
function displayedItems() {
  return Array.from(document.querySelectorAll<HTMLInputElement>("tbody th input[aria-label^='Include ']"))
    .map((node) => node.getAttribute("aria-label")!.slice("Include ".length));
}
const click = async (element: HTMLElement) => { await act(async () => element.click()); };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

async function renderResults() {
  type Task = { columns: string[]; reviews: Record<string, ItemReview>; complete: () => EfaRun; reject: (error: Error) => void; candidate?: EfaRun };
  const tasks: Task[] = [];
  let current: Task | undefined;
  let updateState!: (update: (state: EfaState) => EfaState) => void;
  let select!: (id: string) => void;
  const onSelect = vi.fn((id: string) => select(id));
  const actions: EfaActions = {
    previewRefit: vi.fn((_parentId, columns, reviews) => {
      let resolve!: (run: EfaRun) => void, reject!: (error: Error) => void;
      const promise = new Promise<EfaRun>((yes, no) => { resolve = yes; reject = no; });
      const task: Task = {
        columns: columns.slice(), reviews: structuredClone(reviews), reject,
        complete: () => {
          const candidateSpec = { ...spec, items: spec.items.filter((item) => columns.includes(item.column)), sample: { ...spec.sample, fixedRows: rows } };
          const data = prepareEfa(table, candidateSpec, rows);
          const candidate: EfaRun = {
            ...baseline, id: "candidate-" + tasks.indexOf(task), parentId: baseline.id, kind: "items",
            spec: candidateSpec, result: fitEfa(data, correlate(data), candidateSpec), reviews: task.reviews,
          };
          task.candidate = candidate;
          // Intentionally resolve cancelled tasks too, exercising the UI's own
          // sequence guard independently of the controller's guards.
          resolve(candidate);
          return candidate;
        },
      };
      tasks.push(task); current = task;
      return promise;
    }),
    cancelRefitPreview: vi.fn((options) => { if (!options?.preserveCompleted || !current?.candidate) current = undefined; }),
    saveRefitPreview: vi.fn(async (id, reviews) => {
      const completed = current?.candidate;
      if (!completed || completed.id !== id) throw new Error("stale candidate");
      const candidate = { ...completed, reviews: reviews ?? completed.reviews };
      updateState((state) => ({ ...state, runs: [...state.runs, candidate] }));
      current = undefined;
      return id;
    }),
    reviews: vi.fn((id, reviews) => updateState((state) => ({
      ...state, runs: state.runs.map((run) => run.id === id ? { ...run, reviews: structuredClone(reviews), reviewRevision: (run.reviewRevision ?? 0) + 1 } : run),
    }))),
    openHoldout: vi.fn(), cancel: vi.fn(), addScores: vi.fn(async () => "scores"),
    run: vi.fn(async () => "run"), stability: vi.fn(async () => "stability"),
    impute: vi.fn(async () => "impute"), imputationReviews: vi.fn(),
    parallel: vi.fn(async () => { throw new Error("Not exercised"); }),
    preview: vi.fn(async () => { throw new Error("Not exercised"); }),
    split: vi.fn(() => { throw new Error("Not exercised"); }),
  };
  function Harness() {
    const [state, setState] = useState<EfaState>({ ...emptyEfaState(), runs: [baseline] });
    const [activeId, setActiveId] = useState(baseline.id);
    updateState = setState; select = setActiveId;
    return <EfaResults key={activeId} state={state} activeId={activeId} onSelect={onSelect} actions={actions} onClose={() => {}} table={table} />;
  }
  const mount = document.createElement("div"); document.body.append(mount);
  root = createRoot(mount);
  await act(async () => root!.render(<Harness />));
  const complete = async (index: number) => { let run!: EfaRun; await act(async () => { run = tasks[index].complete(); }); return run; };
  return { actions, tasks, onSelect, complete };
}

it("batches inclusion changes while live is off, then saves only the completed selected fit", async () => {
  const h = await renderResults();
  await click(include(table.columns[0]));
  await click(include(table.columns[1]));
  await advance(1000);
  expect(h.actions.previewRefit).not.toHaveBeenCalled();
  expect(button("Add scores to dataset").disabled).toBe(true);
  expect(button("Save candidate").disabled).toBe(true);
  await click(button("Refit now"));
  expect(h.tasks[0].columns).toEqual(table.columns.slice(2));
  const candidate = await h.complete(0);
  expect(candidate.result.fittingRows).toEqual(rows);
  expect(displayedItems()).toEqual(table.columns.slice(2));
  expect(button("Save candidate").disabled).toBe(false);
  await click(button("Save candidate"));
  expect(vi.mocked(h.actions.saveRefitPreview).mock.calls[0].slice(0, 2)).toEqual([candidate.id, expect.objectContaining({
    [table.columns[0]]: expect.objectContaining({ status: "exclude" }),
    [table.columns[1]]: expect.objectContaining({ status: "exclude" }),
  })]);
  expect(h.onSelect).toHaveBeenCalledWith(candidate.id);
  expect(h.actions.previewRefit).toHaveBeenCalledTimes(1);
});

it("a manual refit supersedes its pending debounce instead of starting a second job", async () => {
  const h = await renderResults();
  await click(live()); await click(include(table.columns[0]));
  await advance(200); await click(button("Refit now"));
  expect(h.tasks).toHaveLength(1);
  await advance(800);
  expect(h.tasks).toHaveLength(1);
  await h.complete(0);
  await advance(1000);
  expect(h.tasks).toHaveLength(1);
});

it("debounces the final rapid selection and ignores a late obsolete completion", async () => {
  const h = await renderResults();
  await click(live()); await click(include(table.columns[0]));
  await advance(400);
  expect(h.tasks).toHaveLength(1);
  await click(include(table.columns[1])); await click(include(table.columns[0]));
  await advance(399); expect(h.tasks).toHaveLength(1);
  await advance(1); expect(h.tasks).toHaveLength(2);
  const selected = table.columns.filter((column) => column !== table.columns[1]);
  expect(h.tasks[1].columns).toEqual(selected);
  const current = await h.complete(1);
  expect(displayedItems()).toEqual(selected);
  await h.complete(0);
  expect(displayedItems()).toEqual(selected);
  expect(button("Save candidate").disabled).toBe(false);
  await click(button("Save candidate"));
  expect(vi.mocked(h.actions.saveRefitPreview).mock.calls[0].slice(0, 2)).toEqual([current.id, expect.any(Object)]);
});

it("cannot save an invalidated candidate after editing away and back to its old selection", async () => {
  const h = await renderResults();
  await click(include(table.columns[0])); await click(button("Refit now"));
  await h.complete(0);
  expect(button("Save candidate").disabled).toBe(false);
  await click(include(table.columns[0])); await click(include(table.columns[0]));
  expect(button("Save candidate").disabled).toBe(true);
  expect(button("Refit now").disabled).toBe(false);
  await click(button("Save candidate"));
  expect(h.actions.saveRefitPreview).not.toHaveBeenCalled();
  await click(button("Refit now")); await h.complete(1);
  expect(button("Save candidate").disabled).toBe(false);
});

it("turning live off cancels pending work but preserves a completed current candidate", async () => {
  const h = await renderResults();
  await click(live()); await click(include(table.columns[0])); await advance(400);
  await click(live()); await h.complete(0);
  expect(displayedItems()).toEqual(table.columns);
  expect(button("Save candidate").disabled).toBe(true);
  await advance(1000); expect(h.tasks).toHaveLength(1);
  await click(button("Refit now")); const current = await h.complete(1);
  await click(live()); await click(live());
  expect(button("Save candidate").disabled).toBe(false);
  await click(button("Save candidate"));
  expect(vi.mocked(h.actions.saveRefitPreview).mock.calls[0].slice(0, 2)).toEqual([current.id, expect.any(Object)]);
});

it("a failed live fit does not retry continuously without another edit or explicit retry", async () => {
  const h = await renderResults();
  await click(live()); await click(include(table.columns[0])); await advance(400);
  await act(async () => h.tasks[0].reject(new Error("Numerical failure")));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Numerical failure");
  await advance(3000);
  expect(h.tasks).toHaveLength(1);
  expect(button("Refit now").disabled).toBe(false);
  await click(button("Refit now"));
  expect(h.tasks).toHaveLength(2);
});

it("synchronizes external review changes, invalidates their older fit, and keeps later notes without another fit", async () => {
  const h = await renderResults();
  await click(live()); await click(include(table.columns[0])); await advance(400);
  const reviews: Record<string, ItemReview> = {
    [table.columns[0]]: { status: "retain", note: "" },
    [table.columns[1]]: { status: "exclude", note: "External content review" },
  };
  await act(async () => h.actions.reviews(baseline.id, reviews));
  await advance(400);
  expect(h.tasks).toHaveLength(2);
  await h.complete(0);
  expect(displayedItems()).toEqual(table.columns);
  const candidate = await h.complete(1);
  expect(displayedItems()).toEqual(table.columns.filter((column) => column !== table.columns[1]));
  const withNote = { ...reviews, [table.columns[2]]: { status: "investigate" as const, note: "Added after the numerical fit" } };
  await act(async () => h.actions.reviews(baseline.id, withNote));
  await advance(1000);
  expect(h.tasks).toHaveLength(2);
  await click(button("Save candidate"));
  expect(vi.mocked(h.actions.saveRefitPreview).mock.calls[0].slice(0, 2)).toEqual([candidate.id, withNote]);
});
