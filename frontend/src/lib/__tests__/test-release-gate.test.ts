import { describe, expect, it } from 'vitest';
import { toolsFor } from '../assistant';
import { KS_DISABLED_REASON, type TestKind, type TestPlan } from '../analysisPlan';
import { compileChart } from '../chartCompile';
import { policyFor, type DataMode } from '../dataPolicy';
import { runTestPlan } from '../statTests';
import type { DataTable } from '../table';
import { analysisProfileOf, validatePlan } from '../validators';

const table = (data: Record<string, unknown[]>): DataTable => ({
  columns: Object.keys(data), data, nRows: Object.values(data)[0]?.length ?? 0,
});
const grouped = (...groups: unknown[][]): DataTable => table({
  score: groups.flat(),
  condition: groups.flatMap((values, i) => values.map(() => `group${i + 1}`)),
});
const planFor = (test: TestKind): TestPlan => ({
  kind: 'test', test, column: 'score', groupBy: 'condition',
});
const run = (test: TestKind, data: DataTable, mode: DataMode = 'open') =>
  runTestPlan({ ...planFor(test), ...(test !== 'chi_square' ? {
    // Reference fixtures define A minus B; profiles otherwise order by count.
    groups: [...new Set(data.data.condition.map(String))],
  } : {}) }, data, analysisProfileOf(data, policyFor(mode)));
const contingency = (counts: number[][]): DataTable => {
  const score: string[] = [], condition: string[] = [];
  counts.forEach((row, i) => row.forEach((n, j) => {
    score.push(...Array<string>(n).fill(`row${i + 1}`));
    condition.push(...Array<string>(n).fill(`col${j + 1}`));
  }));
  return table({ score, condition });
};
const failureMessage = (action: () => unknown): string => {
  try { action(); } catch (error) { return (error as Error).message; }
  throw new Error('Expected inference to be rejected.');
};

describe('temporary significance-test release gate', () => {
  it.each(['open', 'private'] as const)('does not advertise KS in %s mode', mode => {
    const tool = toolsFor(policyFor(mode)).find(t => t.type === 'function' && t.function.name === 'run_test');
    expect(tool?.type).toBe('function');
    if (!tool || tool.type !== 'function') throw new Error('run_test tool is missing');
    const parameters = tool.function.parameters as { properties: { test: { enum: string[] } } };
    expect(parameters.properties.test.enum).toEqual(['t', 'mann_whitney', 'kruskal_wallis', 'chi_square']);
    expect(tool.function.description).not.toMatch(/EXACT p|exact p-value/i);
  });

  it('rejects stale KS plans before accessing dataset columns, including direct execution', () => {
    const empty = table({});
    const profile = analysisProfileOf(empty, policyFor('open'));
    const failures = validatePlan(planFor('ks'), profile);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code: 'test_unavailable', message: KS_DISABLED_REASON });
    expect(() => runTestPlan(planFor('ks'), empty, profile)).toThrow(KS_DISABLED_REASON);
  });

  it('keeps descriptive ECDF comparisons available', () => {
    const data = grouped([1, 2, 2, 3], [2, 3, 3, 4]);
    const profile = analysisProfileOf(data, policyFor('open'));
    const plan = { kind: 'chart', mark: 'ecdf', column: 'score', groupBy: 'condition' } as const;
    expect(validatePlan(plan, profile)).toEqual([]);
    expect(compileChart(plan, data, profile).summary).toMatch(/ECDF|cumulative/i);
  });

  it('does not let direct dispatch bypass private category validation', () => {
    const data = grouped([1, 2], [3, 4, 5, 6, 7, 8]);
    const profile = analysisProfileOf(data, policyFor('private'));
    expect(() => runTestPlan({ ...planFor('t'), groups: ['group1', 'group2'] }, data, profile))
      .toThrow(/unknown_group_value/);
  });
});

