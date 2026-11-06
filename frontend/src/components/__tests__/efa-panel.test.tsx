// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EfaPanel, type EfaActions, type EfaSetup } from "../EfaPanel";
import { emptyEfaState } from "../../lib/efa/state";
import type { EfaSpec, ParallelResult } from "../../lib/efa/types";
import { EfaService } from "../../lib/efa/service";

const columns = ["A", "B", "C", "D", "E", "F"];
const table = { columns, nRows: 30, data: Object.fromEntries(columns.map((column, j) => [column,
  Array.from({ length: 30 }, (_, i) => i === 4 ? null : i * 0.23 + j),
])) };
const state = emptyEfaState(), service = new EfaService();
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
  await select("EFA correlations", "polychoric"); await extraction("wlsmv");
  await select("Missing values", missing);
  expect(document.querySelector<HTMLInputElement>("input[value='wlsmv']")?.checked).toBe(true);
  expect(document.querySelector<HTMLInputElement>("input[value='wlsmv']")?.disabled).toBe(false);
  for (const column of columns) await act(async () => {
    const label = Array.from(document.querySelectorAll("label")).find(el => el.textContent?.trim() === column)!;
    label.querySelector<HTMLInputElement>("input[type=checkbox]")!.click();
  });
  await click("Preview sample"); await click("Run EFA");
  expect(actions.run).toHaveBeenCalledWith(expect.objectContaining({ missing, extraction: "wlsmv", correlation: "polychoric" }));
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

