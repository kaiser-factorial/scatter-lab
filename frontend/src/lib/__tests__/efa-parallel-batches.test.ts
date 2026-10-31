import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { prepareEfa } from "../efa/prepare";
import { parallelObserved, summarizeParallel } from "../efa/parallel";
import type { DataTable } from "../table";
import type { EfaSpec } from "../efa/types";
for (const name of ["normal", "heavy-tail", "skew"])
  it(`qualifies 100 saved R parallel-analysis permutations for ${name} data`, () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          `./fixtures/efa-extensions/parallel-${name}.reference.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      input: DataTable & { categories: number[][] };
      observed: number[];
      null: { data: DataTable["data"]; eigenvalues: number[] }[];
      failures: unknown[];
      reference: number[];
    };
    const spec: EfaSpec = {
        items: fixture.input.columns.map((column, i) => ({
          column,
          categories: fixture.input.categories[i],
          reverse: false,
        })),
        nFactors: 1,
        rotation: "oblimin",
        missing: "pairwise",
        seed: 73411,
        label: "batch",
        sample: { partition: "all" },
      },
      rows = Array.from({ length: fixture.input.nRows }, (_, i) => i);
    const observed = parallelObserved(prepareEfa(fixture.input, spec, rows));
    expect(fixture.failures).toEqual([]);
    expect(fixture.null).toHaveLength(100);
    const nullValues = fixture.null.map((entry) => {
      const values = parallelObserved(
        prepareEfa({ ...fixture.input, data: entry.data }, spec, rows),
      );
      expect(
        Math.max(...values.map((v, i) => Math.abs(v - entry.eigenvalues[i]))),
      ).toBeLessThan(1e-4);
      return values;
    });
    const result = summarizeParallel(observed, nullValues, [], 73411, 100);
    expect(
      Math.max(...observed.map((v, i) => Math.abs(v - fixture.observed[i]))),
    ).toBeLessThan(1e-4);
    expect(
      Math.max(
        ...result.reference.map((v, i) => Math.abs(v! - fixture.reference[i])),
      ),
    ).toBeLessThan(1e-4);
    expect(result.completed).toBe(100);
    expect(result.suggested).not.toBeNull();
  }, 120000);
