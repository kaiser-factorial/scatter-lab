// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EfaResults } from "../EfaResults";
import { DEMO_SURVEY_WORDING, demoSurveySpec } from '../../lib/demo-survey';
import { rememberScores, scoreCaption } from '../../lib/efa/score-view';
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
function reviewToggle() {
  return Array.from(document.querySelectorAll('label')).find(label => label.textContent === 'Review instrument')!.querySelector<HTMLInputElement>('input')!;
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

async function renderResults(initial = baseline, itemWording?: Record<string, string>) {
  type Task = { columns: string[]; reviews: Record<string, ItemReview>; complete: () => EfaRun; reject: (error: Error) => void; candidate?: EfaRun };
  const tasks: Task[] = [];
  let current: Task | undefined;
  let updateState!: (update: (state: EfaState) => EfaState) => void;
  let select!: (id: string) => void;
  const onSelect = vi.fn((id: string) => select(id));
  const onPlotScores = vi.fn(async () => 'Plotted');
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
    const [state, setState] = useState<EfaState>({ ...emptyEfaState(), runs: [initial] });
    const [activeId, setActiveId] = useState(baseline.id);
    updateState = setState; select = setActiveId;
    return <EfaResults itemWording={itemWording} key={activeId} state={state} activeId={activeId} onSelect={onSelect} actions={actions} onPlotScores={onPlotScores} onClose={() => {}} table={table} />;
  }
  const mount = document.createElement("div"); document.body.append(mount);
  root = createRoot(mount);
  await act(async () => root!.render(<Harness />));
  const complete = async (index: number) => { let run!: EfaRun; await act(async () => { run = tasks[index].complete(); }); return run; };
  return { actions, tasks, onSelect, onPlotScores, complete };
}

it('plots the selected saved run in 2D by default and optionally includes F3', async () => {
  const threeSpec = { ...spec, nFactors: 3 };
  const result = baseline.result;
  const harness = await renderResults({ ...baseline, spec: threeSpec, result: {
    ...result, structure: result.structure.map(row => [...row, 0]), rotation: {
      ...result.rotation, pattern: result.rotation.pattern.map(row => [...row, 0]), phi: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    },
  } });
  await click(button('Plot respondent scores'));
  expect(harness.onPlotScores).toHaveBeenCalledWith('base', false);
  const toggle = Array.from(document.querySelectorAll('label')).find(label => label.textContent?.includes('Include F3'))!.querySelector('input')!;
  await click(toggle); await click(button('Plot respondent scores'));
  expect(harness.onPlotScores).toHaveBeenCalledWith('base', true);
});

it('shows both the original survey column and its question beside the fitted coefficients', async () => {
  await renderResults({ ...baseline, spec: demoSurveySpec() }, DEMO_SURVEY_WORDING);
  const table = document.querySelector('table[aria-label="pattern heatmap"]')!;
  expect(table.querySelectorAll('thead th')).toHaveLength(4);
  expect(table.querySelector('thead th:last-child')?.textContent).toContain('Pattern abs Δ');
  expect(table.querySelector('input, select')).toBeNull();
  for (const [column, question] of Object.entries(DEMO_SURVEY_WORDING)) {
    const row = Array.from(table.querySelectorAll('tbody tr')).find(tr => tr.querySelector('th')?.textContent === column + question)!;
    expect(row.querySelector('th')!.textContent).toBe(column + question);
    const values = baseline.result.rotation.pattern[Object.keys(DEMO_SURVEY_WORDING).indexOf(column)];
    expect(row.querySelector('td:last-child')?.textContent).toBe(Math.abs(Math.abs(values[0]) - Math.abs(values[1])).toFixed(3));
    expect(row.querySelector('td:last-child button')).toBeNull();
  }
});

it('keeps review decisions when returning to reading mode or switching result groups', async () => {
  const h = await renderResults();
  await click(reviewToggle());
  const note = document.querySelector<HTMLInputElement>(`input[aria-label="Note ${table.columns[0]}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(note, 'Check the item wording');
    note.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click(include(table.columns[0]));
  await click(reviewToggle());
  expect(document.querySelector('input[aria-label^="Include "]')).toBeNull();
  expect(document.querySelector('[role="status"]')?.textContent).toMatch(/selection changed/i);
  await click(button('Correlations'));
  expect(document.querySelector('select[aria-label="Correlation matrix"]')?.textContent).toBe('Item correlationsFactor correlationsResiduals');
  await click(button('Model checks'));
  expect(document.querySelector('select[aria-label="Model check"]')?.textContent).toBe('DiagnosticsPair countsResampling stability');
  await click(button('Loadings'));
  await click(reviewToggle());
  expect(include(table.columns[0]).checked).toBe(false);
  expect(document.querySelector<HTMLInputElement>(`input[aria-label="Note ${table.columns[0]}"]`)?.value).toBe('Check the item wording');
  expect(h.actions.previewRefit).not.toHaveBeenCalled();
});

it('counts only finite scores on the requested axes and identifies the source and estimator', () => {
  const run = { ...baseline, scoreColumns: ['first', 'second', 'third'] };
  const data = { nRows: 4, columns: run.scoreColumns, data: { first: [0, 1, null, 2], second: [1, -2, null, 3], third: [null, 0, null, 1] } };
  expect(scoreCaption('Survey', [run], data, run.scoreColumns.slice(0, 2), null)).toBeUndefined();
  rememberScores(data, run, run.scoreColumns);
  expect(scoreCaption('Survey', [run], data, run.scoreColumns.slice(0, 2), null)).toMatch(/Survey · UI fixture r1 · MINRES.*3 scored \/ 1 omitted/);
  expect(scoreCaption('Survey', [run], data, run.scoreColumns, [true, true, true, false])).toMatch(/1 scored \/ 2 omitted within filter/);
  expect(scoreCaption('Survey', [], data, run.scoreColumns, null)).toBeUndefined();
});

it("batches inclusion changes while live is off, then saves only the completed selected fit", async () => {
  const h = await renderResults();
  await click(reviewToggle());
  await click(include(table.columns[0]));
  await click(include(table.columns[1]));
  await advance(1000);
  expect(h.actions.previewRefit).not.toHaveBeenCalled();
  expect(button("Save score columns only").disabled).toBe(true);
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
  await click(reviewToggle());
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
  await click(reviewToggle());
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
  await click(reviewToggle());
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
  await click(reviewToggle());
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
  await click(reviewToggle());
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
  await click(reviewToggle());
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
