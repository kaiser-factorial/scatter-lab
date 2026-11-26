import { describe, expect, it } from 'vitest';
import { correlation, type Cell } from '../stats';

const permutations = (values: number[]): number[][] => values.length === 0 ? [[]]
  : values.flatMap((value, i) => permutations(values.filter((_, j) => i !== j))
    .map(rest => [value, ...rest]));

// Independent, deliberately slow oracle: enumerate every allowable row order,
// compute the paper's statistic with direct rank counts, then take the mean.
// This checks the optimized tie expectation without reproducing its algorithm.
const enumeratedXi = (x: number[], y: number[]): number | null => {
  const n = x.length;
  const ranks = y.map(value => y.filter(other => other <= value).length);
  const upper = y.map(value => y.filter(other => other >= value).length);
  const denominator = 2 * upper.reduce((sum, l) => sum + l * (n - l), 0);
  if (!denominator) return null;
  const orders = permutations(x.map((_, i) => i))
    .filter(order => order.every((index, i) => i === 0 || x[order[i - 1]] <= x[index]));
  return orders.reduce((sum, order) => {
    const variation = order.slice(1).reduce((gap, index, i) => gap + Math.abs(ranks[index] - ranks[order[i]]), 0);
    return sum + 1 - n * variation / denominator;
  }, 0) / orders.length;
};

describe('Chatterjee correlation', () => {
  it('matches hand-computed distinct-rank values without changing Pearson or Spearman', () => {
    const result = correlation([1, 2, 3, 4, 5], [1, 3, 2, 5, 4]);
    // Consecutive rank gaps: 2 + 1 + 3 + 1 = 7; xi = 1 - 3*7/24.
    expect(result.chatterjee).toBeCloseTo(1 / 8, 12);
    expect(result.chatterjeeReverse).toBeCloseTo(1 / 8, 12);
    expect(result.pearson).toBeCloseTo(0.8, 12);
    expect(result.spearman).toBeCloseTo(0.8, 12);
  });

  it('keeps the finite-sample maximum below one for increasing and decreasing functions', () => {
    for (const y of [[1, 2, 3, 4, 5], [5, 4, 3, 2, 1]]) {
      const result = correlation([1, 2, 3, 4, 5], y);
      expect(result.chatterjee).toBeCloseTo((5 - 2) / (5 + 1), 12);
      expect(result.chatterjeeReverse).toBeCloseTo(0.5, 12);
    }
  });

  it('uses max ranks and the general denominator for tied responses', () => {
    // r = [2,2,4,4,5], l = [5,5,3,3,1], sum gaps=3, sum l(n-l)=16.
    expect(correlation([1, 2, 3, 4, 5], [1, 1, 2, 2, 3]).chatterjee)
      .toBeCloseTo(1 - 15 / 32, 12);
  });

  it('matches exhaustive tie averaging for all 3^4 responses across five predictor patterns', () => {
    const predictors = [[0, 1, 2, 3], [0, 0, 1, 1], [0, 0, 0, 1], [0, 0, 0, 0], [0, 1, 1, 2]];
    for (const x of predictors) {
      for (let encoded = 0; encoded < 81; encoded++) {
        const y = Array.from({ length: 4 }, (_, i) => Math.floor(encoded / 3 ** i) % 3);
        const result = correlation(x, y);
        const forward = enumeratedXi(x, y), reverse = enumeratedXi(y, x);
        if (forward === null) expect(result.chatterjee).toBeNull();
        else expect(result.chatterjee).toBeCloseTo(forward, 12);
        if (reverse === null) expect(result.chatterjeeReverse).toBeNull();
        else expect(result.chatterjeeReverse).toBeCloseTo(reverse, 12);
      }
    }
  });

  it('is invariant to row order, repeat calls, and strictly increasing transformations', () => {
    const x = [2, 1, 1, 2, 1, 3], y = [4, 5, 2, 1, 2, 3];
    const expected = correlation(x, y);
    for (const order of permutations([0, 1, 2, 3, 4, 5])) {
      const result = correlation(order.map(i => x[i]), order.map(i => y[i]));
      expect(result.chatterjee).toBe(expected.chatterjee);
      expect(result.chatterjeeReverse).toBe(expected.chatterjeeReverse);
    }
    const transformed = correlation(x.map(v => 10 + v ** 3), y.map(v => Math.exp(v)));
    expect(transformed.chatterjee).toBe(expected.chatterjee);
    expect(transformed.chatterjeeReverse).toBe(expected.chatterjeeReverse);
    expect(correlation(x, y)).toEqual(expected);
  });

  it('detects a nonlinear relationship missed by Pearson and reports different directions', () => {
    const x = Array.from({ length: 201 }, (_, i) => i - 100);
    const y = x.map(value => value ** 2);
    const result = correlation(x, y);
    expect(result.pearson).toBeCloseTo(0, 12);
    expect(result.spearman).toBeCloseTo(0, 12);
    expect(result.chatterjee).toBeGreaterThan(0.95);
    expect(result.chatterjeeReverse).toBeLessThan(0.3);
    const swapped = correlation(y, x);
    expect(swapped.chatterjee).toBe(result.chatterjeeReverse);
    expect(swapped.chatterjeeReverse).toBe(result.chatterjee);
  });

  it('preserves negative finite-sample estimates', () => {
    expect(correlation([1, 2, 3, 4, 5], [3, 1, 5, 2, 4]).chatterjee)
      .toBeCloseTo(-3 / 8, 12);
  });

  it('distinguishes a constant response from a constant predictor', () => {
    const result = correlation([1, 1, 1, 1, 1], [1, 2, 3, 4, 5]);
    expect(result.chatterjee).toBe(0);
    expect(result.chatterjeeReverse).toBeNull();
    const swapped = correlation([1, 2, 3, 4, 5], [1, 1, 1, 1, 1]);
    expect(swapped.chatterjee).toBeNull();
    expect(swapped.chatterjeeReverse).toBe(0);
    const both = correlation([1, 1, 1], [2, 2, 2]);
    expect(both.chatterjee).toBeNull();
    expect(both.chatterjeeReverse).toBeNull();
  });

  it.each([0, 1, 2])('requires three complete numeric pairs (n=%i)', n => {
    const result = correlation(Array.from({ length: n }, (_, i) => i), Array.from({ length: n }, (_, i) => i));
    expect(result.n).toBe(n);
    expect(result.chatterjee).toBeNull();
    expect(result.chatterjeeReverse).toBeNull();
  });

  it('shares pairwise missingness and numeric-string parsing, without mutating inputs', () => {
    const x: Cell[] = ['1', null, 2, ' ', 3, NaN, 4, Infinity, 5, 'bad', undefined, 99];
    const y: Cell[] = [1, 2, '3', 4, 2, 5, 5, 6, '4', 7, 8];
    const beforeX = x.slice(), beforeY = y.slice();
    expect(correlation(x, y)).toEqual(correlation([1, 2, 3, 4, 5], [1, 3, 2, 5, 4]));
    expect(x).toEqual(beforeX);
    expect(y).toEqual(beforeY);
    const empty = correlation([null, NaN, Infinity, ''], [1, 2, 3, 4]);
    expect(empty.n).toBe(0);
    expect(empty.chatterjee).toBeNull();
  });

  it('handles large tied groups without quadratic pair enumeration', () => {
    const x = Array.from({ length: 20_000 }, (_, i) => i < 10_000 ? 0 : 1);
    const result = correlation(x, x);
    expect(result.chatterjee).toBeCloseTo(1 - 1 / 10_000, 12);
    expect(result.chatterjeeReverse).toBe(result.chatterjee);
  });
});
