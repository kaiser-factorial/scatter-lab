import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { prepareEfa } from "../efa/prepare";
import { correlate } from "../efa/correlation";
import {
  influenceAt,
  pairInfluence,
  weightedMoments,
} from "../efa/weighted-moments";
import { dwlsObjective, extractDwls } from "../efa/dwls";
import { rotate } from "../efa/rotation";
import { matchFactors } from "../efa/compare";
import { Matrix } from "../efa/math";
import { rotatedUncertainty } from "../efa/weighted-rotation";
import {
  identifyLoadings,
  planWeightedInference,
  weightedInference,
  weightedInferenceWithKernel,
} from "../efa/weighted-inference";
import { cpuTraceBlock } from "../efa/trace-kernel";
import type { DataTable } from "../table";
import type { EfaSpec } from "../efa/types";

const folder = new URL("./fixtures/efa-weighted/", import.meta.url);
type Input = DataTable & {
  categories: number[][];
  reverse: number[];
  missing: "complete" | "pairwise";
  nFactors: number;
};
type ReferenceFit = {
  est: { lambda: number[][]; psi: number[][]; theta: number[][] };
  se: { lambda: number[][]; psi: number[][]; theta: number[][] };
  test: Record<string, Record<string, number>>;
};
type Reference = {
  provenance: { inputSha256: string };
  gamma: number[][];
  correlation: number[][];
  scoreRows: number[][];
  raw: null | { correlation: number[][]; gamma: number[][] };
  fits: Record<string, ReferenceFit>;
  delta: Record<
    string,
    {
      pattern: number[][];
      phi: number[][];
      structure: number[][];
      se: {
        pattern: number[][];
        phi: number[][];
        structure: number[][];
        communalities: number[];
      };
    }
  >;
};
const maxDiff = (a: number[][], b: number[][]) =>
  Math.max(...a.flatMap((row, i) => row.map((v, j) => Math.abs(v - b[i][j]))));
