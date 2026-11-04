import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Matrix } from "../efa/math";
import { prepareEfa } from "../efa/prepare";
import { correlate } from "../efa/correlation";
import { weightedMoments, influenceAt } from "../efa/weighted-moments";
import { extractDwls } from "../efa/dwls";
import { identifyLoadings } from "../efa/weighted-inference";
import { projectCases, covarianceQuadraticForms, normalizeCaseProjections } from "../efa/weighted-linalg";
import { mulberry32 } from "../random";
import type { EfaSpec } from "../efa/types";
import type { DataTable } from "../table";

describe("Bounded weighted linear algebra", () => {
  for (const name of ["pairwise", "complete"])
    it(`preserves case projections across tiles with ${name} missingness`, () => {
      const input = JSON.parse(readFileSync(new URL(`./fixtures/efa-weighted/${name}.input.json`, import.meta.url), "utf8")) as DataTable & { categories: number[][]; reverse: number[]; missing: "pairwise" | "complete"; nFactors: number };
      const spec: EfaSpec = { items: input.columns.map((column, i) => ({ column, categories: input.categories[i], reverse: input.reverse.includes(i) })), nFactors: input.nFactors, missing: input.missing, rotation: "oblimin", seed: 73021, label: name, sample: { partition: "all" } };
      const data = prepareEfa(input, spec, Array.from({ length: input.nRows }, (_, i) => i)),
        correlation = correlate(data), moments = weightedMoments(data, correlation),
        fit = extractDwls(correlation.matrix, moments, spec.nFactors),
        identified = identifyLoadings(fit.loadings);
      // Independent parameter-first expression for S W d(LL')/d(parameter).
      const expected = Array.from({ length: data.nRows }, (_, row) => Float64Array.from(identified.free, ([item, factor]) => {
        let value = 0;
        for (let a = 0; a < moments.pairs.length; a++) {
          const pair = moments.pairs[a];
          if (pair.i === item || pair.j === item)
            value += influenceAt(data, pair, row) * moments.weights[a] * identified.loadings[pair.i === item ? pair.j : pair.i][factor];
        }
        return value;
      }));
      for (const tile of [1, 17, 64, 256]) expect(projectCases(data, moments, identified, undefined, tile)).toEqual(expected);
      expect(() => projectCases(data, moments, identified, undefined, 0)).toThrow("tile size");
    });

  it("normalizes projections and inverts the triangular factor without changing arithmetic results", () => {
    const random = mulberry32(372), q = 13, n = 41;
    const lower = new Matrix(Array.from({ length: q }, (_, i) => Array.from({ length: q }, (_, j) => i === j ? 2 + random() : j < i ? random() - 0.5 : 0)));
    const z = Array.from({ length: n }, () => Float64Array.from({ length: q }, () => random() - 0.5)), reference = z.map(row => row.slice());
    const meat = Matrix.zeros(q, q), inverse = Matrix.zeros(q, q);
    for (const v of reference) {
      for (let a = 0; a < q; a++) {
        let x = v[a];
        for (let b = 0; b < a; b++) x -= lower.get(a, b) * v[b];
        v[a] = x / lower.get(a, a);
      }
      for (let a = 0; a < q; a++) v[a] /= Math.sqrt(n);
      for (let a = 0; a < q; a++) for (let b = 0; b <= a; b++) meat.set(a, b, meat.get(a, b) + v[a] * v[b]);
    }
    for (let a = 0; a < q; a++) for (let b = 0; b < a; b++) meat.set(b, a, meat.get(a, b));
    for (let c = 0; c < q; c++) for (let a = 0; a < q; a++) {
      let x = a === c ? 1 : 0;
      for (let b = 0; b < a; b++) x -= lower.get(a, b) * inverse.get(b, c);
      inverse.set(a, c, x / lower.get(a, a));
    }
    const actual = normalizeCaseProjections(z, lower);
    expect(z).toEqual(reference);
    expect(actual.meat.to2DArray()).toEqual(meat.to2DArray());
    expect(actual.inverseLower.to2DArray()).toEqual(inverse.to2DArray());
  });

  it("preserves dense, sparse, zero and ragged-batch quadratic forms, including asymmetric roundoff", () => {
    const random = mulberry32(174), q = 17;
    const covariance = new Matrix(Array.from({ length: q }, (_, i) => Array.from({ length: q }, (_, j) => i === j ? 3 : (random() - 0.5) / q)));
    const derivatives = Array.from({ length: 11 }, (_, i) => Float64Array.from({ length: q }, (_, j) => i === 0 ? 0 : i < 4 && j >= i ? 0 : random() - 0.5));
    const expected = derivatives.map(d => {
      const row = new Matrix([Array.from(d)]);
      return row.mmul(covariance).mmul(row.transpose()).get(0, 0);
    });
    const actual = covarianceQuadraticForms(covariance, derivatives);
    for (let i = 0; i < expected.length; i++) expect(Math.abs(actual[i] - expected[i])).toBeLessThan(1e-12);
    expect(actual[0]).toBe(0);
    expect(() => covarianceQuadraticForms(covariance, [new Float64Array(3)])).toThrow("dimensions");
    derivatives[0][0] = NaN;
    expect(() => covarianceQuadraticForms(covariance, derivatives)).toThrow("Non-finite");
  });
});
