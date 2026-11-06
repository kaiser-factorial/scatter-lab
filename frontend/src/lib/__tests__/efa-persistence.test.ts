import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { validateWorkspace, WORKSPACE_VERSION } from "../workspaces";
import { selectExportColumns } from "../export";
import { prepareEfa } from "../efa/prepare";
import { correlate } from "../efa/correlation";
import { fitEfa } from "../efa/fit";
import type { DataTable } from "../table";
import type { EfaSpec, EfaRun } from "../efa/types";
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
  seed: 73021,
  label: "fixture",
  sample: { partition: "all" },
};
const rows = Array.from({ length: table.nRows }, (_, i) => i),
  prepared = prepareEfa(table, spec, rows);
const run: EfaRun = {
  id: "r",
  revision: 1,
  createdAt: "2026-10-30",
  datasetRevision: "fixture",
  spec,
  result: fitEfa(prepared, correlate(prepared), spec),
  eligibleRows: rows,
  kind: "fit",
  reviews: { item1: { status: "investigate", note: "Content coverage" } },
  reasons: "baseline",
  revisedAfterHoldout: false,
  scoreColumns: [],
};
const workspace = {
  version: WORKSPACE_VERSION,
  tables: { t0: table },
  datasets: [
    { id: 1, name: "test", table: "t0", efa: { runs: [run], splits: [] } },
  ],
};
it("round-trips format 2 with results, reviews and provenance intact", () => {
  const restored = JSON.parse(JSON.stringify(workspace));
  expect(WORKSPACE_VERSION).toBe(2);
  expect(() => validateWorkspace(restored)).not.toThrow();
  expect(restored.datasets[0].efa.runs[0].result.rotation).toEqual(
    run.result.rotation,
  );
  expect(restored.datasets[0].efa.runs[0].reviews).toEqual(run.reviews);
});
it("continues to accept format 1 datasets with absent EFA state", () =>
  expect(() =>
    validateWorkspace({
      version: 1,
      tables: { t0: table },
      datasets: [{ id: 1, name: "old", table: "t0" }],
    }),
  ).not.toThrow());
it("rejects damaged matrices and row memberships before rendering", () => {
  const bad = structuredClone(workspace);
  bad.datasets[0].efa.runs[0].result.rotation.phi = [[1]];
  expect(() => validateWorkspace(bad)).toThrow(/EFA/);
  const badRows = structuredClone(workspace);
  badRows.datasets[0].efa.runs[0].eligibleRows = [-1];
  expect(() => validateWorkspace(badRows)).toThrow(/EFA/);
});
it("score ownership excludes derived scores without hiding similarly named source columns", () => {
  const t = {
    columns: ["item", "FA1_source_r1", "FA1_owned_r1"],
    data: { item: [1], FA1_source_r1: [99], FA1_owned_r1: [0.4] },
    nRows: 1,
  };
  expect(selectExportColumns(t, false, ["FA1_owned_r1"])).toEqual([
    "item",
    "FA1_source_r1",
  ]);
  expect(selectExportColumns(t, true, ["FA1_owned_r1"])).toEqual(t.columns);
});
