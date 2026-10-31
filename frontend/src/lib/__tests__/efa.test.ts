import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { prepareEfa } from "../efa/prepare";
import { correlate } from "../efa/correlation";
import { fitEfa, scoreEfa } from "../efa/fit";
import { matchFactors } from "../efa/compare";
import {
  checkCorrelation,
  minresObjective,
  extractMinres,
} from "../efa/extraction";
import { Matrix, normalCDF, normalQuantile, bivariateCDF } from "../efa/math";
import type { EfaSpec, Rotation, OrdinalCategory } from "../efa/types";
import type { DataTable } from "../table";
import { factorEigenvalues } from "../efa/parallel";

const folder = new URL("./fixtures/efa/", import.meta.url);
const names = readdirSync(folder)
  .filter((n) => n.endsWith(".input.json"))
  .map((n) => n.replace(".input.json", ""));
type Input = DataTable & {
  categories: OrdinalCategory[][];
  reverse: number[] | number;
  missing: "pairwise" | "complete";
  nFactors: number;
};
type Ref = {
  provenance: { inputSha256: string };
  correlation: number[][];
  rotations: Record<
    Rotation,
    {
      pattern: number[][];
      phi: number[][];
      communalities: number[];
      reproduced: number[][];
      scoreRows: number[];
      standardizedScores: number[][];
    }
  >;
};
const maxDiff = (a: number[][], b: number[][]) =>
  Math.max(...a.flatMap((row, i) => row.map((v, j) => Math.abs(v - b[i][j]))));
