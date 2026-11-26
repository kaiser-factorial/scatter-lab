import { describe, expect, it } from "vitest";
import { prepareEfa } from "../efa/prepare";
import { correlate } from "../efa/correlation";
import { scoreEfa } from "../efa/fit";
import {
  createSampleSplit,
  fittingRows,
  existingSampleSplit,
  addScoreColumns,
} from "../efa/state";
import { permutedData } from "../efa/parallel";
import type { EfaRun, EfaSpec, EfaResult } from "../efa/types";
import { extractMinres } from "../efa/extraction";

const table = {
  columns: ["a", "b", "c", "group", "stratum"],
  data: {
    a: [1, 2, null, 3, 1, 3, 2, 1],
    b: [3, 2, 1, 2, 1, 3, 2, 1],
    c: [1, 2, 3, 1, 2, 3, 1, 2],
    group: ["a", "a", "b", "b", "c", "c", "d", "d"],
    stratum: ["x", "x", "x", "x", "y", "y", "y", "y"],
  },
  nRows: 8,
};
const spec: EfaSpec = {
  items: ["a", "b", "c"].map((column) => ({
    column,
    categories: [1, 2, 3],
    reverse: false,
  })),
  nFactors: 1,
  rotation: "oblimin",
  missing: "pairwise",
  seed: 1,
  label: "test",
  sample: { partition: "all" },
};
describe("EFA preparation and review invariants", () => {
  it("fits only selected rows and reverse keys without changing source cells", () => {
    const data = prepareEfa(
      table,
      {
        ...spec,
        items: spec.items.map((item, i) => ({ ...item, reverse: i === 0 })),
      },
      [0, 1, 2, 3],
    );
    expect(data.rows).toEqual([0, 1, 2, 3]);
    expect(data.codes[0]).toBe(2);
    expect(table.data.a[0]).toBe(1);
    expect(data.observed[2]).toBe(0);
    const complete = prepareEfa(
      table,
      { ...spec, missing: "complete" },
      [0, 1, 2, 3],
    );
    expect(complete.rows).toEqual([0, 1, 3]);
  });
  it("requires explicit observed categories, nonconstant items and identifiable counts", () => {
    expect(() =>
      prepareEfa(
        table,
        {
          ...spec,
          items: spec.items.map((item) => ({ ...item, categories: [1, 2] })),
        },
        [0, 1, 2, 3],
      ),
    ).toThrow(/category order/);
    expect(() => prepareEfa(table, spec, [0, 4, 7])).toThrow(/fewer than two/);
    expect(() =>
      prepareEfa(table, { ...spec, nFactors: 2 }, [0, 1, 2, 3]),
    ).toThrow(/underidentified/);
    expect(() => prepareEfa(table, spec, [0, 0, 1])).toThrow(/membership/);
  });
  it("rejects unestimable pairs and records sparse cells", () => {
    const data = prepareEfa(table, spec, [0, 1, 2, 3]);
    expect(correlate(data).pairs.some((p) => p.sparseCells > 0)).toBe(true);
    const sparse = {
      ...table,
      data: {
        ...table.data,
        a: [1, 2, null, null, null, null, null, null],
        b: [null, null, 1, 2, null, null, null, null],
      },
    };
    expect(() => correlate(prepareEfa(sparse, spec, [0, 1, 2, 3]))).toThrow(
      /Cannot estimate/,
    );
  });
  it("scores only complete fitting rows and scatters to original positions", () => {
    const data = prepareEfa(table, spec, [1, 2, 3]);
    const result = {
      weights: [[1], [0], [0]],
      means: data.means,
      sds: data.sds,
    } as EfaResult;
    const scores = scoreEfa(data, result);
    expect(scores).toHaveLength(8);
    expect(scores[0][0]).toBeNull();
    expect(scores[1][0]).not.toBeNull();
    expect(scores[2][0]).toBeNull();
    expect(scores[4][0]).toBeNull();
  });
  it("permutations preserve each missing mask and observed category counts", () => {
    const data = prepareEfa(table, spec, [0, 1, 2, 3, 4, 5, 6, 7]),
      permuted = permutedData(data, 75);
    expect(permuted.observed).toEqual(data.observed);
    for (let j = 0; j < 3; j++) {
      const values = (codes: Uint16Array) =>
        Array.from(codes.slice(j * 8, j * 8 + 8))
          .filter((_, i) => data.observed[j * 8 + i])
          .sort();
      expect(values(permuted.codes)).toEqual(values(data.codes));
    }
  });
  it("does not hide nonconvergence", () =>
    expect(() =>
      extractMinres(
        [
          [1, 0.5, 0.3],
          [0.5, 1, 0.4],
          [0.3, 0.4, 1],
        ],
        1,
        undefined,
        0,
      ),
    ).toThrow(/did not converge/));
  it("reports near-boundary ordinal correlations and bounded uniqueness solutions", () => {
    const identical = {
      ...table,
      data: { ...table.data, b: table.data.c, a: table.data.c },
    };
    const correlations = correlate(
      prepareEfa(identical, spec, [0, 1, 2, 3, 4, 5, 6, 7]),
    );
    expect(correlations.pairs.every((p) => p.rho > 0.999)).toBe(true);
    expect(
      correlations.diagnostics.some((d) => d.code.includes("boundary")),
    ).toBe(true);
    const extracted = extractMinres(
      [
        [1, 0.9999, 0.9999],
        [0.9999, 1, 0.9999],
        [0.9999, 0.9999, 1],
      ],
      1,
    );
    expect(extracted.boundaryItems).toEqual([0, 1, 2]);
    expect(
      extracted.uniquenessParameters.every((x) => x >= 0.005 && x <= 1),
    ).toBe(true);
  });
});
describe("sample membership and score ownership", () => {
  it("keeps groups together and preserves membership across item edits", () => {
    const split = createSampleSplit(table, [0, 1, 2, 3, 4, 5, 6, 7], {
      seed: 32,
      fraction: 0.7,
      groupColumn: "group",
      stratumColumn: "stratum",
      afterFullExploration: true,
    });
    for (const rows of [split.development, split.holdout])
      for (const row of rows)
        expect(rows).toContain(row % 2 ? row - 1 : row + 1);
    expect(split.development).toEqual(
      createSampleSplit(table, [0, 1, 2, 3, 4, 5, 6, 7], {
        seed: 32,
        fraction: 0.7,
        groupColumn: "group",
        stratumColumn: "stratum",
        afterFullExploration: true,
      }).development,
    );
    expect(
      fittingRows(
        [0, 1, 2, 3, 4, 5, 6, 7],
        { ...spec, sample: { partition: "development", splitId: split.id } },
        [split],
      ),
    ).toEqual(split.development);
    expect(split.afterFullExploration).toBe(true);
  });
  it("supports existing partition values and rejects missing groups", () => {
    const split = existingSampleSplit(
      table,
      [0, 1, 2, 3, 4, 5, 6, 7],
      "stratum",
      "x",
      "y",
      false,
    );
    expect(split.development).toEqual([0, 1, 2, 3]);
    expect(() =>
      createSampleSplit(
        {
          ...table,
          data: { ...table.data, group: [null, ...table.data.group.slice(1)] },
        },
        [0, 1, 2],
        {
          seed: 1,
          fraction: 0.7,
          groupColumn: "group",
          afterFullExploration: false,
        },
      ),
    ).toThrow(/cannot be missing/);
  });
  it("never overwrites a source column or mutates the source table", () => {
    const source = {
      ...table,
      columns: [...table.columns, "FA1_test_r1"],
      data: { ...table.data, FA1_test_r1: Array(8).fill(99) },
    };
    const run = { spec, revision: 1 } as EfaRun,
      result = addScoreColumns(
        source,
        run,
        Array.from({ length: 8 }, () => [0.2]),
      );
    expect(result.columns).toEqual(["FA1_test_r1_2"]);
    expect(source.data.FA1_test_r1[0]).toBe(99);
    expect(source.columns).not.toContain("FA1_test_r1_2");
  });
});
