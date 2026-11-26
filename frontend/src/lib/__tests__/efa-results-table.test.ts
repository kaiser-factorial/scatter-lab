import { describe, expect, it } from "vitest";
import { alignEfaDisplayRun, patternAbsGap, sortEfaItems, strongestRelatedItem } from "../efa/results-table";
import type { EfaRun } from "../efa/types";

function fixture(): EfaRun {
  // A deliberately small view fixture: these helpers read no fitted parameters
  // beyond the displayed matrices and do not run a statistical model.
  return {
    spec: {
      items: ["item10", "item2", "other", "item1"].map((column) => ({ column })),
    },
    result: {
      rotation: { pattern: [[-0.8, 0.1], [0.65, -0.6], [0.3, 0.1], [0.8, -0.1]] },
      structure: [[0.2, 0.1], [0.7, 0.1], [0.6, 0.1], [0.3, 0.1]],
      communalities: [0.7, 0.6, 0.1, 0.8],
      uniquenesses: [0.3, 0.4, 0.9, 0.2],
      correlation: {
        matrix: [[1, -0.9, 0.4, 0.2], [-0.9, 1, 0.3, 0.1], [0.4, 0.3, 1, -0.6], [0.2, 0.1, -0.6, 1]],
      },
    },
    reviews: {
      item10: { status: "investigate", note: "Check wording" },
      item2: { status: "exclude", note: "Duplicate" },
      item1: { status: "retain", note: "Anchor" },
    },
  } as unknown as EfaRun;
}

describe("EFA loading table", () => {
  it("uses magnitude for both primary and secondary pattern loadings", () => {
    expect(patternAbsGap([0.65, -0.6, 0.1])).toBeCloseTo(0.05);
    expect(patternAbsGap([-0.65, 0.6, -0.1])).toBeCloseTo(0.05);
    expect(patternAbsGap([-0.65])).toBe(0.65);
    expect(patternAbsGap([0.65, -0.65])).toBe(0);
    expect(patternAbsGap([0.65, NaN])).toBeNaN();
  });

  it("sorts signed or absolute factor values with stable original-index ties", () => {
    const run = fixture();
    const before = structuredClone(run);
    expect(sortEfaItems(run, { sort: { column: "factor", direction: "desc" } })).toEqual([0, 3, 1, 2]);
    expect(sortEfaItems(run, { sort: { column: "factor", direction: "desc" }, magnitude: false })).toEqual([3, 1, 2, 0]);
    expect(sortEfaItems(run, { sort: { column: "factor", factorIndex: 1, direction: "desc" } })).toEqual([1, 0, 2, 3]);
    expect(run).toEqual(before);
  });

  it("sorts structure coefficients when shown but keeps gap tied to pattern", () => {
    const run = fixture();
    expect(sortEfaItems(run, { view: "structure", sort: { column: "factor", direction: "desc" } })).toEqual([1, 2, 3, 0]);
    expect(sortEfaItems(run, { view: "structure", sort: { column: "gap", direction: "desc" } })).toEqual([0, 3, 2, 1]);
  });

  it("searches without breaking source indices and restores original order", () => {
    const run = fixture();
    expect(sortEfaItems(run, { query: "ITEM", sort: { column: "item", direction: "asc" } })).toEqual([3, 1, 0]);
    expect(sortEfaItems(run, { query: "ITEM", sort: null })).toEqual([0, 1, 3]);
    expect(sortEfaItems(run, { query: "missing" })).toEqual([]);
  });

  it("finds strongest absolute correlations in the chosen candidate scope", () => {
    const run = fixture();
    expect(strongestRelatedItem(run, 0)).toEqual({ index: 1, column: "item2", r: -0.9 });
    expect(strongestRelatedItem(run, 0, new Set(["item10", "other", "item1"]))).toEqual({ index: 2, column: "other", r: 0.4 });
    expect(strongestRelatedItem(run, 0, new Set(["item10"]))).toBeUndefined();
    expect(strongestRelatedItem(run, 0, new Set())).toBeUndefined();
  });

  it("uses selected correlation candidates while retaining all displayed rows", () => {
    const run = fixture();
    expect(sortEfaItems(run, {
      includedColumns: new Set(["other"]),
      sort: { column: "related", direction: "desc" },
    })).toEqual([3, 0, 1, 2]);
    expect(sortEfaItems(run, {
      includedColumns: new Set(["other"]),
      sort: { column: "related", direction: "asc" },
    })).toEqual([1, 0, 3, 2]);
  });

  it("sorts metadata with pending reviews and preserves original matrix indexing", () => {
    const run = fixture();
    expect(sortEfaItems(run, { sort: { column: "communality", direction: "desc" } })).toEqual([3, 0, 1, 2]);
    expect(sortEfaItems(run, { sort: { column: "uniqueness", direction: "desc" } })).toEqual([2, 1, 0, 3]);
    expect(sortEfaItems(run, { sort: { column: "review", direction: "asc" } })).toEqual([2, 3, 0, 1]);
    expect(sortEfaItems(run, {
      sort: { column: "note", direction: "asc" },
      reviews: { item10: { status: "retain", note: "A new note" } },
    })).toEqual([1, 2, 3, 0]);
  });
});