export function weightedFixture(name: string) {
  const input = JSON.parse(
      readFileSync(new URL(`${name}.input.json`, folder), "utf8"),
    ) as Input,
    ref = JSON.parse(
      readFileSync(new URL(`${name}.reference.json`, folder), "utf8"),
    ) as Reference;
  const spec: EfaSpec = {
    items: input.columns.map((column, i) => ({
      column,
      categories: input.categories[i],
      reverse: input.reverse.includes(i),
    })),
    nFactors: input.nFactors,
    rotation: "oblimin",
    seed: 73021,
    label: name,
    missing: input.missing,
    sample: { partition: "all" },
  };
  const data = prepareEfa(
      input,
      spec,
      Array.from({ length: input.nRows }, (_, i) => i),
    ),
    correlation = correlate(data);
  return { input, ref, spec, data, correlation };
}
describe("Independent pinned R ordinal uncertainty", () => {
  it("records exact input, output, and reference-generator hashes", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("manifest.json", folder), "utf8"),
    ) as {
      fixtureHashes: Record<string, string>;
      sourceHashes: Record<string, string>;
    };
    for (const [file, hash] of Object.entries(manifest.fixtureHashes))
      expect(
        createHash("sha256")
          .update(readFileSync(new URL(file, folder)))
          .digest("hex"),
      ).toBe(hash);
    for (const [file, hash] of Object.entries(manifest.sourceHashes))
      expect(
        createHash("sha256")
          .update(
            readFileSync(
              new URL(
                `../../../scripts/efa-reference/${file}`,
                import.meta.url,
              ),
            ),
          )
          .digest("hex"),
      ).toBe(hash);
  });
  for (const name of ["normal", "heavy-tail", "skew", "pairwise", "complete"])
    it(name, () => {
      const { ref, data, correlation } = weightedFixture(name),
        moments = weightedMoments(data, correlation),
        m = moments.pairs.length;
      expect(
        createHash("sha256")
          .update(readFileSync(new URL(`${name}.input.json`, folder)))
          .digest("hex"),
      ).toBe(ref.provenance.inputSha256);
      expect(maxDiff(correlation.matrix, ref.correlation)).toBeLessThan(1e-5);
      const gamma = Array.from({ length: m }, () => Array(m).fill(0));
      for (let row = 0; row < data.nRows; row++) {
        const scores = moments.pairs.map((p) => influenceAt(data, p, row));
        if (row < ref.scoreRows.length)
          expect(
            Math.max(
              ...scores.map((v, j) => Math.abs(v - ref.scoreRows[row][j])),
            ),
          ).toBeLessThan(1e-4);
        for (let a = 0; a < m; a++)
          for (let b = 0; b < m; b++)
            gamma[a][b] += (scores[a] * scores[b]) / data.nRows;
      }
      expect(maxDiff(gamma, ref.gamma)).toBeLessThan(1e-4);
      moments.pairs.forEach((p, i) =>
        expect(Math.abs(p.variance - ref.gamma[i][i])).toBeLessThan(1e-4),
      );
      if (ref.raw) {
        expect(maxDiff(correlation.matrix, ref.raw.correlation)).toBeLessThan(
          1e-4,
        );
        expect(maxDiff(gamma, ref.raw.gamma)).toBeLessThan(1e-4);
      }
    });
});
describe("Independent pinned R WLSMV correction", () => {
  // This accuracy check refits several rotations and numerical derivatives.
  // Allow slower CI/shared hosts; performance has its own benchmark suite.
  for (const name of ["normal", "heavy-tail", "skew", "pairwise", "complete"])
    it(name, { timeout: 20000 }, () => {
      const { ref, data, correlation } = weightedFixture(name),
        moments = weightedMoments(data, correlation),
        fit = extractDwls(correlation.matrix, moments, 2),
        result = weightedInference(
          data,
          moments,
          fit.loadings,
          fit.convergence.objective,
        ),
        r = ref.fits.oblimin.test["scaled.shifted"];
      expect(
        Math.abs(
          result.test.rawStatistic - ref.fits.oblimin.test.standard.stat,
        ),
      ).toBeLessThan(1e-4);
      expect(result.test.df).toBe(r.df);
      expect(Math.abs(result.test.trace - r["trace.UGamma"])).toBeLessThan(
        1e-4,
      );
      expect(
        Math.abs(result.test.traceSquared - r["trace.UGamma2"]),
      ).toBeLessThan(1e-4);
      expect(
        Math.abs(result.test.scalingFactor! - r["scaling.factor"]),
      ).toBeLessThan(1e-4);
      expect(Math.abs(result.test.shift! - r["shift.parameter"])).toBeLessThan(
        1e-4,
      );
      expect(Math.abs(result.test.statistic! - r.stat)).toBeLessThan(1e-4);
      expect(Math.abs(result.test.pValue! - r.pvalue)).toBeLessThan(1e-5);
      for (const method of ["oblimin", "varimax"] as const) {
        const rotation = rotate(fit.loadings, method, 73021, 4, true),
          se = rotatedUncertainty(
            result.identified,
            result.covariance,
            rotation,
            method,
            73021,
          ),
          reference = ref.fits[method],
          match = matchFactors(reference.est.lambda, rotation.pattern);
        expect(
          maxDiff(
            se.pattern.map((row) => match.mapping.map((j) => row[j!])),
            reference.se.lambda,
          ),
          `${method} loading SE`,
        ).toBeLessThan(1e-4);
        expect(
          maxDiff(
            match.mapping.map((i) => match.mapping.map((j) => se.phi[i!][j!])),
            reference.se.psi,
          ),
          `${method} factor correlation SE`,
        ).toBeLessThan(1e-4);
      }
      for (const method of ["oblimin", "varimax", "promax"] as const) {
        const rotation = rotate(fit.loadings, method, 73021, 4, true),
          se = rotatedUncertainty(
            result.identified,
            result.covariance,
            rotation,
            method,
            73021,
          ),
          reference = ref.delta[method],
          match = matchFactors(reference.pattern, rotation.pattern);
        expect(
          maxDiff(
            rotation.pattern.map((row) =>
              match.mapping.map((j, i) => row[j!] * match.signs[i]),
            ),
            reference.pattern,
          ),
          `${method} numerical delta point fit`,
        ).toBeLessThan(1e-3);
        expect(
          maxDiff(
            se.pattern.map((row) => match.mapping.map((j) => row[j!])),
            reference.se.pattern,
          ),
          `${method} numerical delta loading SE`,
        ).toBeLessThan(1e-4);
        expect(
          maxDiff(
            se.structure.map((row) => match.mapping.map((j) => row[j!])),
            reference.se.structure,
          ),
          `${method} numerical delta structure SE`,
        ).toBeLessThan(1e-4);
        expect(
          maxDiff(
            match.mapping.map((i) => match.mapping.map((j) => se.phi[i!][j!])),
            reference.se.phi,
          ),
          `${method} numerical delta phi SE`,
        ).toBeLessThan(1e-4);
        expect(
          Math.max(
            ...se.uniquenesses.map((v, i) =>
              Math.abs(v - reference.se.communalities[i]),
            ),
          ),
          `${method} numerical delta uniqueness SE`,
        ).toBeLessThan(1e-4);
      }
    });
  it("bounded symmetric case blocks reproduce the independent moment-space correction", () => {
    const { data, correlation } = weightedFixture("pairwise"),
      moments = weightedMoments(data, correlation),
      fit = extractDwls(correlation.matrix, moments, 2),
      a = weightedInference(
        data,
        moments,
        fit.loadings,
        fit.convergence.objective,
      ),
      b = weightedInference(
        data,
        moments,
        fit.loadings,
        fit.convergence.objective,
        undefined,
        { space: "cases", blockSize: 31 },
      );
    expect(Math.abs(a.test.trace - b.test.trace)).toBeLessThan(1e-10);
    expect(Math.abs(a.test.traceSquared - b.test.traceSquared)).toBeLessThan(
      1e-10,
    );
    expect(
      maxDiff(a.covariance.to2DArray(), b.covariance.to2DArray()),
    ).toBeLessThan(1e-10);
  });
  it("asynchronous kernel execution preserves the correction and rejects malformed backend output", async () => {
    const { data, correlation } = weightedFixture("pairwise");
    const moments = weightedMoments(data, correlation);
    const fit = extractDwls(correlation.matrix, moments, 2);
    const args = [data, moments, fit.loadings, fit.convergence.objective, undefined, { space: "cases" as const, blockSize: 31 }] as const;
    const expected = weightedInference(...args);
    let calls = 0;
    const actual = await weightedInferenceWithKernel(async block => {
      calls++;
      return cpuTraceBlock(block);
    }, ...args);
    expect(calls).toBeGreaterThan(1);
    expect(actual.test).toEqual(expected.test);
    expect(actual.covariance.to2DArray()).toEqual(expected.covariance.to2DArray());
    const resident = await weightedInferenceWithKernel(async block => {
      const ordinal = block.ordinal!;
      const { source, leftStart, rightStart, leftRows, rightRows } = ordinal;
      // A resident backend must be able to complete without expanding either
      // lazy block in the coordinator. Reconstruct from the encoded source to
      // check masks, pair lookup indexing, and weights independently.
      Object.defineProperties(block, {
        left: { get() { throw new Error("Expanded left block was accessed"); } },
        right: { get() { throw new Error("Expanded right block was accessed"); } },
      });
      const rows = (start: number, length: number) => Array.from({ length }, (_, offset) =>
        Float64Array.from(source.pairs, (pair, index) => {
          const i = pair.i * source.nRows + start + offset;
          const j = pair.j * source.nRows + start + offset;
          return source.observed[i] && source.observed[j]
            ? pair.values[source.codes[i] * pair.columns + source.codes[j]] * source.rootWeights[index]
            : 0;
        }));
      return cpuTraceBlock({ left: rows(leftStart, leftRows), right: rows(rightStart, rightRows), leftProjection: source.projection.slice(leftStart, leftStart + leftRows), rightProjection: source.projection.slice(rightStart, rightStart + rightRows), diagonal: block.diagonal });
    }, ...args);
    expect(resident.test).toEqual(expected.test);
    expect(resident.covariance.to2DArray()).toEqual(expected.covariance.to2DArray());
    await expect(weightedInferenceWithKernel(async () => new Float64Array(1), ...args)).rejects.toThrow(/block shape/);
    await expect(weightedInferenceWithKernel(async block => new Float64Array(block.left.length * block.right.length).fill(NaN), ...args)).rejects.toThrow(/non-finite/);
    await expect(weightedInferenceWithKernel(async () => { throw new Error("GPU device lost"); }, ...args)).rejects.toThrow(/GPU device lost/);
  });
  it("orientation removes only the arbitrary orthogonal degrees of freedom", () => {
    const a = [
        [0.7, 0.1],
        [0.2, 0.8],
        [0.3, 0.5],
        [0.6, -0.1],
        [0.1, 0.6],
      ],
      b = identifyLoadings(a);
    expect(b.free.length).toBe(9);
    expect(
      maxDiff(
        new Matrix(a).mmul(new Matrix(a).transpose()).to2DArray(),
        new Matrix(b.loadings)
          .mmul(new Matrix(b.loadings).transpose())
          .to2DArray(),
      ),
    ).toBeLessThan(1e-12);
    expect(() =>
      identifyLoadings([
        [0.7, 0.7],
        [0.4, 0.4],
        [0.2, 0.2],
      ]),
    ).toThrow(/independent directions/);
  });
  it("500-item inference selects bounded case space and rejects excessive factor allocations", () => {
    const plan = planWeightedInference(500, 5, 20000);
    expect(plan.space).toBe("cases");
    expect(plan.estimatedBytes).toBeLessThan(1024 ** 3);
    expect(plan.approximateMultiplyAdds).toBeGreaterThan(1e13);
    expect(() => planWeightedInference(500, 20, 20000)).toThrow(
      /worker budget/,
    );
    expect(() =>
      planWeightedInference(500, 5, 20000, undefined, { space: "moments" }),
    ).toThrow(/worker budget/);
  });
});
describe("Independent pinned R DWLS extraction", () => {
  for (const name of ["normal", "heavy-tail", "skew", "pairwise", "complete"])
    it(name, () => {
      const { ref, data, correlation } = weightedFixture(name),
        moments = weightedMoments(data, correlation),
        extraction = extractDwls(correlation.matrix, moments, 2);
      expect(extraction.convergence.gradient).toBeLessThan(1e-8);
      expect(
        Math.abs(
          (data.nRows - 1) * extraction.convergence.objective -
            ref.fits.oblimin.test.standard.stat,
        ),
      ).toBeLessThan(1e-4);
      for (const method of ["oblimin", "varimax"] as const) {
        const actual = rotate(extraction.loadings, method, 73021, 4, true),
          r = ref.fits[method],
          { mapping, signs } = matchFactors(r.est.lambda, actual.pattern);
        expect(
          maxDiff(
            actual.pattern.map((row) =>
              mapping.map((j, i) => row[j!] * signs[i]),
            ),
            r.est.lambda,
          ),
        ).toBeLessThan(1e-3);
        expect(
          maxDiff(
            mapping.map((i, a) =>
              mapping.map((j, b) => actual.phi[i!][j!] * signs[a] * signs[b]),
            ),
            r.est.psi,
          ),
        ).toBeLessThan(1e-3);
        const model = new Matrix(actual.pattern)
          .mmul(new Matrix(actual.phi))
          .mmul(new Matrix(actual.pattern).transpose());
        const reference = new Matrix(r.est.lambda)
          .mmul(new Matrix(r.est.psi))
          .mmul(new Matrix(r.est.lambda).transpose());
        expect(maxDiff(model.to2DArray(), reference.to2DArray())).toBeLessThan(
          1e-4,
        );
      }
    });
  it("analytic weighted loading gradient matches independent finite differences", () => {
    const { data, correlation } = weightedFixture("pairwise"),
      moments = weightedMoments(data, correlation),
      x = Array.from({ length: 16 }, (_, i) => 0.15 + 0.02 * i),
      actual = dwlsObjective(correlation.matrix, moments, 2, x);
    for (let a = 0; a < x.length; a++) {
      const hi = x.slice(),
        lo = x.slice();
      hi[a] += 1e-6;
      lo[a] -= 1e-6;
      expect(
        Math.abs(
          (dwlsObjective(correlation.matrix, moments, 2, hi).value -
            dwlsObjective(correlation.matrix, moments, 2, lo).value) /
            2e-6 -
            actual.gradient[a],
        ),
      ).toBeLessThan(1e-8);
    }
  });
});

