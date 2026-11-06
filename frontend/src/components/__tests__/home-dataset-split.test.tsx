// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DatasetPartition } from "../../lib/datasetSplit";
import type { DataTable } from "../../lib/table";

// Only presentation-heavy async surfaces and IO are replaced. Home's upload,
// partitioning, activation, lock dialogs, and workspace serialization are real.
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "primary", setTheme: vi.fn() }) }));
vi.mock("ccru/components", () => ({ CyberStackGroup: () => null, CyberContainer: () => null, CyberPanel: () => null }));
vi.mock("puxel", () => ({
  Accordion: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AccordionItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Separator: () => null,
}));
vi.mock("../../lib/assistant", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/assistant")>(), paintYield: async () => {},
}));
vi.mock("../../lib/parse", () => ({ readTable: vi.fn(), listSheets: vi.fn(async () => []) }));
vi.mock("../../lib/workspaces", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/workspaces")>(),
  loadSession: vi.fn(async () => null), listWorkspaces: vi.fn(async () => []),
  saveSession: vi.fn(async () => {}), saveWorkspace: vi.fn(async () => {}),
}));
import Home from "../../app/page";
import { readTable } from "../../lib/parse";
import { saveWorkspace } from "../../lib/workspaces";

const table: DataTable = {
  columns: ["A", "B", "C"], nRows: 20,
  data: { A: Array.from({ length: 20 }, (_, i) => i + 1), B: Array.from({ length: 20 }, (_, i) => (i % 7) + 1), C: Array.from({ length: 20 }, (_, i) => (i % 5) * 2 + 1) },
};
type Saved = { activeId: number; datasets: { id: number; name: string; table: string; samplePartition: DatasetPartition }[]; tables: Record<string, DataTable> };
let root: Root | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    clear: () => stored.clear(),
  });
  vi.mocked(readTable).mockResolvedValue({ table: structuredClone(table), warnings: [] });
  vi.mocked(saveWorkspace).mockClear();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
function button(text: string) {
  const found = Array.from(document.querySelectorAll("button")).find(el => el.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
async function click(text: string) { await act(async () => button(text).click()); }
function activeName() {
  return document.querySelector('[data-guide="datasets-list"] button[aria-current="true"]')?.textContent;
}
async function save() {
  const name = document.querySelector<HTMLInputElement>('input[placeholder="Workspace name"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Split session");
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Save");
  return vi.mocked(saveWorkspace).mock.calls.at(-1)![1] as Saved;
}
async function chooseFile() {
  const mount = document.createElement("div"); document.body.append(mount);
  root = createRoot(mount);
  await act(async () => root!.render(<Home />));
  const upload = document.querySelector<HTMLInputElement>('[data-guide="upload-dropzone"] input[type="file"]')!;
  Object.defineProperty(upload, "files", { configurable: true, value: [new File(["fixture"], "responses.csv", { type: "text/csv" })] });
  await act(async () => upload.dispatchEvent(new Event("change", { bubbles: true })));
  const skipScan = Array.from(document.querySelectorAll("label")).find(el => el.textContent?.includes("Skip — my data has none"))!.querySelector("input")!;
  await act(async () => skipScan.click());
}

it("uploads into Development, keeps Full and Holdout locked, and persists an explicit unlock", async () => {
  await chooseFile();
  await click("Add & use Development");
  expect(activeName()).toBe("responses · Development");
  let saved = await save();
  const byRole = Object.fromEntries(saved.datasets.map(d => [d.samplePartition.role, d]));
  expect(saved.activeId).toBe(byRole.development.id);
  expect(saved.tables[byRole.development.table].nRows).toBe(14);
  expect(saved.tables[byRole.holdout.table].nRows).toBe(6);
  expect(byRole.full.samplePartition.locked).toBe(true);
  expect(byRole.holdout.samplePartition.locked).toBe(true);
  expect(byRole.development.samplePartition.locked).toBe(false);
  const lockedHoldout = document.querySelector<HTMLButtonElement>('[data-guide="datasets-list"] button[title="responses · Holdout is locked. Open unlock options."]')!;
  await act(async () => lockedHoldout.click());
  expect(document.querySelector('[role="dialog"][aria-label="Unlock Holdout"]')).not.toBeNull();
  expect(activeName()).toBe("responses · Development");
  await click("Keep locked");
  expect(activeName()).toBe("responses · Development");
  await act(async () => lockedHoldout.click());
  await click("Unlock & open");
  expect(activeName()).toBe("responses · Holdout");
  saved = await save();
  const holdout = saved.datasets.find(d => d.samplePartition.role === "holdout")!;
  expect(saved.activeId).toBe(holdout.id);
  expect(holdout.samplePartition.locked).toBe(false);
  expect(holdout.samplePartition.unlockedAt).toMatch(/^\d{4}-/);
  expect(saved.datasets.find(d => d.samplePartition.role === "full")!.samplePartition.locked).toBe(true);
});

it("creates the same protected partition workflow from an already loaded dataset", async () => {
  await chooseFile();
  const noSplit = Array.from(document.querySelectorAll("label")).find(el => el.textContent?.includes("No — use the full dataset"))!.querySelector("input")!;
  await act(async () => noSplit.click());
  await click("Add dataset");
  expect(activeName()).toBe("responses");
  await click("Create development / holdout sets");
  const fraction = document.querySelector<HTMLInputElement>('[role="dialog"] input[aria-label="Development percentage"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(fraction, "60");
    fraction.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Create & use Development");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(activeName()).toBe("responses · Development");
  const saved = await save();
  expect(saved.datasets).toHaveLength(3);
  for (const [role, count, locked] of [["full", 20, true], ["development", 12, false], ["holdout", 8, true]] as const) {
    const dataset = saved.datasets.find(d => d.samplePartition.role === role)!;
    expect(saved.tables[dataset.table].nRows).toBe(count);
    expect(dataset.samplePartition.locked).toBe(locked);
  }
});
