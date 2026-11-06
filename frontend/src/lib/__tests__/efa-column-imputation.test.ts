import { describe, it, expect } from "vitest";
import { prepareEfa, validateSpec } from "../efa/prepare";
import { correlate } from "../efa/correlation";
import { fitEfa, scoreEfa } from "../efa/fit";
import { fingerprintPrepared } from "../efa/fingerprint";
import { parallelAnalysis, permutedData } from "../efa/parallel";
import { resampleData } from "../efa/stability";
import { validateEfaState } from "../efa/persistence";
import type { DataTable } from "../table";
import type { EfaSpec, EfaRun } from "../efa/types";

const table: DataTable = { columns: ["a", "b", "c"], nRows: 9, data: {
  a: [0, 1, 2, 8, null, null, null, null, 10000],
  b: [4, null, 8, 2, 1, 7, 5, 3, -10000],
  c: [2, 6, null, 9, 4, 3, 8, 0, 20000],
} };
const rows = [0, 1, 2, 3, 4, 5, 6, 7];
const spec: EfaSpec = { items: table.columns.map(column => ({ column, categories: [], reverse: false })),
  nFactors: 1, rotation: "varimax", missing: "mean", seed: 15, label: "Numeric", sample: { partition: "development" } };

describe("column-wise numeric EFA imputation", () => {
  it("uses only fitting observations, preserves observed cells, and retains fractional means and medians", () => {
    const before = structuredClone(table), mean = prepareEfa(table, spec, rows),
      median = prepareEfa(table, { ...spec, missing: "median" }, rows);
    expect(mean.imputation?.values[0]).toBe(2.75);
    expect(median.imputation?.values[0]).toBe(1.5);
    expect(mean.imputation?.missingCounts).toEqual([4, 1, 1]);
    expect(Array.from(mean.numeric!.slice(0, 8))).toEqual([0, 1, 2, 8, 2.75, 2.75, 2.75, 2.75]);
    expect(Array.from(median.numeric!.slice(0, 8))).toEqual([0, 1, 2, 8, 1.5, 1.5, 1.5, 1.5]);
    expect(Array.from(mean.observed.slice(0, 8))).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
    expect(table).toEqual(before);
    expect(mean.rows).toEqual(rows);
    expect(mean.originalRowCount).toBe(9);
    // The held-out outlier cannot change fitted replacements or scaling.
    const changed = structuredClone(table); changed.data.a[8] = -1e9;
    const same = prepareEfa(changed, spec, rows);
    expect(same.numeric).toEqual(mean.numeric); expect(same.means).toEqual(mean.means); expect(same.sds).toEqual(mean.sds);
  });
  it("retains numeric spacing and reverses using only fitting-sample bounds", () => {
    const reversed = prepareEfa(table, { ...spec, items: spec.items.map((x, i) => ({ ...x, reverse: i === 0 })) }, rows);
    expect(Array.from(reversed.numeric!.slice(0, 8))).toEqual([8, 7, 6, 0, 5.25, 5.25, 5.25, 5.25]);
    expect(reversed.imputation?.reverseOffsets).toEqual([8, null, null]);
  });
  it("computes Pearson on completed values while keeping observed support separate", () => {
    const data = prepareEfa(table, spec, rows), correlation = correlate(data), pair = correlation.pairs[0];
    const x = Array.from(data.numeric!.slice(0, 8)), y = Array.from(data.numeric!.slice(8, 16)),
      mx = x.reduce((a, b) => a + b) / 8, my = y.reduce((a, b) => a + b) / 8,
      expected = x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0) /
        Math.sqrt(x.reduce((s, v) => s + (v - mx) ** 2, 0) * y.reduce((s, v) => s + (v - my) ** 2, 0));
    expect(pair.rho).toBeCloseTo(expected, 14);
    expect(pair.n).toBe(3); expect(pair.fittingN).toBe(8);
    expect(correlation.counts).toEqual([4, 7, 7]);
    expect(correlation.diagnostics.some(d => d.code === "empty-pair-margins")).toBe(false);
  });
  it("uses fitted replacement values for scores and leaves excluded respondents unscored", () => {
    const data = prepareEfa(table, spec, rows), result = fitEfa(data, correlate(data), spec);
    const scores = scoreEfa(data, result), i = 4;
    const expected = result.weights.reduce((sum, w, j) => sum +
      ((data.observed[j * 8 + i] ? data.numeric![j * 8 + i] : result.imputation!.values[j]) - result.means[j]) / result.sds[j] * w[0], 0);
    expect(scores[i][0]).toBeCloseTo(expected, 13);
    expect(scores[8]).toEqual([null]);
    expect(result.provenance?.correlation).toContain("Pearson");
    expect(result.provenance.scoring).toContain("fitted column mean");
    expect(result.imputation).toEqual(data.imputation);
    data.numeric![4] = 1000000; // A recomputed placeholder cannot override the saved fit's replacement.
    expect(scoreEfa(data, result)[i][0]).toBeCloseTo(expected, 13);
    expect(() => scoreEfa({ ...data, numeric: undefined }, result)).toThrow(/saved fit/);
  });
  it("scores reversed numeric items on the saved fitting scale", () => {
    const reversedSpec = { ...spec, items: spec.items.map((item, i) => ({ ...item, reverse: i === 0 })) },
      data = prepareEfa(table, reversedSpec, rows), result = fitEfa(data, correlate(data), reversedSpec),
      original = scoreEfa(data, result);
    // A preparation with a different reflection origin still maps back to the saved model.
    const shifted = structuredClone(data); shifted.imputation!.reverseOffsets[0]! += 10;
    for (let i = 0; i < rows.length; i++) if (shifted.observed[i]) shifted.numeric![i] += 10;
    expect(scoreEfa(shifted, result)).toEqual(original);
  });
  it("recomputes replacements within bootstrap samples", () => {
    const data = prepareEfa(table, spec, rows), sample = resampleData(data, [0, 1, 3, 4, 4]);
    expect(sample.imputation?.values[0]).toBe(3);
    expect(Array.from(sample.numeric!.slice(0, 5))).toEqual([0, 1, 8, 3, 3]);
    expect(sample.counts[0]).toEqual([3]);
  });
  it("permutes observed numeric values with missingness fixed and reports the Pearson null model", () => {
    const data = prepareEfa(table, spec, rows), permuted = permutedData(data, 991);
    expect(permuted.observed).toEqual(data.observed);
    expect(Array.from(permuted.numeric!.slice(0, 4)).sort((a, b) => a - b)).toEqual([0, 1, 2, 8]);
    expect(Array.from(permuted.numeric!.slice(4, 8))).toEqual([2.75, 2.75, 2.75, 2.75]);
    const result = parallelAnalysis(data, 45, 3);
    expect(result.provenance?.correlation).toContain("Pearson");
    expect(result.completed + result.failures.length).toBe(3);
  });
  it("fingerprints exact numeric values and missing policies", async () => {
    const mean = prepareEfa(table, spec, rows), median = prepareEfa(table, { ...spec, missing: "median" }, rows);
    expect(await fingerprintPrepared(mean)).not.toBe(await fingerprintPrepared(median));
    const altered = structuredClone(mean); altered.numeric![0] += .01;
    expect(await fingerprintPrepared(mean)).not.toBe(await fingerprintPrepared(altered));
  });
  it("rejects nonnumeric, nonfinite, all-missing and constant fitting columns and ordinal weighted estimators", () => {
    for (const values of [[1, "text"], [1, Infinity], [null, null], [3, 3]]) {
      const invalid = structuredClone(table); invalid.data.a = Array.from({ length: 9 }, (_, i) => values[i % 2]);
      expect(() => prepareEfa(invalid, spec, rows)).toThrow();
    }
    expect(() => validateSpec({ ...spec, extraction: "dwls" })).toThrow(/Pearson correlations use MINRES/);
    expect(() => validateSpec({ ...spec, extraction: "wlsmv" })).toThrow(/Pearson correlations use MINRES/);
  });
  it("round-trips imputation provenance and rejects missing or damaged replacement metadata", () => {
    const data = prepareEfa(table, spec, rows), result = fitEfa(data, correlate(data), spec),
      run: EfaRun = { id: "numeric", revision: 1, createdAt: "2026-11-06", datasetRevision: "fixture", spec, result,
        eligibleRows: rows, kind: "fit", reviews: {}, reasons: "", revisedAfterHoldout: false, scoreColumns: [] },
      state = { runs: [run], splits: [] };
    expect(() => validateEfaState(JSON.parse(JSON.stringify(state)), 9)).not.toThrow();
    const bad = structuredClone(state); bad.runs[0].result.imputation!.values[0] = NaN;
    expect(() => validateEfaState(bad, 9)).toThrow(/EFA/);
    delete bad.runs[0].result.imputation;
    expect(() => validateEfaState(bad, 9)).toThrow(/EFA/);
  });
});