describe("Weighted failures and explicit method boundaries", () => {
  it("rejects near-boundary correlations and stale pair counts", () => {
    const { data, correlation } = weightedFixture("normal"),
      pair = correlation.pairs[0];
    expect(() => pairInfluence(data, { ...pair, boundary: true })).toThrow(
      /near-boundary/,
    );
    expect(() => pairInfluence(data, { ...pair, n: pair.n - 1 })).toThrow(
      /snapshot/,
    );
  });
  it("uses zero contribution for respondents missing either pair item", () => {
    const { data, correlation } = weightedFixture("pairwise"),
      moments = weightedMoments(data, correlation);
    let checked = 0;
    for (const pair of moments.pairs)
      for (let row = 0; row < data.nRows; row++)
        if (
          !data.observed[pair.i * data.nRows + row] ||
          !data.observed[pair.j * data.nRows + row]
        ) {
          expect(influenceAt(data, pair, row)).toBe(0);
          checked++;
        }
    expect(checked).toBeGreaterThan(0);
  });
  it("does not substitute an extractor or accept invalid weights", () => {
    const { data, correlation } = weightedFixture("normal"),
      moments = weightedMoments(data, correlation);
    expect(() =>
      extractDwls(correlation.matrix, moments, 2, undefined, 0),
    ).toThrow(/DWLS did not converge/);
    expect(() => extractDwls(correlation.matrix, moments, 7)).toThrow(
      /Underidentified/,
    );
    moments.weights[0] = 0;
    expect(() => extractDwls(correlation.matrix, moments, 2)).toThrow(
      /positive variance weight/,
    );
  });
  it("retains a mathematically improper weighted solution without imposing MINRES bounds", () => {
    const p = 5,
      matrix = Array.from({ length: p }, (_, i) =>
        Array.from({ length: p }, (_, j) =>
          i === j ? 1 : i === 0 || j === 0 ? 0.7 : 0.35,
        ),
      ),
      pairs = [];
    for (let i = 0; i < p - 1; i++)
      for (let j = i + 1; j < p; j++)
        pairs.push({
          i,
          j,
          n: 1000,
          columns: 2,
          values: new Float64Array(4),
          variance: 1,
        });
    const result = extractDwls(
      matrix,
      {
        pairs,
        weights: new Float64Array(10).fill(1),
        nRows: 1000,
        method: "test weights",
      },
      1,
    );
    expect(result.uniquenessParameters[0]).toBeLessThan(-0.39);
    expect(result.convergence.objective).toBeLessThan(1e-14);
    expect(result.boundaryItems).toEqual([]);
  });
  it("marks the robust chi-square unavailable for a just-identified model", () => {
    const { input, spec } = weightedFixture("normal");
    spec.items = spec.items.slice(0, 3);
    spec.nFactors = 1;
    const data = prepareEfa(
        input,
        spec,
        Array.from({ length: input.nRows }, (_, i) => i),
      ),
      correlation = correlate(data),
      moments = weightedMoments(data, correlation),
      fit = extractDwls(correlation.matrix, moments, 1),
      result = weightedInference(
        data,
        moments,
        fit.loadings,
        fit.convergence.objective,
      );
    expect(result.test.df).toBe(0);
    expect(result.test.statistic).toBeNull();
    expect(result.test.pValue).toBeNull();
  });
});
