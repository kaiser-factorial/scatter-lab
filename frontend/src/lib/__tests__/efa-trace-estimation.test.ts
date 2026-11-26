import { describe, expect, it } from "vitest";
import { applyTraceOperatorCpu, probeSquaredNorms, rademacherProbes, summarizeTraceProbes } from "../efa/trace-estimation";
import type { OrdinalTraceSource } from "../efa/trace-kernel";

const source: OrdinalTraceSource = {
  nRows: 4,
  codes: new Uint16Array([0, 1, 0, 1, 1, 0, 1, 0]),
  observed: new Uint8Array([1, 1, 1, 1, 1, 1, 0, 1]),
  pairs: [{ i: 0, j: 1, n: 3, columns: 2, values: new Float64Array([1, 2, -3, 4]), variance: 1 }],
  rootWeights: new Float64Array([0.5]),
  projection: [[0.1], [-0.2], [0.3], [0.4]].map(row => new Float64Array(row)),
};

describe("Experimental matrix-free trace estimator", () => {
  it("applies the full symmetric residual operator including missing-pair zeros", () => {
    // Independent explicit A A' - Z Z' construction, including a missing response.
    const a = [1, -1.5, 0, -1.5], z = [0.1, -0.2, 0.3, 0.4];
    const v = new Float64Array([1, -2, 3, 4, -5, 6, 7, -8]);
    const actual = applyTraceOperatorCpu(source, v, 2);
    for (let row = 0; row < 4; row++) for (let col = 0; col < 2; col++) {
      const expected = a.reduce((s, _, r) => s + (a[row] * a[r] - z[row] * z[r]) * v[r * 2 + col], 0);
      expect(actual[row * 2 + col]).toBeCloseTo(expected, 12);
    }
  });

  it("has deterministic independent probe streams regardless of batching", () => {
    const whole = rademacherProbes(5, 13, 42), first = rademacherProbes(5, 6, 42), last = rademacherProbes(5, 7, 42, 6);
    for (let row = 0; row < 5; row++) expect(Array.from(whole.slice(row * 13, row * 13 + 13)))
      .toEqual([...first.slice(row * 6, row * 6 + 6), ...last.slice(row * 7, row * 7 + 7)]);
    expect([...new Set(whole)] .sort()).toEqual([-1, 1]);
    expect(rademacherProbes(5, 13, 43)).not.toEqual(whole);
  });

  it("averages to the exact squared trace over all Rademacher vectors", () => {
    const count = 16, v = new Float64Array(4 * count);
    for (let row = 0; row < 4; row++) for (let col = 0; col < count; col++) v[row * count + col] = col & (1 << row) ? 1 : -1;
    const a = [1, -1.5, 0, -1.5], z = [0.1, -0.2, 0.3, 0.4];
    let exact = 0;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) exact += (a[i] * a[j] - z[i] * z[j]) ** 2;
    const result = summarizeTraceProbes(probeSquaredNorms(applyTraceOperatorCpu(source, v, count), count));
    expect(result.traceSquared).toBeCloseTo(exact, 12);
    expect(result.approximate).toBe(true);
    expect(result.monteCarloSE).toBeGreaterThan(0);
  });

  it("reports empirical sampling uncertainty separately and rejects invalid inputs", () => {
    expect(summarizeTraceProbes([10, 10, 10])).toMatchObject({ traceSquared: 10, monteCarloSE: 0, normalInterval95: [10, 10] });
    expect(summarizeTraceProbes([2, 4])).toMatchObject({ traceSquared: 3, monteCarloSE: 1 });
    expect(() => summarizeTraceProbes([1])).toThrow();
    expect(() => summarizeTraceProbes([NaN, 1])).toThrow();
    expect(() => probeSquaredNorms(new Float64Array([NaN]), 1)).toThrow();
    expect(() => applyTraceOperatorCpu(source, new Float64Array(3), 1)).toThrow();
    expect(() => rademacherProbes(2, 0, 1)).toThrow();
  });
});
