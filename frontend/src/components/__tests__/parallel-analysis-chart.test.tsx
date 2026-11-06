// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ParallelAnalysisChart, parallelHistogram } from "../ParallelAnalysisChart";
import type { ParallelResult } from "../../lib/efa/types";
let root: Root | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });

it("counts negative, boundary, and repeated null values exactly once", () => {
  const bins = parallelHistogram([-2, -1, 0, 1, 2, NaN], 4);
  expect(bins.map(bin => bin.count)).toEqual([1, 1, 1, 2]);
  expect(bins[0].lower).toBe(-2); expect(bins.at(-1)!.upper).toBe(2);
  expect(parallelHistogram([0, 0, 0]).reduce((sum, bin) => sum + bin.count, 0)).toBe(3);
  expect(parallelHistogram([])).toEqual([]);
});

it("keeps an extreme observed value explicit and switches the displayed factor without recomputing", async () => {
  const result: ParallelResult = { seed: 1, requested: 4, completed: 4, percentile: .95, observed: [8, -.3], reference: [.985, -.1], nullEigenvalues: [[.7, -.4], [.8, -.3], [.9, -.2], [1, -.1]], suggested: 1, failures: [] };
  const mount = document.createElement("div"); document.body.append(mount); root = createRoot(mount);
  await act(async () => root!.render(<ParallelAnalysisChart result={result} />));
  expect(document.body.textContent).toContain("above range");
  expect(document.querySelector("svg desc")?.textContent).toContain("8");
  const select = document.querySelector<HTMLSelectElement>("select[aria-label='Histogram factor']")!;
  await act(async () => { select.value = "1"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(document.querySelector("svg title")?.textContent).toContain("Factor 2");
  expect(document.body.textContent).toContain("Observed does not exceed");
  expect(document.querySelectorAll("tbody tr").length).toBe(5);
});