describe("EFA live-result display alignment", () => {
  function runs() {
    const reference = fixture();
    reference.spec.nFactors = 2;
    reference.result.fittingRows = [0, 1, 2];
    reference.result.rotation.phi = [[1, 0.25], [0.25, 1]];
    reference.result.weights = [[1, 2], [3, 4], [5, 6], [7, 8]];
    reference.result.extraction = { loadings: reference.result.rotation.pattern } as EfaRun["result"]["extraction"];
    const candidate = structuredClone(reference);
    const rows = [2, 0, 3, 1];
    const switched = (matrix: number[][]) => rows.map((index) => [-matrix[index][1], matrix[index][0]]);
    candidate.spec.items = rows.map((index) => reference.spec.items[index]);
    candidate.result.rotation.pattern = switched(reference.result.rotation.pattern);
    candidate.result.rotation.phi = [[1, -0.25], [-0.25, 1]];
    candidate.result.structure = switched(reference.result.structure);
    candidate.result.weights = switched(reference.result.weights);
    candidate.result.weighted = {
      robust: {
        standardErrors: {
          pattern: [[0.01, 0.02], [0.03, 0.04], [0.05, 0.06], [0.07, 0.08]],
          structure: [[0.11, 0.12], [0.13, 0.14], [0.15, 0.16], [0.17, 0.18]],
          phi: [[0.21, 0.01], [0.01, 0.22]],
          communalities: [0.31, 0.32, 0.33, 0.34],
          uniquenesses: [0.41, 0.42, 0.43, 0.44],
        },
      },
    } as NonNullable<EfaRun["result"]["weighted"]>;
    return { reference, candidate, rows };
  }

  it("aligns candidate factor columns and signs while retaining candidate item order", () => {
    const { reference, candidate, rows } = runs();
    const before = structuredClone(candidate);
    const referenceBefore = structuredClone(reference);
    const aligned = alignEfaDisplayRun(reference, candidate);
    expect(aligned.spec.items).toEqual(candidate.spec.items);
    expect(aligned.result.rotation.pattern).toEqual(rows.map((i) => reference.result.rotation.pattern[i]));
    expect(aligned.result.structure).toEqual(rows.map((i) => reference.result.structure[i]));
    expect(aligned.result.weights).toEqual(rows.map((i) => reference.result.weights[i]));
    expect(aligned.result.rotation.phi).toEqual(reference.result.rotation.phi);
    expect(aligned.result.extraction).toBe(candidate.result.extraction);
    expect(aligned.result.rotation.pattern.map(patternAbsGap)).toEqual(candidate.result.rotation.pattern.map(patternAbsGap));
    expect(candidate).toEqual(before);
    expect(reference).toEqual(referenceBefore);
  });

  it("permutes standard errors without applying factor signs", () => {
    const { reference, candidate } = runs();
    const aligned = alignEfaDisplayRun(reference, candidate);
    const se = aligned.result.weighted!.robust!.standardErrors;
    expect(se.pattern).toEqual([[0.02, 0.01], [0.04, 0.03], [0.06, 0.05], [0.08, 0.07]]);
    expect(se.structure).toEqual([[0.12, 0.11], [0.14, 0.13], [0.16, 0.15], [0.18, 0.17]]);
    expect(se.phi).toEqual([[0.22, 0.01], [0.01, 0.21]]);
    expect(se.communalities).toEqual(candidate.result.weighted!.robust!.standardErrors.communalities);
    // The transformed matrices are independent of the raw candidate.
    aligned.result.rotation.pattern[0][0] = 99;
    se.pattern[0][0] = 99;
    expect(candidate.result.rotation.pattern[0][0]).toBe(-0.1);
    expect(candidate.result.weighted!.robust!.standardErrors.pattern[0][1]).toBe(0.02);
  });

  it("leaves raw candidates untouched when a complete factor alignment is unavailable", () => {
    const { reference, candidate } = runs();
    candidate.spec.nFactors = 1;
    expect(alignEfaDisplayRun(reference, candidate)).toBe(candidate);
    candidate.spec.nFactors = 2;
    candidate.result.rotation.pattern = candidate.result.rotation.pattern.map((row) => row.slice(0, 1));
    expect(alignEfaDisplayRun(reference, candidate)).toBe(candidate);
    candidate.spec.items = candidate.spec.items.map((item) => ({ ...item, column: `new_${item.column}` }));
    expect(alignEfaDisplayRun(reference, candidate)).toBe(candidate);
  });
});
