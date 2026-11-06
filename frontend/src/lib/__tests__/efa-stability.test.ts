import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  bootstrapStability,
  bootstrapIndices,
  distribution,
  type AlignedReplica,
} from "../efa/stability";
import { prepareEfa } from "../efa/prepare";
import { fitEfa } from "../efa/fit";
import { correlate } from "../efa/correlation";
import type { DataTable } from "../table";
import type { EfaSpec } from "../efa/types";
const fixtures = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/efa-extensions/stability.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  cases: Record<
    string,
    {
      table: DataTable & { categories: number[][] };
      baseline: AlignedReplica;
      samples: number[][];
      replicas: AlignedReplica[];
    }
  >;
};
const diff = (a: number[][], b: number[][]) =>
  Math.max(...a.flatMap((row, i) => row.map((v, j) => Math.abs(v - b[i][j]))));
for (const [name, fixture] of Object.entries(fixtures.cases))
  it(`matches R bootstrap fits on identical ${name} resamples`, () => {
    const spec: EfaSpec = {
      items: fixture.table.columns.map((column, i) => ({
        column,
        categories: fixture.table.categories[i],
        reverse: false,
      })),
      missing: "pairwise",
      rotation: "oblimin",
      nFactors: 2,
      seed: 50911,
      label: "stability",
      sample: { partition: "all" },
    };
    const prepared = prepareEfa(
        fixture.table,
        spec,
        Array.from({ length: fixture.table.nRows }, (_, i) => i),
      ),
      baseline = fitEfa(prepared, correlate(prepared), spec);
    // Both implementations are compared in the independently generated R baseline orientation.
    const anchor = {
      ...baseline,
      rotation: {
        ...baseline.rotation,
        pattern: fixture.baseline.pattern,
        phi: fixture.baseline.phi,
      },
    };
    const result = bootstrapStability(
      prepared,
      spec,
      anchor,
      {
        replicates: 6,
        seed: 50911,
        confidence: 0.95,
        crossLoadingThreshold: 0.3,
      },
      undefined,
      fixture.samples,
    );
    expect(result.failures).toEqual([]);
    expect(result.completed).toBe(6);
    expect(result.provisional).toBe(false);
    result.replicas.forEach((r, i) => {
      const reference = fixture.replicas[i];
      expect(diff(r.pattern, reference.pattern)).toBeLessThan(1e-3);
      expect(diff(r.structure, reference.structure)).toBeLessThan(1e-3);
      expect(diff(r.phi, reference.phi)).toBeLessThan(1e-3);
      expect(
        Math.max(
          ...r.communalities.map((v, j) =>
            Math.abs(v - reference.communalities[j]),
          ),
        ),
      ).toBeLessThan(1e-4);
    });
    const expected = distribution(fixture.replicas.map((r) => r.pattern[0][0]));
    expect(
      Math.abs(result.pattern[0][0].lower! - expected.lower!),
    ).toBeLessThan(1e-3);
    expect(
      Math.abs(result.pattern[0][0].upper! - expected.upper!),
    ).toBeLessThan(1e-3);
    const failed = bootstrapStability(
      prepared,
      spec,
      anchor,
      { replicates: 2, seed: 1, confidence: 0.95, crossLoadingThreshold: 0.3 },
      undefined,
      [Array(prepared.nRows).fill(0), fixture.samples[0]],
    );
    expect(failed.failures).toHaveLength(1);
    expect(failed.completed).toBe(1);
    expect(failed.provisional).toBe(true);
    expect(failed.pattern[0][0].sd).toBeNull();
  });
it("resamples whole groups and records repeated memberships", () => {
  const groups = ["a", "a", "b", "b", "b", "c"],
    indices = bootstrapIndices(6, 23, groups);
  const multiplicity = (row: number) => indices.filter((i) => i === row).length;
  expect(multiplicity(0)).toBe(multiplicity(1));
  expect(multiplicity(2)).toBe(multiplicity(3));
  expect(multiplicity(3)).toBe(multiplicity(4));
  expect(indices).toEqual(bootstrapIndices(6, 23, groups));
  expect(() => bootstrapIndices(3, 1, ["a", "a", "a"])).toThrow(/two groups/);
});
