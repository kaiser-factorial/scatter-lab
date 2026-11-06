import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  augmentConditional,
  fitOrdinal,
  ordinalProbabilities,
  drawOrdinal,
  binaryConditionalDraw,
  ordinalObjective,
} from "../efa/ordinal-regression";
type Case = {
  name: string;
  x: number[][];
  y: (number | null)[];
  levels: number;
  uniforms: number[] | number;
  normals: number[];
  augmented: number;
  expected: {
    coefficients: number[];
    thresholds: number[];
    objective: number;
    probabilities: number[][] | number[];
    draws: number[] | number;
    beta: number[];
    covariance: number[][];
    sampled: number[];
  };
  stableReference?: {
    coefficients: number[];
    thresholds: number[];
    objective: number;
    probabilities: number[][];
  };
};
const path = new URL(
  "./fixtures/efa-extensions/conditional.reference.json",
  import.meta.url,
);
const fixture = JSON.parse(readFileSync(path, "utf8")) as {
  cases: Record<string, Case>;
};
const flat = (v: unknown): number[] =>
  Array.isArray(v) ? v.flat(Infinity) : [v as number];
const difference = (a: unknown, b: unknown) => {
  const x = flat(a),
    y = flat(b);
  expect(x.length).toBe(y.length);
  return Math.max(...x.map((v, i) => Math.abs(v - y[i])));
};
describe("independent pinned mice/MASS conditional references", () => {
  for (const c of Object.values(fixture.cases))
    it(c.name, () => {
      const uniforms = Array.isArray(c.uniforms) ? c.uniforms : [c.uniforms];
      expect(augmentConditional(c.x, c.y, c.levels).augmented).toBe(
        c.augmented,
      );
      if (c.levels === 2) {
        const result = binaryConditionalDraw(c.x, c.y, c.normals, uniforms);
        expect(difference(result.beta, c.expected.beta)).toBeLessThan(1e-5);
        expect(
          difference(result.covariance, c.expected.covariance),
        ).toBeLessThan(1e-5);
        expect(difference(result.sampled, c.expected.sampled)).toBeLessThan(
          1e-5,
        );
        expect(
          difference(result.probabilities, c.expected.probabilities),
        ).toBeLessThan(1e-5);
        expect(result.draws).toEqual(flat(c.expected.draws));
      } else {
        const result = fitOrdinal(c.x, c.y, c.levels),
          probabilities = ordinalProbabilities(
            result,
            c.x.filter((_, i) => c.y[i] === null),
          );
        const reference = c.stableReference ?? c.expected;
        expect(
          difference(result.coefficients, reference.coefficients),
        ).toBeLessThan(1e-4);
        expect(
          difference(result.thresholds, reference.thresholds),
        ).toBeLessThan(1e-4);
        expect(Math.abs(result.objective - reference.objective)).toBeLessThan(
          1e-6,
        );
        expect(difference(probabilities, reference.probabilities)).toBeLessThan(
          1e-5,
        );
        expect(drawOrdinal(probabilities, uniforms)).toEqual(
          flat(c.expected.draws),
        );
      }
    });
});
it("has a correct analytic gradient, including transformed ordered thresholds", () => {
  const c = fixture.cases.ordinal,
    data = augmentConditional(c.x, c.y, c.levels),
    objective = ordinalObjective(data, c.levels),
    v = [0.3, -0.1, 0.2, -1, 0, 0.1, -0.2],
    gradient = objective(v).gradient;
  for (let j = 0; j < v.length; j++) {
    const a = v.slice(),
      b = v.slice();
    a[j] += 1e-5;
    b[j] -= 1e-5;
    expect(
      Math.abs(gradient[j] - (objective(a).value - objective(b).value) / 2e-5),
    ).toBeLessThan(1e-7);
  }
});
it("rejects empty categories and constant predictors instead of switching models", () => {
  expect(() => fitOrdinal([[0], [1], [2]], [0, 1, null], 3)).toThrow(
    /Every declared/,
  );
  expect(() => fitOrdinal([[1], [1], [1], [1]], [0, 1, null, null], 2)).toThrow(
    /constant/,
  );
});
it("never draws a zero-probability category at a zero uniform and rejects invalid probability rows", () => {
  expect(drawOrdinal([[0, 0.5, 0.5]], [0])).toEqual([1]);
  expect(() => drawOrdinal([[0, 0]], [0.5])).toThrow(/Invalid/);
  expect(() => drawOrdinal([[0.5, 0.5]], [NaN])).toThrow(/Invalid/);
});
