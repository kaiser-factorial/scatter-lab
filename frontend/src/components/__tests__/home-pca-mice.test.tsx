// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DataTable } from "../../lib/table";
import type { PCAResult } from "../../lib/pca";

// Keep the real shared setup, Home's analysis gate, score application, and
// workspace serialization. Replace rendering-heavy surfaces and external IO.
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "primary", setTheme: vi.fn() }) }));
vi.mock("ccru/components", () => ({ CyberStackGroup: () => null, CyberContainer: () => null, CyberPanel: () => null }));
vi.mock("puxel", () => ({
  Accordion: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AccordionItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Separator: () => null,
}));
vi.mock("../../lib/assistant", async importOriginal => ({
  ...await importOriginal<typeof import("../../lib/assistant")>(), paintYield: async () => {},
}));
vi.mock("../../lib/parse", () => ({ readTable: vi.fn(), listSheets: vi.fn(async () => []) }));
vi.mock("../../lib/workspaces", async importOriginal => ({
  ...await importOriginal<typeof import("../../lib/workspaces")>(),
  loadSession: vi.fn(async () => null), listWorkspaces: vi.fn(async () => []),
  saveSession: vi.fn(async () => {}), saveWorkspace: vi.fn(async () => {}),
}));
vi.mock("../../lib/pca-imputation", () => ({ runPcaImputations: vi.fn() }));

import Home from "../../app/page";
import { readTable } from "../../lib/parse";
import { saveWorkspace } from "../../lib/workspaces";
import { runPCA } from "../../lib/pca";
import { runPcaImputations, type PcaImputationBatch } from "../../lib/pca-imputation";

const columns = ["A", "B", "C"];
const table: DataTable = {
  columns, nRows: 24,
  data: {
    A: Array.from({ length: 24 }, (_, i) => i === 1 ? null : i % 4 + 1),
    B: Array.from({ length: 24 }, (_, i) => i === 2 ? null : Math.floor(i / 2) % 4 + 1),
    C: Array.from({ length: 24 }, (_, i) => i === 3 ? null : (i * 3 + Math.floor(i / 4)) % 4 + 1),
  },
};
type Saved = { activeId: number; datasets: { id: number; table: string; pcaRuns?: { missing: PCAResult["missing"] }[] }[]; tables: Record<string, DataTable> };
let root: Root | undefined;
let returnedBatch: PcaImputationBatch;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key), clear: () => stored.clear(),
  });
  vi.mocked(readTable).mockResolvedValue({ table: structuredClone(table), warnings: [] });
  vi.mocked(saveWorkspace).mockClear();
  vi.mocked(runPcaImputations).mockReset().mockImplementation(async (source, variables, options = {}) => {
    // Two small, explicitly constructed completions use real PCA computations.
    // This test exercises the UI's batch/selection workflow, not MICE numerics.
    const completed = [1, 4].map((fill, index) => {
      const filled = { ...source, data: Object.fromEntries(Object.entries(source.data).map(([column, values]) => [column, values.map(value => value === null ? fill : value)])) };
      const fit = runPCA(filled, variables, { ...options, missing: "complete" });
      const result: PCAResult = {
        ...fit,
        table: { ...fit.table, data: { ...fit.table.data, ...source.data } },
        missing: { ...fit.missing, strategy: "mice", imputation: index + 1, imputations: 2, seed: options.seed, imputedCells: 3 },
      };
      return { imputation: index + 1, result };
    });
    returnedBatch = {
      variables: variables.slice(), requested: 2, completed, failures: [], trace: [],
      settings: { k: options.k, standardize: options.standardize ?? true, label: options.label ?? "", measurements: options.measurements,
        imputations: 2, iterations: options.iterations ?? 2, seed: options.seed ?? 73021, predictorEncoding: "ordered-polynomial", predictors: [[1, 2], [0, 2], [0, 1]] },
      provenance: { method: "UI test fixture with separately computed PCA fits", execution: "main-thread", scoring: "Explicitly selected fit" },
    };
    await Promise.resolve();
    return returnedBatch;
  });
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren();
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
function button(text: string) {
  const found = Array.from(document.querySelectorAll("button")).find(element => element.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
async function click(text: string) { await act(async () => button(text).click()); }
async function input(selector: string, value: string) {
  const element = document.querySelector<HTMLInputElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function select(label: string, value: string) {
  const element = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  await act(async () => { element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function save() {
  await input('input[placeholder="Workspace name"]', "MICE integration"); await click("Save");
  const state = vi.mocked(saveWorkspace).mock.calls.at(-1)![1] as Saved;
  const dataset = state.datasets.find(dataset => dataset.id === state.activeId)!;
  return { dataset, table: state.tables[dataset.table] };
}
async function uploadAndRun() {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<Home />));
  const upload = document.querySelector<HTMLInputElement>('[data-guide="upload-dropzone"] input[type="file"]')!;
  Object.defineProperty(upload, "files", { configurable: true, value: [new File(["fixture"], "responses.csv", { type: "text/csv" })] });
  await act(async () => upload.dispatchEvent(new Event("change", { bubbles: true })));
  for (const text of ["Skip — my data has none", "No — use the full dataset"]) {
    const choice = Array.from(document.querySelectorAll("label")).find(element => element.textContent?.includes(text))!.querySelector("input")!;
    await act(async () => choice.click());
  }
  await click("Add dataset");
  await input('input[aria-label="Run label"]', "MICE trial");
  await input('input[aria-label="PCA component count"]', "2");
  await select("Item type A", "ordinal"); await select("Missing values", "mice");
  await input('input[aria-label="PCA MICE imputations"]', "2");
  await click("Run MICE + PCA");
}

it("forwards shared measurement choices and adds only the explicitly selected MICE fit's scores", async () => {
  await uploadAndRun();
  expect(runPcaImputations).toHaveBeenCalledOnce();
  expect(runPcaImputations).toHaveBeenCalledWith(expect.objectContaining({ nRows: 24 }), columns,
    expect.objectContaining({ label: "MICE_trial", k: 2, imputations: 2, measurements: { A: "ordinal" } }));
  expect(button("Add scores from selected fit").disabled).toBe(false);
  const before = await save();
  expect(before.table).toEqual(table);
  expect(before.dataset.pcaRuns ?? []).toHaveLength(0);
  const second = returnedBatch.completed[1].result;
  expect(second.table.data[second.columns[0]]).not.toEqual(returnedBatch.completed[0].result.table.data[second.columns[0]]);
  await select("PCA imputation result", "2"); await click("Add scores from selected fit");
  const after = await save();
  expect(after.table.columns).toEqual([...columns, ...second.columns]);
  for (const column of second.columns) expect(after.table.data[column]).toEqual(second.table.data[column]);
  for (const column of columns) expect(after.table.data[column]).toEqual(table.data[column]);
  expect(after.dataset.pcaRuns?.[0].missing).toMatchObject({ strategy: "mice", imputation: 2 });
});

it("disables applying a completed batch after shared inputs change", async () => {
  await uploadAndRun();
  expect(button("Add scores from selected fit").disabled).toBe(false);
  await select("Item type A", "continuous");
  expect(button("Add scores from selected fit").disabled).toBe(true);
  await click("Add scores from selected fit");
  expect((await save()).table).toEqual(table);
  await select("Item type A", "ordinal");
  expect(button("Add scores from selected fit").disabled).toBe(false);
  await input('input[aria-label="Run label"]', "Different run");
  expect(button("Add scores from selected fit").disabled).toBe(true);
  expect((await save()).table).toEqual(table);
  expect(runPcaImputations).toHaveBeenCalledOnce();
});