const standardize = (a: number[][]) => {
  const means = a[0].map(
    (_, j) => a.reduce((s, row) => s + row[j], 0) / a.length,
  );
  const sds = means.map((mean, j) =>
    Math.sqrt(
      a.reduce((s, row) => s + (row[j] - mean) ** 2, 0) / (a.length - 1),
    ),
  );
  return a.map((row) => row.map((v, j) => (v - means[j]) / sds[j]));
};
describe("EFA independent R qualification", () => {
  it("includes independent synthetic and public fixtures", () =>
    expect(names.length).toBeGreaterThanOrEqual(5));
  for (const name of names)
    it(
      name,
      () => {
        const bytes = readFileSync(new URL(`${name}.input.json`, folder)),
          input = JSON.parse(bytes.toString()) as Input;
        const ref = JSON.parse(
          readFileSync(new URL(`${name}.reference.json`, folder), "utf8"),
        ) as Ref;
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(
          ref.provenance.inputSha256,
        );
        const reverse = Array.isArray(input.reverse)
          ? input.reverse
          : [input.reverse];
        const spec: EfaSpec = {
          items: input.columns.map((column, i) => ({
            column,
            categories: input.categories[i],
            reverse: reverse.includes(i),
          })),
          nFactors: input.nFactors,
          missing: input.missing,
          rotation: "oblimin",
          seed: 73021,
          label: name,
          sample: { partition: "all" },
        };
        const data = prepareEfa(
          input,
          spec,
          Array.from({ length: input.nRows }, (_, i) => i),
        );
        const cor = correlate(data);
        expect(
          maxDiff(cor.matrix, ref.correlation),
          "polychoric",
        ).toBeLessThanOrEqual(1e-5);
        const extraction = extractMinres(cor.matrix, spec.nFactors);
        for (const rotation of ["oblimin", "promax", "varimax"] as const) {
          const result = fitEfa(
              data,
              cor,
              { ...spec, rotation },
              undefined,
              extraction,
            ),
            r = ref.rotations[rotation];
          const { mapping, signs } = matchFactors(
            r.pattern,
            result.rotation.pattern,
          );
          const aligned = result.rotation.pattern.map((row) =>
            mapping.map((j, i) => row[j!] * signs[i]),
          );
          const phi = mapping.map((i, a) =>
            mapping.map(
              (j, b) => result.rotation.phi[i!][j!] * signs[a] * signs[b],
            ),
          );
          expect(
            maxDiff(result.reproduced, r.reproduced),
            `${rotation} reproduced`,
          ).toBeLessThanOrEqual(1e-4);
          expect(
            Math.max(
              ...result.communalities.map((v, i) =>
                Math.abs(v - r.communalities[i]),
              ),
            ),
            `${rotation} h²`,
          ).toBeLessThanOrEqual(1e-4);
          expect(
            maxDiff(aligned, r.pattern),
            `${rotation} pattern`,
          ).toBeLessThanOrEqual(1e-3);
          expect(maxDiff(phi, r.phi), `${rotation} phi`).toBeLessThanOrEqual(
            1e-3,
          );
          const scores = scoreEfa(data, result),
            zs = standardize(
              r.scoreRows.map((i) =>
                mapping.map((j, a) => scores[i][j!]! * signs[a]),
              ),
            );
          expect(
            maxDiff(zs, r.standardizedScores),
            `${rotation} scores`,
          ).toBeLessThanOrEqual(1e-3);
        }
      },
      60000,
    );
});
describe("EFA mathematical contracts", () => {
  it("parallel analysis matches R on identical saved null datasets", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("parallel.reference.json", folder), "utf8"),
    ) as {
      observed: {
        table: DataTable;
        correlation: number[][];
        eigenvalues: number[];
      };
      null: {
        table: DataTable;
        correlation: number[][];
        eigenvalues: number[];
      }[];
    };
    for (const entry of [fixture.observed, ...fixture.null]) {
      const spec: EfaSpec = {
        items: entry.table.columns.map((column) => ({
          column,
          categories: [1, 2, 3, 4, 5],
          reverse: false,
        })),
        nFactors: 1,
        rotation: "oblimin",
        missing: "pairwise",
        seed: 1,
        label: "null",
        sample: { partition: "all" },
      };
      // Mixed scales have three observed levels on every third item; the explicit
      // five-level order remains valid and pair-specific margins omit empty levels.
      const data = prepareEfa(
          entry.table,
          spec,
          Array.from({ length: entry.table.nRows }, (_, i) => i),
        ),
        r = correlate(data).matrix;
      expect(maxDiff(r, entry.correlation)).toBeLessThanOrEqual(1e-5);
      expect(
        Math.max(
          ...factorEigenvalues(r).map((v, i) =>
            Math.abs(v - entry.eigenvalues[i]),
          ),
        ),
      ).toBeLessThanOrEqual(1e-4);
    }
  });
  it("normal probabilities and bivariate independence", () => {
    expect(normalCDF(1.96)).toBeCloseTo(0.9750021048517795, 13);
    expect(normalQuantile(0.975)).toBeCloseTo(1.95996398454005, 10);
    expect(bivariateCDF(0, 0, 0.6)).toBeCloseTo(
      0.25 + Math.asin(0.6) / (2 * Math.PI),
      13,
    );
  });
  it("analytic MINRES gradient agrees with numerical derivatives", () => {
    const r = new Matrix([
        [1, 0.6, 0.2, 0.25],
        [0.6, 1, 0.2, 0.3],
        [0.2, 0.2, 1, 0.55],
        [0.25, 0.3, 0.55, 1],
      ]),
      psi = [0.4, 0.5, 0.6, 0.7],
      base = minresObjective(r, 1, psi);
    for (let i = 0; i < 4; i++) {
      const a = psi.slice(),
        b = psi.slice();
      a[i] += 1e-5;
      b[i] -= 1e-5;
      expect(base.gradient[i]).toBeCloseTo(
        (minresObjective(r, 1, a).objective -
          minresObjective(r, 1, b).objective) /
          2e-5,
        7,
      );
    }
  });
  it("rejects inadmissible matrices without repair", () => {
    expect(() =>
      checkCorrelation([
        [1, 1, 1],
        [1, 1, 1],
        [1, 1, 1],
      ]),
    ).toThrow(/singular/);
    expect(() =>
      checkCorrelation([
        [1, 0.9, 0.9],
        [0.9, 1, -0.9],
        [0.9, -0.9, 1],
      ]),
    ).toThrow(/indefinite/);
    expect(() =>
      extractMinres(
        [
          [1, 0.2, 0.2],
          [0.2, 1, 0.2],
          [0.2, 0.2, 1],
        ],
        2,
      ),
    ).toThrow(/Underidentified/);
  });
});
