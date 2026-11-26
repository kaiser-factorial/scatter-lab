import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  imputeMice,
  type MiceOptions,
  type MiceDrawRequest,
} from "../efa/mice";
import { prepareEfa } from "../efa/prepare";
import {
  fitImputationChain,
  summarizeImputations,
} from "../efa/imputation-analysis";
import type { DataTable } from "../table";
import type { EfaSpec } from "../efa/types";
type Fixture = {
  table: DataTable & { categories: number[][] };
  options: MiceOptions;
  draws: (MiceDrawRequest & { values: number[] })[];
  completed: number[][][];
  trace: { mean: number; sd: number }[];
  fits: {
    correlation: number[][];
    pattern: number[][];
    communalities: number[];
    uniquenesses: number[];
    rmsr: number;
  }[];
};
const fixture = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/efa-extensions/mice-chain.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Fixture;
const spec: EfaSpec = {
  items: fixture.table.columns.map((column, i) => ({
    column,
    categories: fixture.table.categories[i],
    reverse: false,
  })),
  missing: "pairwise",
  rotation: "oblimin",
  nFactors: 1,
  seed: 1,
  label: "MICE reference",
  sample: { partition: "all" },
};
const data = prepareEfa(
  fixture.table,
  spec,
  Array.from({ length: fixture.table.nRows }, (_, i) => i),
);
for (const family of ["heavy-tail", "skew"])
  for (const encoding of ["rank", "polynomial"])
    it(`matches complete ${family} ${encoding} chained imputations from pinned R conditional methods with identical saved draws`, () => {
      const fixture = JSON.parse(
        readFileSync(
          new URL(
            `./fixtures/efa-extensions/mice-chain${encoding === "polynomial" ? "-polynomial" : ""}${family === "skew" ? "-skew" : ""}.reference.json`,
            import.meta.url,
          ),
          "utf8",
        ),
      ) as Fixture;
      const spec: EfaSpec = {
        items: fixture.table.columns.map((column, i) => ({
          column,
          categories: fixture.table.categories[i],
          reverse: false,
        })),
        missing: "pairwise",
        rotation: "oblimin",
        nFactors: 1,
        seed: 1,
        label: "MICE reference",
        sample: { partition: "all" },
      };
      const data = prepareEfa(
        fixture.table,
        spec,
        Array.from({ length: fixture.table.nRows }, (_, i) => i),
      );
      const source = data.codes.slice();
      const result = imputeMice(data, fixture.options, undefined, (request) => {
        const draw = fixture.draws.find(
          (d) =>
            d.imputation === request.imputation &&
            d.iteration === request.iteration &&
            d.item === request.item &&
            d.kind === request.kind,
        );
        if (!draw) throw new Error("Missing reference draw");
        return draw.values;
      });
      expect(result.failures).toEqual([]);
      expect(result.completed).toHaveLength(2);
      for (const { imputation, data: complete } of result.completed)
        for (let j = 0; j < spec.items.length; j++)
          for (let i = 0; i < data.nRows; i++) {
            expect(complete.codes[j * data.nRows + i]).toBe(
              fixture.completed[imputation][i][j],
            );
            if (data.observed[j * data.nRows + i])
              expect(complete.codes[j * data.nRows + i]).toBe(
                source[j * data.nRows + i],
              );
          }
      expect(data.codes).toEqual(source);
      expect(result.trace).toHaveLength(fixture.trace.length);
      result.trace.forEach((t, i) => {
        expect(t.mean).toBeCloseTo(fixture.trace[i].mean, 12);
        expect(t.sd).toBeCloseTo(fixture.trace[i].sd, 12);
      });
      const chains = Array.from(
        { length: fixture.options.imputations },
        (_, imputation) =>
          fitImputationChain(
            data,
            spec,
            fixture.options,
            imputation,
            undefined,
            (request) =>
              fixture.draws.find(
                (d) =>
                  d.imputation === request.imputation &&
                  d.iteration === request.iteration &&
                  d.item === request.item &&
                  d.kind === request.kind,
              )!.values,
          ),
      );
      const analysis = summarizeImputations(data, fixture.options, chains);
      expect(analysis.completed).toBe(2);
      expect(analysis.failures).toEqual([]);
      expect(analysis.provisional).toBe(false);
      const difference = (a: number[][], b: number[][]) =>
        Math.max(
          ...a.flatMap((row, i) => row.map((v, j) => Math.abs(v - b[i][j]))),
        );
      analysis.fits.forEach((fit, i) => {
        const reference = fixture.fits[i],
          sign =
            fit.result.rotation.pattern[0][0] * reference.pattern[0][0] < 0
              ? -1
              : 1;
        expect(
          difference(fit.result.correlation.matrix, reference.correlation),
        ).toBeLessThan(1e-5);
        expect(
          difference(
            fit.result.rotation.pattern.map((row) => row.map((v) => v * sign)),
            reference.pattern,
          ),
        ).toBeLessThan(1e-3);
        expect(
          Math.max(
            ...fit.result.communalities.map((v, j) =>
              Math.abs(v - reference.communalities[j]),
            ),
          ),
        ).toBeLessThan(1e-4);
        analysis.missingPositions.forEach((position, j) =>
          expect(fit.replacements[j]).toBe(
            result.completed[i].data.codes[position],
          ),
        );
      });
      expect(analysis.provenance.uncertainty).toContain("no within-imputation");
      const partial = summarizeImputations(data, fixture.options, [
        chains[0],
        {
          trace: [],
          failure: { imputation: 1, stage: "fit", error: "fixture failure" },
        },
      ]);
      expect(partial.provisional).toBe(true);
      expect(partial.pattern[0][0].sd).toBeNull();
      expect(() =>
        summarizeImputations(data, fixture.options, [chains[0]]),
      ).toThrow(/Every requested/);
    });
