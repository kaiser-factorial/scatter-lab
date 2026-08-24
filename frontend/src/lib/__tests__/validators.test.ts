import { describe, it, expect } from 'vitest';
import { analysisProfileOf, isTemporalColumn, validatePlan } from '../validators';
import { formatFailures, MAX_GROUP_CARDINALITY, type AnalysisProfile } from '../analysisPlan';
import { policyFor } from '../dataPolicy';
import type { DataTable } from '../table';

// The validator is the assistant's gate for the analysis tools: every
// rejection must carry a machine-readable code, an imperative fix, and the
// legal options — and the mode fence must be an oracle-proof fence (a withheld
// value gets byte-for-byte the failure of a value that never existed).

const table = (data: Record<string, unknown[]>): DataTable => {
  const columns = Object.keys(data);
  return { columns, data: data as DataTable['data'], nRows: data[columns[0]].length };
};

// 12 rows: species has two big groups + one 1-row rare value; participant_id
// is an identifier; when is ISO dates; note is free text.
const fixture = table({
  participant_id: Array.from({ length: 12 }, (_, i) => `P${i + 1}`),
  sepal_len: [5.1, 4.9, 6.2, 5.8, 6.4, 5.5, 5.0, 6.0, 5.9, 6.1, 5.2, 6.3],
  species: ['setosa', 'setosa', 'setosa', 'setosa', 'setosa', 'setosa',
            'virginica', 'virginica', 'virginica', 'virginica', 'virginica', 'ghost_orchid'],
  when: Array.from({ length: 12 }, (_, i) => `2024-0${(i % 9) + 1}-15`),
  note: Array.from({ length: 12 }, (_, i) => `free text ${i}`),
});

const privateProfile = () => analysisProfileOf(fixture, policyFor('private'));
const openProfile = () => analysisProfileOf(fixture, policyFor('open'));

const codes = (profile: AnalysisProfile, plan: unknown) =>
  validatePlan(plan, profile).map(f => f.code);

describe('analysisProfileOf', () => {
  it('classifies columns: numeric, categorical, temporal, identifier', () => {
    const p = privateProfile();
    const by = Object.fromEntries(p.columns.map(c => [c.name, c]));
    expect(by.sepal_len.isNumeric).toBe(true);
    expect(by.species.isCategorical).toBe(true);
    expect(by.when.isTemporal).toBe(true);
    expect(by.participant_id.isIdentifier).toBe(true);
    expect(by.sepal_len.isTemporal).toBe(false);
  });

  it('withholds rare values and identifier values in private mode only', () => {
    const priv = privateProfile().columns.find(c => c.name === 'species')!;
    expect(priv.groups!.find(g => g.value === 'ghost_orchid')!.withheld).toBe(true);
    expect(priv.groups!.find(g => g.value === 'setosa')!.withheld).toBe(false);
    const open = openProfile().columns.find(c => c.name === 'species')!;
    expect(open.groups!.every(g => !g.withheld)).toBe(true);
  });
});

describe('isTemporalColumn', () => {
  it('accepts ISO and slash dates, rejects numbers and text', () => {
    expect(isTemporalColumn(['2024-01-05', '2024-02-06T10:00', null])).toBe(true);
    expect(isTemporalColumn(['3/14/2024', '12/1/2024'])).toBe(true);
    expect(isTemporalColumn([1998, 2001, 2024])).toBe(false);
    expect(isTemporalColumn(['north', 'south'])).toBe(false);
    expect(isTemporalColumn([])).toBe(false);
  });
});