describe('retained reference calculations through the application dispatcher', () => {
  // Expected values are the retained R 4.5.1 public-reference fixtures, not
  // values recomputed with the kernels under test. See packages/statistics/
  // test/fixtures/public.reference.json: unequal-groups, tied-ordinal, tied,
  // and two-by-two. This checks that containment preserves those conventions.
  it('preserves the Welch reference, interval, and declared inference scope', () => {
    const result = run('t', grouped(
      Array.from({ length: 10 }, (_, i) => i + 1),
      Array.from({ length: 14 }, (_, i) => i + 7),
    ));
    expect(result.statistic).toBeCloseTo(-5.4349297638940595, 10);
    expect(result.df).toBeCloseTo(21.982212340189, 10);
    expect(result.p).toBeCloseTo(1.8552818325118105e-5, 10);
    expect(result.ci95?.[0]).toBeCloseTo(-11.052801725158162, 9);
    expect(result.ci95?.[1]).toBeCloseTo(-4.947198274841839, 9);
    expect(result.caveats.join(' ')).toMatch(/p-value method/i);
    expect(result.caveats.join(' ')).toMatch(/independent/i);
  });

  it('preserves tie-corrected approximate Mann–Whitney inference', () => {
    const result = run('mann_whitney', grouped([1, 2, 2, 3, 4, 4, 4, 5], [2, 2, 3, 3, 3, 5, 5, 6, 6]));
    expect(result.statistic).toBe(26.5);
    expect(Math.abs(result.p - 0.35194254112130485)).toBeLessThan(1.6e-7);
    expect(result.effect.value).toBeCloseTo(0.26388888888888884, 12);
    expect(result.caveats.join(' ')).toMatch(/normal approximation/i);
  });

  it('preserves tie-corrected Kruskal–Wallis inference', () => {
    const result = run('kruskal_wallis', grouped([1, 1, 2, 3, 4], [2, 2, 3, 3, 4], [1, 2, 4, 4, 5]));
    expect(result.statistic).toBeCloseTo(1.4684210526315749, 10);
    expect(result.df).toBe(2);
    expect(result.p).toBeCloseTo(0.47988416538589407, 10);
    expect(result.caveats.join(' ')).toMatch(/asymptotic/i);
  });

  it('preserves Pearson chi-square without continuity correction', () => {
    const result = run('chi_square', contingency([[10, 20], [30, 40]]));
    expect(result.statistic).toBeCloseTo(0.7936507936507936, 10);
    expect(result.df).toBe(1);
    expect(result.p).toBeCloseTo(0.3729984836134872, 10);
    expect(result.effect.value).toBeCloseTo(0.0890870806374748, 10);
    expect(result.caveats.join(' ')).toMatch(/without Yates/i);
  });
});

describe('actual-sample and degenerate-input containment', () => {
  it.each([
    ['t', 1], ['mann_whitney', 7], ['kruskal_wallis', 4],
  ] as const)('rejects %s when missing outcomes leave only %i usable observations', (test, usable) => {
    const values = Array.from({ length: usable }, (_, i) => i + 1);
    const data = grouped([...values, ...Array(10 - usable).fill(null)], Array.from({ length: 10 }, (_, i) => i + 10));
    const profile = analysisProfileOf(data, policyFor('open'));
    expect(validatePlan(planFor(test), profile)).toEqual([]);
    expect(() => runTestPlan(planFor(test), data, profile)).toThrow(/usable numeric observations/i);
  });

  it('keeps private usable-sample refusals independent of exact small counts', () => {
    const reject = (usable: number) => failureMessage(() => run('t', grouped(
      [...Array.from({ length: usable }, (_, i) => i + 1), ...Array(10 - usable).fill(null)],
      Array.from({ length: 10 }, (_, i) => i + 10),
    ), 'private'));
    const three = reject(3), four = reject(4);
    expect(three).toBe(four);
    expect(three).toMatch(/aggregate reporting/i);
  });

  it.each(['t', 'mann_whitney', 'kruskal_wallis'] as const)('rejects degenerate %s inference', test => {
    expect(() => run(test, grouped(Array(10).fill(2), Array(10).fill(2))))
      .toThrow(/variance|all.*equal/i);
  });

  it('rejects sparse chi-square approximation instead of returning a p-value', () => {
    expect(() => run('chi_square', contingency([[1, 2], [3, 4]])))
      .toThrow(/expected count/i);
  });

  it('rejects a contingency margin emptied by joint missingness', () => {
    const data = table({
      score: ['a', 'a', 'b', 'b', 'b', 'b'],
      condition: [null, null, 'x', 'y', 'x', 'y'],
    });
    expect(() => run('chi_square', data)).toThrow(/positive row and column counts/i);
  });

  it('applies the private aggregate floor to usable contingency margins', () => {
    const reject = (usable: number) => {
      const dense = contingency([[10, 10]]);
      const data = table({
        score: [...Array(10).fill('rare-after-missing'), ...dense.data.score],
        condition: [...Array(usable).fill('col1'), ...Array(10 - usable).fill(null), ...dense.data.condition],
      });
      return failureMessage(() => run('chi_square', data, 'private'));
    };
    expect(reject(3)).toBe(reject(4));
    expect(reject(3)).toMatch(/aggregate reporting/i);
  });

  it('refuses a nonfinite numeric result rather than displaying a p-value', () => {
    const large = Array.from({ length: 10 }, (_, i) => (i + 1) * 1e200);
    expect(() => run('t', grouped(large, large.map(v => -v)))).toThrow(/finite|valid/i);
  });
});