it("preserves separate reproducible chains and does not change observed responses", () => {
  const a = imputeMice(data, fixture.options),
    b = imputeMice(data, fixture.options);
  expect(a.failures).toEqual([]);
  expect(a.completed).toHaveLength(2);
  expect(a.completed[0].data.codes).toEqual(b.completed[0].data.codes);
  expect(a.completed[0].data.codes).not.toEqual(a.completed[1].data.codes);
  for (const { data: complete } of a.completed) {
    expect(complete.rows).toEqual(data.rows);
    expect(complete.observed.every((v) => v === 1)).toBe(true);
    for (let i = 0; i < data.codes.length; i++)
      if (data.observed[i]) expect(complete.codes[i]).toBe(data.codes[i]);
  }
});
it("finishes longer ordinal chains near likelihood roundoff without weakening the gradient tolerance", () => {
  const subset = prepareEfa(
    fixture.table,
    spec,
    Array.from({ length: 300 }, (_, i) => i),
  );
  const result = imputeMice(subset, {
    ...fixture.options,
    predictorEncoding: "ordered-polynomial",
    imputations: 5,
    iterations: 10,
  });
  expect(result.failures).toEqual([]);
  expect(result.completed).toHaveLength(5);
  expect(result.trace).toHaveLength(200);
  expect(result.trace.every((t) => t.gradient < 1e-8)).toBe(true);
});
it("records failed imputations without substituting predictors or models", () => {
  const changed = {
    ...data,
    items: data.items.map((item, j) =>
      j === 1 ? { ...item, categories: [...item.categories, 99] } : item,
    ),
  };
  const result = imputeMice(changed, fixture.options);
  expect(result.completed).toHaveLength(0);
  expect(result.failures).toHaveLength(2);
  expect(result.failures[0].error).toContain("Every declared");
  expect(() =>
    imputeMice(data, {
      ...fixture.options,
      predictors: spec.items.map((_, j) => [j]),
    }),
  ).toThrow(/excluding/);
});