it('offers ML instead of DWLS and passes the FIML hyperparameters without changing incompatible choices silently', async () => {
  const shared: EfaSetup = { label: 'Likelihood', selected: columns, missing: 'fiml' };
  const { actions } = await setup({ partition: 'all' }, shared);
  expect(document.querySelector("input[name='efa-extraction'][value='dwls']")).toBeNull();
  expect(button('Preview sample').disabled).toBe(true);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('FIML requires');
  await extraction('ml');
  for (const [label, value] of [['ML starts', '4'], ['ML maximum iterations', '1500'], ['ML tolerance', '0.000001'], ['ML uniqueness floor', '0.00001']]) {
    const field = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  await click('Preview sample'); await click('Run EFA');
  expect(actions.run).toHaveBeenLastCalledWith(expect.objectContaining({ extraction: 'ml', missing: 'fiml',
    likelihood: { starts: 4, maxIterations: 1500, tolerance: 1e-6, uniquenessFloor: 1e-5 } }));
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

it("preserves an external fitting sample across preview, run and parallel analysis while explicit parent scope takes precedence", async () => {
  const actions = { preview: vi.fn(async () => ({ nRows: 6, counts: columns.map(() => [6]) })),
    run: vi.fn(async () => "run"), parallel: vi.fn(async () => simulation) } as unknown as EfaActions;
  const fixed: EfaSpec["sample"] = { partition: "all", fixedRows: [0, 1, 2, 3, 5, 6] };
  const development: EfaSpec["sample"] = { splitId: "saved", partition: "development" };
  const holdout: EfaSpec["sample"] = { splitId: "saved", partition: "holdout" };
  const spec: EfaSpec = { label: "Captured sample", items: columns.map(column => ({ column, measurement: "continuous", categories: [], reverse: false })),
    correlation: "pearson", missing: "mean", extraction: "minres", rotation: "promax", nFactors: 2, seed: 41, sample: fixed };
  const shared: EfaSetup = { label: spec.label, selected: columns, missing: spec.missing,
    measurements: Object.fromEntries(columns.map(column => [column, "continuous" as const])) };
  const mount = document.createElement("div"); document.body.append(mount); root = createRoot(mount);
  const render = async (seq: number, externalSample: EfaSpec["sample"], parentSample?: EfaSpec["sample"]) => {
    await act(async () => root!.render(<EfaPanel service={service} table={table} state={state} actions={actions}
      setup={shared} sample={parentSample} externalSpec={{ seq, spec: { ...spec, sample: externalSample } }} />));
  };
  await render(1, fixed);
  expect(document.querySelector('[aria-label="EFA sample scope"]')?.textContent).toBe("Fitting scope: 6 fixed rows");
  await click("Preview sample"); await click("Run EFA"); await click("Run parallel analysis");
  expect(actions.preview).toHaveBeenLastCalledWith(expect.objectContaining({ sample: fixed }));
  expect(actions.run).toHaveBeenLastCalledWith(expect.objectContaining({ sample: fixed }));
  expect(actions.parallel).toHaveBeenLastCalledWith(expect.objectContaining({ sample: fixed }), 100);
  expect(document.querySelector("figure[aria-label='Parallel analysis histogram']")).not.toBeNull();
  await render(1, { ...fixed, fixedRows: fixed.fixedRows!.slice() });
  expect(button("Run EFA").disabled).toBe(false);

  await render(2, development);
  expect(document.querySelector('[aria-label="EFA sample scope"]')?.textContent).toBe("Fitting scope: Development partition");
  expect(button("Run EFA").disabled).toBe(true);
  expect(document.querySelector("figure[aria-label='Parallel analysis histogram']")).toBeNull();
  await click("Preview sample"); await click("Run EFA"); await click("Run parallel analysis");
  expect(actions.run).toHaveBeenLastCalledWith(expect.objectContaining({ sample: development }));
  expect(actions.parallel).toHaveBeenLastCalledWith(expect.objectContaining({ sample: development }), 100);

  await render(2, development, holdout);
  expect(document.querySelector('[aria-label="EFA sample scope"]')?.textContent).toBe("Fitting scope: Holdout partition");
  expect(button("Run EFA").disabled).toBe(true);
  expect(document.querySelector("figure[aria-label='Parallel analysis histogram']")).toBeNull();
  await click("Preview sample"); await click("Run EFA"); await click("Run parallel analysis");
  expect(actions.preview).toHaveBeenLastCalledWith(expect.objectContaining({ sample: holdout }));
  expect(actions.run).toHaveBeenLastCalledWith(expect.objectContaining({ sample: holdout }));
  expect(actions.parallel).toHaveBeenLastCalledWith(expect.objectContaining({ sample: holdout }), 100);

  await render(2, development, { partition: "all" });
  expect(document.querySelector('[aria-label="EFA sample scope"]')).toBeNull();
  expect(button("Run EFA").disabled).toBe(true);
  await click("Preview sample");
  expect(actions.preview).toHaveBeenLastCalledWith(expect.objectContaining({ sample: { partition: "all" } }));
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

it("applies the adviser's extraction and correlation together without fitting and requires a fresh preview", async () => {
  const shared: EfaSetup = { label: "Suggested", selected: columns, missing: "median" };
  const { actions, render } = await setup({ partition: "all" }, shared);
  await click("Preview sample");
  expect(button("Run EFA").disabled).toBe(false);
  await render({ partition: "all" }, { ...shared, missing: "fiml", advice: { seq: 1, patch: { correlation: "pearson", extraction: "ml", missing: "fiml" } } });
  expect(document.querySelector<HTMLSelectElement>("select[aria-label='EFA correlations']")?.value).toBe("pearson");
  expect(document.querySelector<HTMLInputElement>("input[value='ml']")?.checked).toBe(true);
  expect(button("Run EFA").disabled).toBe(true);
  expect(actions.run).not.toHaveBeenCalled();
  await click("Preview sample"); await click("Run EFA");
  expect(actions.run).toHaveBeenLastCalledWith(expect.objectContaining({ correlation: "pearson", extraction: "ml", missing: "fiml" }));
  // Ordinary parent renders must not reapply advice over a later manual choice.
  await extraction("minres");
  await render({ partition: "all" }, { ...shared, advice: { seq: 1, patch: { correlation: "pearson", extraction: "ml" } } });
  expect(document.querySelector<HTMLInputElement>("input[value='minres']")?.checked).toBe(true);
});
