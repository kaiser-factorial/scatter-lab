// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DatasetSplitControls, DEFAULT_DATASET_SPLIT } from "../DatasetSplitControls";
import { DatasetDialog } from "../DatasetDialog";
import { createDatasetPartitions, type DatasetSplitOptions } from "../../lib/datasetSplit";

let root: Root | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const click = async (element: HTMLElement) => { await act(async () => element.click()); };
function field(label: string) {
  const element = document.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`);
  if (!element) throw new Error(`Missing field: ${label}`);
  return element;
}
async function change(label: string, value: string) {
  const element = field(label);
  await act(async () => {
    // Bypass React's value tracker, just as an actual edit does.
    const prototype = element.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
async function renderControls() {
  let current: DatasetSplitOptions = { ...DEFAULT_DATASET_SPLIT };
  function Harness() {
    const [value, setValue] = useState<DatasetSplitOptions>(current);
    current = value;
    return <DatasetSplitControls value={value} onChange={setValue} columns={["condition", "family"]} nRows={20} />;
  }
  const mount = document.createElement("div"); document.body.append(mount);
  root = createRoot(mount);
  await act(async () => root!.render(<Harness />));
  return () => current;
}

it("translates percentage edits into reproducible membership and clears hidden options when the method changes", async () => {
  const value = await renderControls();
  await change("Development percentage", "60");
  await change("Split random seed", "77");
  const table = {
    columns: ["condition", "family"], nRows: 20,
    data: { condition: Array.from({ length: 20 }, (_, i) => i), family: Array.from({ length: 20 }, (_, i) => `family${Math.floor(i / 2)}`) },
  };
  const result = createDatasetPartitions(table, 1, value());
  expect(result.development.table.nRows).toBe(12);
  expect(result.split.seed).toBe(77);
  await change("Split group column", "family");
  await change("Split stratum column", "condition");
  await change("Split method", "existing");
  expect(value()).toMatchObject({ sourceColumn: "condition", developmentValue: "development", holdoutValue: "holdout" });
  expect(value().groupColumn).toBeUndefined();
  expect(value().stratumColumn).toBeUndefined();
  expect(document.querySelector('[aria-label="Development percentage"]')).toBeNull();
  await change("Split method", "random");
  expect(value().sourceColumn).toBeUndefined();
  expect(document.querySelector('[aria-label="Split column"]')).toBeNull();
});

it("preserves cleared numeric inputs as invalid rather than silently applying split defaults", async () => {
  const value = await renderControls();
  await change("Development percentage", "");
  expect(Number.isNaN(value().fraction)).toBe(true);
  expect(field("Development percentage").value).toBe("");
  await change("Split random seed", "");
  expect(Number.isNaN(value().seed)).toBe(true);
  expect(field("Split random seed").value).toBe("");
});

it("keeps keyboard focus in the dataset dialog and restores its opener when dismissed", async () => {
  const closed = vi.fn();
  function Harness() {
    const [open, setOpen] = useState(false);
    return <>
      <button onClick={() => setOpen(true)}>Open setup</button>
      {open && <DatasetDialog title="Create split" onClose={() => { closed(); setOpen(false); }}>
        <button>First action</button><button>Last action</button>
      </DatasetDialog>}
    </>;
  }
  const mount = document.createElement("div"); document.body.append(mount);
  root = createRoot(mount);
  await act(async () => root!.render(<Harness />));
  const opener = document.querySelector("button")!;
  opener.focus(); await click(opener);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(document.activeElement).toBe(dialog);
  const [first, last] = [...dialog.querySelectorAll("button")];
  for (const button of [first, last])
    vi.spyOn(button, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  await click(first);
  expect(closed).not.toHaveBeenCalled();
  last.focus();
  await act(async () => last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(first);
  await act(async () => first.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(last);
  await act(async () => last.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(closed).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(opener);
  await click(opener);
  await click(document.querySelector('[role="dialog"]')!.parentElement!);
  expect(closed).toHaveBeenCalledTimes(2);
});