describe('validatePlan — tests', () => {
  it('accepts a well-formed two-group t-test', () => {
    expect(validatePlan({
      kind: 'test', test: 't', column: 'sepal_len', groupBy: 'species',
      groups: ['setosa', 'virginica'],
    }, openProfile())).toEqual([]);
  });

  it('unknown column → unknown_column with the legal numeric columns', () => {
    const fails = validatePlan({
      kind: 'test', test: 't', column: 'sepal_widht', groupBy: 'species',
      groups: ['setosa', 'virginica'],
    }, openProfile());
    expect(fails.map(f => f.code)).toEqual(['unknown_column']);
    expect(fails[0].available).toContain('sepal_len');
    expect(fails[0].fix).toMatch(/numeric column/);
  });

  it('categorical column where numeric is needed → wrong_column_type', () => {
    expect(codes(openProfile(), {
      kind: 'test', test: 't', column: 'species', groupBy: 'species',
      groups: ['setosa', 'virginica'],
    })).toEqual(['wrong_column_type']);
  });

  it('two-group tests demand exactly two groups', () => {
    expect(codes(openProfile(), {
      kind: 'test', test: 'ks', column: 'sepal_len', groupBy: 'species',
      groups: ['setosa'],
    })).toEqual(['wrong_group_count']);
    // No explicit groups and 3 available → a count failure, plus the size
    // gate flagging the 1-row group so the revision knows which 2 to pick.
    expect(codes(openProfile(), {
      kind: 'test', test: 'mann_whitney', column: 'sepal_len', groupBy: 'species',
    })).toEqual(['wrong_group_count', 'group_too_small']);
  });

  it('kruskal_wallis takes all groups by default but enforces sizes', () => {
    const fails = validatePlan({
      kind: 'test', test: 'kruskal_wallis', column: 'sepal_len', groupBy: 'species',
    }, openProfile());
    // ghost_orchid has 1 row < MIN_GROUP_N
    expect(fails.map(f => f.code)).toEqual(['group_too_small']);
    expect(fails[0].available).toEqual(['setosa', 'virginica']);
  });

  it('kruskal_wallis over the visible groups passes in private mode', () => {
    // Private profile hides ghost_orchid, so "all groups" = the two big ones.
    expect(validatePlan({
      kind: 'test', test: 'kruskal_wallis', column: 'sepal_len', groupBy: 'species',
    }, privateProfile())).toEqual([]);
  });

  it('ks needs 3 rows per group', () => {
    const two = table({
      v: [1, 2, 3, 4, 5, 6, 7, 8],
      g: ['a', 'a', 'b', 'b', 'b', 'b', 'b', 'b'],
    });
    expect(validatePlan(
      { kind: 'test', test: 'ks', column: 'v', groupBy: 'g', groups: ['a', 'b'] },
      analysisProfileOf(two, policyFor('open')),
    ).map(f => f.code)).toEqual(['group_too_small']);
  });

  it('chi_square wants two categoricals and no groups field', () => {
    expect(validatePlan({
      kind: 'test', test: 'chi_square', column: 'species', groupBy: 'species',
    }, openProfile())).toEqual([]);
    // A truly continuous column (>20 uniques) is not groupable; note that a
    // low-unique NUMERIC column (a Likert item) legitimately is, per profile.ts.
    const cont = table({
      score: Array.from({ length: 25 }, (_, i) => i + 0.5),
      g: Array.from({ length: 25 }, (_, i) => (i % 2 ? 'a' : 'b')),
    });
    expect(validatePlan(
      { kind: 'test', test: 'chi_square', column: 'score', groupBy: 'g' },
      analysisProfileOf(cont, policyFor('open')),
    ).map(f => f.code)).toEqual(['wrong_column_type']);
    expect(codes(openProfile(), {
      kind: 'test', test: 'chi_square', column: 'species', groupBy: 'species',
      groups: ['setosa'],
    })).toEqual(['bad_plan_shape']);
  });

  it('unknown test name → bad_plan_shape listing the real tests', () => {
    const fails = validatePlan(
      { kind: 'test', test: 'anova', column: 'sepal_len', groupBy: 'species' },
      openProfile(),
    );
    expect(fails[0].code).toBe('bad_plan_shape');
    expect(fails[0].available).toContain('kruskal_wallis');
  });

  it('high-cardinality grouping is rejected with the cap named', () => {
    const many = table({
      v: Array.from({ length: 60 }, (_, i) => i),
      g: Array.from({ length: 60 }, (_, i) => `g${i % (MAX_GROUP_CARDINALITY + 1)}`),
    });
    const fails = validatePlan(
      { kind: 'test', test: 'kruskal_wallis', column: 'v', groupBy: 'g' },
      analysisProfileOf(many, policyFor('open')),
    );
    expect(fails.map(f => f.code)).toEqual(['high_cardinality_group']);
    expect(fails[0].message).toContain(String(MAX_GROUP_CARDINALITY));
  });
});

describe('validatePlan — the mode fence is oracle-proof', () => {
  it('a withheld value fails byte-for-byte like a nonexistent one', () => {
    const plan = (group: string) => ({
      kind: 'test', test: 't', column: 'sepal_len', groupBy: 'species',
      groups: ['setosa', group],
    });
    const probed = validatePlan(plan('ghost_orchid'), privateProfile());
    const invented = validatePlan(plan('ghost_orchid'), privateProfile());
    const nonexistent = validatePlan(plan('unicorn'), privateProfile());
    expect(probed).toEqual(invented);
    // Same code, fix, and available list; messages differ only by the probed
    // label the CALLER supplied (echoing their own input is not disclosure —
    // confirming it exists would be).
    expect(probed[0].code).toBe(nonexistent[0].code);
    expect(probed[0].fix).toBe(nonexistent[0].fix);
    expect(probed[0].available).toEqual(nonexistent[0].available);
    expect(probed[0].message.replace('ghost_orchid', 'unicorn')).toBe(nonexistent[0].message);
    // And the failure never says withheld/privacy/rare, nor leaks a count.
    const text = JSON.stringify(probed);
    expect(text).not.toMatch(/withheld|privacy|rare|n=|count/i);
    expect(probed[0].available).not.toContain('ghost_orchid');
  });

  it('the same value is legal in open mode', () => {
    expect(validatePlan({
      kind: 'test', test: 't', column: 'sepal_len', groupBy: 'species',
      groups: ['virginica', 'ghost_orchid'],
    }, openProfile()).map(f => f.code)).toEqual(['group_too_small']);
  });
});

