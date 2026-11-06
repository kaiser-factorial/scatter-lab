import { describe, expect, it } from 'vitest';
import { describeNumeric, correlation, compareGroups, welchT, mannWhitneyU, kruskalWallis, ksTwoSample, chiSquareTest } from '../src/stats';

describe('public statistics contracts', () => {
  it('makes sample/population denominators and absent observations explicit', () => {
    const result = describeNumeric([1, '2', 3, null, '', 'not numeric']);
    expect(result).toMatchObject({ n: 3, missing: 3, mean: 2, median: 2, variancePopulation: 2 / 3, varianceSample: 1 });
    expect(describeNumeric([7]).sdSample).toBeNull();
    expect(describeNumeric([null]).mean).toBeNull();
  });
  it('preserves full precision and existing pairwise/minimum observation semantics', () => {
    const r = correlation([1,2,3,4], [3,1,8,2]);
    expect(r.pearson).not.toBe(Number(r.pearson?.toFixed(4)));
    expect(correlation([1,2], [2,3]).pearson).toBeNull();
    expect(correlation([1,null,3,4], [2,7,4,8]).n).toBe(3);
    expect(compareGroups([1,3,5,7],['a','a','b','b']).groups[0]).toMatchObject({group:'b',mean:6,sd:Math.sqrt(2)});
  });
  it('returns complete Welch uncertainty without display rounding', () => {
    const result = welchT([1,2,3,4], [2,4,7,9]);
    expect(result.ci95).toHaveLength(2);
    expect(result.statistic).not.toBe(Number(result.statistic.toFixed(3)));
    expect(result.groups.map(g=>g.group)).toEqual(['a','b']);
  });
  it('identifies KS approximation and ties without silently claiming exact inference', () => {
    const tied = ksTwoSample([1, 2], [2, 5, 8]);
    expect(tied).toMatchObject({ pValueMethod: 'stephens-adjusted-asymptotic', continuousNullAssumption: true, tiesPresent: true, lowLambdaClamped: false });
    expect(tied.caveats.some(message => message.includes('not calibrated'))).toBe(true);
    const nullSample = ksTwoSample([1, 2, 3], [1, 2, 3]);
    expect(nullSample).toMatchObject({ statistic: 0, p: 1, lowLambdaClamped: true });
    expect(ksTwoSample([1, 3, 5], [2, 4, 6]).tiesPresent).toBe(false);
  });
  it('rejects undefined hypothesis-test domains at the public boundary', () => {
    expect(()=>welchT([1],[2,3])).toThrow();
    expect(()=>welchT([1,1],[2,2])).toThrow();
    expect(()=>mannWhitneyU([1,NaN],[2])).toThrow();
    expect(()=>ksTwoSample([],[2])).toThrow();
    expect(()=>kruskalWallis([{group:'a',values:[1,1]},{group:'b',values:[1]}])).toThrow();
    expect(()=>chiSquareTest(['a','b'],['x','y'],[[1,0],[2,0]])).toThrow();
    expect(()=>chiSquareTest(['a','b'],['x','y'],[[1,.5],[2,3]])).toThrow();
  });
});
