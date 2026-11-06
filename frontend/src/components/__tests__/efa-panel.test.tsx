// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EfaPanel, type EfaActions, type EfaSetup } from "../EfaPanel";
import { emptyEfaState } from "../../lib/efa/state";
import type { EfaSpec, ParallelResult } from "../../lib/efa/types";
import type { EfaService } from "../../lib/efa/service";

const columns = ["A", "B", "C", "D", "E", "F"];
const table = { columns, nRows: 30, data: Object.fromEntries(columns.map((column, j) => [column,
  Array.from({ length: 30 }, (_, i) => i === 4 ? null : i * 0.23 + j),
])) };
const state = emptyEfaState(), service = {} as EfaService;
let root: Root | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren(); vi.unstubAllGlobals(); });
function button(label: string) {
  const found = Array.from(document.querySelectorAll("button")).find(element => element.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function select(label: string, value: string) {
  const element = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  if (!element) throw new Error(`Missing select: ${label}`);
  await act(async () => { element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function extraction(method: string) {
  const element = document.querySelector<HTMLInputElement>(`input[name='efa-extraction'][value='${method}']`)!;
  await act(async () => element.click());
}
const simulation: ParallelResult = { seed: 73021, requested: 100, completed: 2, percentile: .95, observed: [2, .5, -.1], nullEigenvalues: [[.8, .2, -.2], [1, .4, -.1]], reference: [.99, .39, -.105], failures: [], suggested: 2 };
async function setup(initialSample: EfaSpec["sample"] = { partition: "all" }, controlled?: EfaSetup) {
  const actions = { preview: vi.fn(async () => ({ nRows: 30, counts: columns.map(() => [29]) })), run: vi.fn(async () => "run"), parallel: vi.fn(async () => simulation) } as unknown as EfaActions;
  const mount = document.createElement("div"); document.body.append(mount); root = createRoot(mount);
  const render = async (sample = initialSample, shared = controlled, contextKey = "") => {
    await act(async () => root!.render(<EfaPanel service={service} table={table} state={state} actions={actions} sample={sample} setup={shared} contextKey={contextKey} />));
  };
  await render(); return { actions, render };
}

it.each(["mean", "median"] as const)("keeps missing %s independent of the explicit correlation/extraction choice", async missing => {
  const { actions } = await setup();
  await select("EFA correlations", "polychoric"); await extraction("dwls");
  await select("Missing values", missing);
  expect(document.querySelector<HTMLInputElement>("input[value='dwls']")?.checked).toBe(true);
  expect(document.querySelector<HTMLInputElement>("input[value='dwls']")?.disabled).toBe(false);
  for (const column of columns) await act(async () => {
    const label = Array.from(document.querySelectorAll("label")).find(el => el.textContent?.trim() === column)!;
    label.querySelector<HTMLInputElement>("input[type=checkbox]")!.click();
  });
  await click("Preview sample"); await click("Run EFA");
  expect(actions.run).toHaveBeenCalledWith(expect.objectContaining({ missing, extraction: "dwls", correlation: "polychoric" }));
});

it("uses the shared label and item setup without rendering duplicate controls", async () => {
  const shared: EfaSetup = { label: "Reasoning", selected: columns, missing: "median", measurements: { A: "continuous" } };
  const { actions, render } = await setup({ partition: "all" }, shared);
  expect(document.querySelector("input[aria-label='Find EFA items']")).toBeNull();
  expect(document.querySelector("select[aria-label='Missing values']")).toBeNull();
  expect(document.querySelector<HTMLInputElement>("input[value='minres']")?.checked).toBe(true);
  await click("Preview sample"); await click("Run EFA");
  expect(actions.run).toHaveBeenCalledWith(expect.objectContaining({ label: "Reasoning", missing: "median", correlation: "auto", items: expect.arrayContaining([expect.objectContaining({ column: "A", measurement: "continuous" })]) }));
  await render({ partition: "all" }, shared, "new-row-filter");
  expect(button("Run EFA").disabled).toBe(true);
});

it("places rotation radios directly after extraction and defaults new runs to Promax", async () => {
  const { actions } = await setup({ partition: "all" }, { label: "Rotations", selected: columns, missing: "median" });
  const group = document.querySelector<HTMLElement>('[role="radiogroup"][aria-label="EFA rotation"]')!;
  expect(group.previousElementSibling?.querySelector("legend")?.textContent).toBe("Extraction");
  expect(Array.from(group.querySelectorAll("label"), label => label.textContent?.trim())).toEqual(["Promax", "Oblimin", "Varimax"]);
  expect(group.querySelector<HTMLInputElement>('input[value="promax"]')?.checked).toBe(true);
  expect(Array.from(document.querySelectorAll("select option")).some(option => ["promax", "oblimin", "varimax"].includes((option as HTMLOptionElement).value))).toBe(false);
  for (const rotation of ["promax", "oblimin", "varimax"]) {
    if (rotation !== "promax") {
      await act(async () => group.querySelector<HTMLInputElement>(`input[value="${rotation}"]`)!.click());
      expect(button("Run EFA").disabled).toBe(true);
    }
    await click("Preview sample"); await click("Run EFA");
    expect(actions.run).toHaveBeenLastCalledWith(expect.objectContaining({ rotation }));
  }
});

it("invalidates a preview when the parent changes the fitting sample", async () => {
  const development = { splitId: "saved", partition: "development" } as const, holdout = { splitId: "saved", partition: "holdout" } as const;
  const { actions, render } = await setup(development);
  await select("Missing values", "mean"); await select("EFA correlations", "pearson"); await click("Select numeric columns"); await click("Preview sample");
  expect(actions.preview).toHaveBeenLastCalledWith(expect.objectContaining({ sample: development }));
  expect(button("Run EFA").disabled).toBe(false);
  await render(holdout); expect(button("Run EFA").disabled).toBe(true);
  await click("Run EFA"); expect(actions.run).not.toHaveBeenCalled();
  await click("Preview sample"); await click("Run EFA");
  expect(actions.run).toHaveBeenLastCalledWith(expect.objectContaining({ sample: holdout }));
});

it("shows the actual parallel histogram only for matching current inputs", async () => {
  const shared: EfaSetup = { label: "PA", selected: columns, missing: "mean" };
  const { actions, render } = await setup({ partition: "all" }, shared);
  await click("Run parallel analysis");
  expect(actions.parallel).toHaveBeenCalledWith(expect.objectContaining({ nFactors: 1 }), 100);
  expect(document.querySelector("figure[aria-label='Parallel analysis histogram']")).not.toBeNull();
  await render({ partition: "all" }, { ...shared, missing: "median" });
  expect(document.querySelector("figure[aria-label='Parallel analysis histogram']")).toBeNull();
});
