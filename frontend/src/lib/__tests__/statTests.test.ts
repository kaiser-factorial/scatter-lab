import { describe, it, expect } from 'vitest';
import {
  chiSquareSf, chiSquareTest, crossCounts, formatTestResult, groupValues,
  kruskalWallis, ksTwoSample, mannWhitneyU, normalCdf, tTwoSidedP, tCritical, welchT,
} from '../statTests';

// Reference values come from OUTSIDE this implementation: R's documented
// t.test example, and hand-computed rank/chi-square cases small enough to
// verify on paper. That is the point — the tests must not re-derive the
// answer with the code under test.

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

describe('numeric core', () => {
  it('normalCdf matches known quantiles', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 5);
    expect(normalCdf(-1.644854)).toBeCloseTo(0.05, 5);
  });

  it('t distribution: two-sided p and critical values', () => {
    // R: 2*pt(-2, df=10) = 0.07338803
    expect(tTwoSidedP(2, 10)).toBeCloseTo(0.07338803, 6);
    // R: qt(0.975, df=10) = 2.228139
    expect(tCritical(10)).toBeCloseTo(2.228139, 4);
  });

  it('chi-square survival function', () => {
    // R: pchisq(7.2, df=2, lower.tail=FALSE) = exp(-3.6) = 0.02732372
    expect(chiSquareSf(7.2, 2)).toBeCloseTo(Math.exp(-3.6), 8);
    // R: pchisq(3.841459, df=1, lower.tail=FALSE) = 0.05
    expect(chiSquareSf(3.841459, 1)).toBeCloseTo(0.05, 5);
  });
});

describe('welchT', () => {
  it("matches R's documented t.test(1:10, 7:20) example", () => {
    const r = welchT(range(1, 10), range(7, 20), ['a', 'b']);
    expect(r.statistic).toBeCloseTo(-5.4349, 3);
    expect(r.df!).toBeCloseTo(21.982, 2);
    expect(r.p).toBeCloseTo(1.855e-5, 7);
    expect(r.ci95![0]).toBeCloseTo(-11.0528, 3);
    expect(r.ci95![1]).toBeCloseTo(-4.9472, 3);
    expect(r.groups).toEqual([{ group: 'a', n: 10 }, { group: 'b', n: 14 }]);
  });

  it("outlier variant t.test(1:10, c(7:20, 200)) from the R docs", () => {
    const r = welchT(range(1, 10), [...range(7, 20), 200], ['a', 'b']);
    expect(r.statistic).toBeCloseTo(-1.6329, 3);
    expect(r.df!).toBeCloseTo(14.165, 2);
    expect(r.p).toBeCloseTo(0.1245, 3);
  });
});

describe('mannWhitneyU', () => {
  it('hand-computed no-overlap case', () => {
    // a=[1,2,3], b=[4,5,6]: U=0, mu=4.5, sigma=sqrt(5.25), z=-1.9640
    const r = mannWhitneyU([1, 2, 3], [4, 5, 6], ['a', 'b']);
    expect(r.statistic).toBe(0);
    const z = -4.5 / Math.sqrt(5.25);
    expect(r.p).toBeCloseTo(2 * normalCdf(z), 10);
    expect(r.effect.value).toBe(1); // rank-biserial: complete separation
    expect(r.caveats.some(c => c.includes('Small groups'))).toBe(true);
  });

  it('ties trigger the correction caveat and keep p in [0,1]', () => {
    const r = mannWhitneyU([1, 2, 2, 3], [2, 3, 3, 4], ['a', 'b']);
    expect(r.caveats.some(c => c.includes('Ties'))).toBe(true);
    expect(r.p).toBeGreaterThan(0);
    expect(r.p).toBeLessThanOrEqual(1);
  });
});

describe('kruskalWallis', () => {
  it('hand-computed three-group case: H = 7.2', () => {
    // Groups [1..3],[4..6],[7..9]: mean ranks 2/5/8 → H = 12/90 * 54 = 7.2
    const r = kruskalWallis([
      { group: 'a', values: [1, 2, 3] },
      { group: 'b', values: [4, 5, 6] },
      { group: 'c', values: [7, 8, 9] },
    ]);
    expect(r.statistic).toBeCloseTo(7.2, 10);
    expect(r.df).toBe(2);
    expect(r.p).toBeCloseTo(Math.exp(-3.6), 8);
    // epsilon² = H(n+1)/(n²-1) = 7.2*10/80 = 0.9
    expect(r.effect.value).toBeCloseTo(0.9, 10);
  });
});

describe('ksTwoSample', () => {
  it('complete separation gives D = 1', () => {
    const r = ksTwoSample([1, 2, 3, 4, 5], [6, 7, 8, 9, 10], ['a', 'b']);
    expect(r.statistic).toBe(1);
    expect(r.p).toBeLessThan(0.05);
  });

  it('identical samples give D = 0, p = 1', () => {
    const r = ksTwoSample([1, 2, 3, 4], [1, 2, 3, 4], ['a', 'b']);
    expect(r.statistic).toBe(0);
    expect(r.p).toBe(1);
  });
});

describe('chiSquareTest', () => {
  it('hand-computed 2x2: chi² = 100·(400-600)²/(30·70·40·60)', () => {
    const r = chiSquareTest(['r1', 'r2'], ['c1', 'c2'], [[10, 20], [30, 40]]);
    expect(r.statistic).toBeCloseTo(100 * 40000 / (30 * 70 * 40 * 60), 10);
    expect(r.df).toBe(1);
    expect(r.effect.value).toBeCloseTo(Math.sqrt(r.statistic / 100), 10);
    expect(r.caveats).toEqual([]);
  });

  it('flags low expected counts', () => {
    const r = chiSquareTest(['r1', 'r2'], ['c1', 'c2'], [[1, 2], [3, 4]]);
    expect(r.caveats.some(c => c.includes('below 5'))).toBe(true);
  });
});

describe('column-level helpers', () => {
  it('groupValues extracts numerics per requested group, plan-ordered', () => {
    const g = groupValues(
      [1, '2', 'x', 4, null, 6], ['a', 'b', 'a', 'b', 'a', 'c'], ['b', 'a'],
    );
    expect(g).toEqual([
      { group: 'b', values: [2, 4] },
      { group: 'a', values: [1] },
    ]);
  });

  it('crossCounts builds the contingency table over given levels', () => {
    expect(crossCounts(
      ['x', 'x', 'y', 'y', 'y', null], ['p', 'q', 'p', 'p', 'q', 'p'], ['x', 'y'], ['p', 'q'],
    )).toEqual([[1, 1], [2, 1]]);
  });

  it('formatTestResult renders stat, p, CI, effect and caveats', () => {
    const text = formatTestResult(welchT(range(1, 10), range(7, 20), ['low', 'high']));
    expect(text).toContain('t=-5.435');
    expect(text).toContain('df=21.98');
    expect(text).toContain('95% CI [-11.053, -4.947]');
    expect(text).toContain("Cohen's d");
    expect(text).toContain('low (n=10), high (n=14)');
  });
});
