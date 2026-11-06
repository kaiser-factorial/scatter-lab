import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
// Spy on the module consumed by the extracted numerical implementation; the
// frontend compatibility re-export is a separate module namespace.
import * as correlation from "@scatterlab/stats/internal/efa/correlation";
import { prepareEfa } from "../efa/prepare";
import { parallelAnalysis } from "../efa/parallel";
import type { DataTable } from "../table";
import type { EfaSpec } from "../efa/types";

const table = JSON.parse(
  readFileSync(
    new URL("./fixtures/efa/mixed.input.json", import.meta.url),
    "utf8",
  ),
) as DataTable & { categories: number[][] };
const spec: EfaSpec = {
  items: table.columns.map((column, i) => ({
    column,
    categories: table.categories[i],
    reverse: false,
  })),
  nFactors: 2,
  rotation: "oblimin",
  missing: "pairwise",
  seed: 3,
  label: "parallel",
  sample: { partition: "all" },
};
const data = prepareEfa(
  table,
  spec,
  Array.from({ length: table.nRows }, (_, i) => i),
);
const observed = correlation.correlate(data);
afterEach(() => vi.restoreAllMocks());

it("retains every failed null replicate and produces no suggestion or fabricated percentile", () => {
  vi.spyOn(correlation, "correlate")
    .mockReturnValueOnce(observed)
    .mockImplementation(() => {
      throw new Error("Indefinite null correlation");
    });
  const result = parallelAnalysis(data, 3, 3);
  expect(result.completed).toBe(0);
  expect(result.failures.map((f) => f.replicate)).toEqual([0, 1, 2]);
  expect(result.suggested).toBeNull();
  expect(result.reference).toEqual(Array(8).fill(null));
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);
});

it("rejects a private simulation before extraction when an item pair is too small", () => {
  vi.spyOn(correlation, "correlate").mockReturnValue({
    ...observed,
    pairs: observed.pairs.map((p, i) => (i === 0 ? { ...p, n: 4 } : p)),
  });
  expect(() => parallelAnalysis(data, 3, 3, undefined, 5)).toThrow(
    /private aggregate floor/,
  );
  expect(correlation.correlate).toHaveBeenCalledTimes(1);
});