describe('validatePlan — charts', () => {
  const open = openProfile;

  it('accepts a grouped ECDF and a histogram with sane bins', () => {
    expect(validatePlan({ kind: 'chart', mark: 'ecdf', column: 'sepal_len', groupBy: 'species' }, open())).toEqual([]);
    expect(validatePlan({ kind: 'chart', mark: 'histogram', column: 'sepal_len', bins: 20 }, open())).toEqual([]);
  });

  it('line needs a temporal x; the failure enumerates temporal columns', () => {
    const missing = validatePlan({ kind: 'chart', mark: 'line', column: 'sepal_len' }, open());
    expect(missing.map(f => f.code)).toEqual(['bad_plan_shape']);
    expect(missing[0].available).toEqual(['when']);
    const wrong = validatePlan({ kind: 'chart', mark: 'line', column: 'sepal_len', x: 'note' }, open());
    expect(wrong.map(f => f.code)).toEqual(['not_temporal']);
    expect(wrong[0].available).toEqual(['when']);
    expect(validatePlan({ kind: 'chart', mark: 'line', column: 'sepal_len', x: 'when', agg: 'mean' }, open())).toEqual([]);
  });

  it('bar plots a categorical, counts only, and owns orientation', () => {
    expect(validatePlan({ kind: 'chart', mark: 'bar', column: 'species', orientation: 'horizontal' }, open())).toEqual([]);
    const cont = analysisProfileOf(table({
      score: Array.from({ length: 25 }, (_, i) => i + 0.5),
      g: Array.from({ length: 25 }, (_, i) => (i % 2 ? 'a' : 'b')),
    }), policyFor('open'));
    expect(codes(cont, { kind: 'chart', mark: 'bar', column: 'score' })).toEqual(['wrong_column_type']);
    expect(codes(open(), { kind: 'chart', mark: 'bar', column: 'species', agg: 'mean' })).toEqual(['bad_plan_shape']);
    expect(codes(open(), { kind: 'chart', mark: 'ecdf', column: 'sepal_len', orientation: 'horizontal' }))
      .toEqual(['bad_orientation']);
  });

  it('mark-scoped fields are rejected elsewhere', () => {
    expect(codes(open(), { kind: 'chart', mark: 'box', column: 'sepal_len', bins: 10 })).toEqual(['bad_plan_shape']);
    expect(codes(open(), { kind: 'chart', mark: 'qq', column: 'sepal_len', x: 'when' })).toEqual(['bad_plan_shape']);
    expect(codes(open(), { kind: 'chart', mark: 'violin', column: 'sepal_len', agg: 'sum' })).toEqual(['bad_plan_shape']);
  });

  it('bad bins ranges are caught', () => {
    expect(codes(open(), { kind: 'chart', mark: 'histogram', column: 'sepal_len', bins: 3 })).toEqual(['bad_bins']);
    expect(codes(open(), { kind: 'chart', mark: 'histogram', column: 'sepal_len', bins: 500 })).toEqual(['bad_bins']);
    expect(codes(open(), { kind: 'chart', mark: 'histogram', column: 'sepal_len', bins: 10.5 })).toEqual(['bad_bins']);
  });

  it('unknown mark → bad_plan_shape listing the real marks', () => {
    const fails = validatePlan({ kind: 'chart', mark: 'pie', column: 'species' }, open());
    expect(fails[0].code).toBe('bad_plan_shape');
    expect(fails[0].available).toContain('bar');
  });
});

describe('validatePlan — shape guards and formatting', () => {
  it('non-objects and unknown kinds are bad_plan_shape', () => {
    expect(codes(openProfile(), null)).toEqual(['bad_plan_shape']);
    expect(codes(openProfile(), 'run a t test')).toEqual(['bad_plan_shape']);
    expect(codes(openProfile(), { kind: 'regression' })).toEqual(['bad_plan_shape']);
  });

  it('formatFailures renders code, fix and options on one line each', () => {
    const text = formatFailures(validatePlan(
      { kind: 'test', test: 't', column: 'nope', groupBy: 'species', groups: ['setosa', 'virginica'] },
      openProfile(),
    ));
    expect(text).toContain('Plan rejected');
    expect(text).toContain('[unknown_column]');
    expect(text).toContain('Fix:');
    expect(text).toContain('Available: sepal_len');
  });
});
