// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DecompositionSetup, type SharedAnalysisSetup } from "../DecompositionSetup";

const columns = ["ResponseId", "itemA", "other", "itemB", "itemC", "itemD", "description", "PC1", "Cluster", "savedFactor"];
const table = {
  columns, nRows: 8,
  data: Object.fromEntries(columns.map(column => [column, Array.from({ length: 8 }, (_, i) => column === "description" ? `text ${i}` : i % 4 + 1)])),
};
let root: Root | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren(); vi.unstubAllGlobals(); });

function control<T extends HTMLElement>(label: string) {
  const element = document.querySelector<T>(`[aria-label="${label}"]`);
  if (!element) throw new Error(`Missing control: ${label}`);
  return element;
}
function button(label: string) {
  const element = Array.from(document.querySelectorAll("button")).find(button => button.textContent?.trim() === label);
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
}
async function click(element: HTMLElement, shiftKey = false) {
  await act(async () => element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey })));
}
async function input(label: string, value: string) {
  const element = control<HTMLInputElement>(label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function select(label: string, value: string) {
  const element = control<HTMLSelectElement>(label);
  await act(async () => { element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); });
}
function current(): SharedAnalysisSetup {
  return JSON.parse(document.querySelector("output")!.textContent!);
}
async function mount() {
  function Harness() {
    const [method, setMethod] = useState<"pca" | "efa">("pca");
    return <DecompositionSetup table={table} method={method} onMethodChange={setMethod} ownedScores={["savedFactor"]}>
      {setup => <output>{JSON.stringify(setup)}</output>}
    </DecompositionSetup>;
  }
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<Harness />));
}

it("orders the shared controls and excludes identifiers from default/all selection while allowing manual selection", async () => {
  await mount();
  const ordered = [control("Run label"), control("Analysis items"), control("Analysis method"), control("Missing values")];
  ordered.slice(0, -1).forEach((element, i) => expect(element.compareDocumentPosition(ordered[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy());
  expect(current().selected).toEqual(["itemA", "other", "itemB", "itemC", "itemD"]);
  expect(control<HTMLInputElement>("Select ResponseId").checked).toBe(false);
  expect(document.querySelector('[aria-label="Select PC1"]')).toBeNull();
  expect(document.querySelector('[aria-label="Select Cluster"]')).toBeNull();
  expect(document.querySelector('[aria-label="Select savedFactor"]')).toBeNull();
  await click(control("Select ResponseId"));
  expect(current().selected).toContain("ResponseId");
  await click(button("none")); expect(current().selected).toEqual([]);
  await click(button("all")); expect(current().selected).toEqual(["itemA", "other", "itemB", "itemC", "itemD"]);
});

it("selects and clears the intermediate items using native Shift-click events", async () => {
  await mount(); await click(button("none"));
  await click(control("Select itemA")); await click(control("Select itemD"), true);
  expect(current().selected).toEqual(["itemA", "other", "itemB", "itemC", "itemD"]);
  await click(control("Select itemB")); await click(control("Select itemD"), true);
  expect(current().selected).toEqual(["itemA", "other"]);
  await click(control("Select itemD")); await click(control("Select itemB"), true);
  expect(current().selected).toEqual(["itemA", "other", "itemB", "itemC", "itemD"]);
});

it("limits ranges to visible items and resets the range anchor when filtering", async () => {
  await mount(); await click(button("none"));
  await click(control("Select other"));
  await input("Find analysis items", "item");
  await click(control("Select itemD"), true);
  expect(current().selected).toEqual(["other", "itemD"]);
  await click(control("Select itemA")); await click(control("Select itemC"), true);
  expect(current().selected).toEqual(["itemA", "other", "itemB", "itemC", "itemD"]);
  await click(button("none"));
  await click(control("Select itemA")); await click(control("Select itemC"), true);
  expect(current().selected).toEqual(["itemA", "itemB", "itemC"]);
});

it("preserves setup across methods and exposes all missing methods except iterative PCA for EFA", async () => {
  await mount();
  const allMissing = ["pairwise", "complete", "mean", "median", "mice", "iterative"];
  expect(Array.from(control<HTMLSelectElement>("Missing values").options, option => option.value)).toEqual(allMissing);
  expect(button("PCA").getAttribute("aria-pressed")).toBe("true");
  await input("Run label", "Custom run"); await click(control("Select itemB")); await select("Missing values", "mean");
  const previous = current();
  await click(button("EFA"));
  expect(current()).toEqual(previous);
  expect(button("EFA").getAttribute("aria-pressed")).toBe("true");
  expect(button("PCA").getAttribute("aria-pressed")).toBe("false");
  expect(Array.from(control<HTMLSelectElement>("Missing values").options, option => option.value)).toEqual(allMissing.slice(0, -1));
  for (const method of allMissing.slice(0, -1)) { await select("Missing values", method); expect(current().missing).toBe(method); }
  await click(button("PCA")); await select("Missing values", "iterative"); await click(button("EFA"));
  expect(current().missing).toBe("median");
  expect(current().label).toBe("Custom run"); expect(current().selected).toEqual(previous.selected);
});

it("delivers per-item measurement overrides to the selected analysis", async () => {
  await mount();
  await select("Item type itemA", "continuous"); await select("Item type itemB", "ordinal");
  expect(current().measurements).toEqual({ itemA: "continuous", itemB: "ordinal" });
  await click(button("EFA"));
  expect(current().measurements).toEqual({ itemA: "continuous", itemB: "ordinal" });
  await select("Item type itemA", "auto"); expect(current().measurements.itemA).toBe("auto");
});
