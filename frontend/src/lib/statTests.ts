// App-only dispatch and presentation around the standalone numerical package.
export * from '@scatterlab/stats/internal/statTests';
import { crossCounts, groupValues, type TestResult } from '@scatterlab/stats/internal/statTests';
import { chiSquareTest, welchT, mannWhitneyU, kruskalWallis } from '@scatterlab/stats/stats';
import type { DataTable } from './table';
import { CHI_SQUARE_MIN_EXPECTED, formatFailures, MIN_GROUP_N, TEST_MIN_USABLE, type AnalysisProfile, type TestPlan } from './analysisPlan';
import { validatePlan } from './validators';
import { MIN_AGGREGATE_COUNT } from './defaults';

const P_VALUE_METHOD = {
  t: 'Welch–Satterthwaite t approximation',
  mann_whitney: 'tie-corrected normal approximation, without continuity correction',
  kruskal_wallis: 'tie-corrected asymptotic chi-square',
  chi_square: 'asymptotic chi-square, without Yates correction',
} as const;

const checkedResult = (result: TestResult): TestResult => {
  const values = [result.statistic, result.p, result.effect.value, ...(result.ci95 ?? [])];
  if (result.df !== null) values.push(result.df);
  if (values.some(value => !Number.isFinite(value)) || result.p < 0 || result.p > 1) {
    throw new RangeError('Inference is unavailable for this input: the calculation did not produce finite, valid results.');
  }
  const method = P_VALUE_METHOD[result.test as keyof typeof P_VALUE_METHOD];
  return { ...result, caveats: [
    `P-value method: ${method}. Independent observations/groups only; paired and clustered inference is not supported.`,
    ...result.caveats,
  ] };
};

/**
 * Dispatch a VALIDATED TestPlan against a table. Group sets come from the
 * profile's visible values (the same ones the validator checked), so a
 * withheld value can never re-enter through execution.
 */
export const runTestPlan = (plan: TestPlan, table: DataTable, profile: AnalysisProfile): TestResult => {
  // Also enforce the gate here: a stale/direct caller must not bypass it.
  const failures = validatePlan(plan, profile);
  if (failures.length) throw new RangeError(formatFailures(failures));
  const visibleOf = (name: string): string[] =>
    (profile.columns.find(c => c.name === name)?.groups ?? []).filter(g => !g.withheld).map(g => g.value);
  if (plan.test === 'chi_square') {
    const levelsA = visibleOf(plan.column);
    const levelsB = visibleOf(plan.groupBy);
    const counts = crossCounts(table.data[plan.column], table.data[plan.groupBy], levelsA, levelsB);
    const rowTotals = counts.map(row => row.reduce((sum, n) => sum + n, 0));
    const columnTotals = levelsB.map((_, j) => counts.reduce((sum, row) => sum + row[j], 0));
    const margins = [...rowTotals, ...columnTotals];
    if (!profile.policy.fullCategories && margins.some(n => n < MIN_AGGREGATE_COUNT)) {
      throw new RangeError('Inference unavailable: insufficient usable observations for aggregate reporting after missing values are excluded.');
    }
    const total = rowTotals.reduce((sum, n) => sum + n, 0);
    if (margins.some(n => n <= 0) || !(total > 0)) {
      throw new RangeError('Chi-square inference requires positive row and column counts after missing values are excluded.');
    }
    if (rowTotals.some(row => columnTotals.some(column => row * column / total < CHI_SQUARE_MIN_EXPECTED))) {
      throw new RangeError(`Chi-square inference is unavailable for this sparse table: this release requires every expected count to be at least ${CHI_SQUARE_MIN_EXPECTED}. Descriptive category charts remain available.`);
    }
    return checkedResult(chiSquareTest(levelsA, levelsB, counts));
  }
  const chosen = plan.groups ?? visibleOf(plan.groupBy);
  if (chosen.length < 2 || new Set(chosen).size !== chosen.length) {
    throw new RangeError('Inference requires at least two distinct groups.');
  }
  const gv = groupValues(table.data[plan.column], table.data[plan.groupBy], chosen);
  if (!profile.policy.fullCategories && gv.some(g => g.values.length < MIN_AGGREGATE_COUNT)) {
    throw new RangeError('Inference unavailable: insufficient usable observations for aggregate reporting after missing values are excluded.');
  }
  const minimum = plan.test === 'mann_whitney' || plan.test === 'kruskal_wallis' ? TEST_MIN_USABLE[plan.test] : MIN_GROUP_N;
  if (gv.some(g => g.values.length < minimum)) {
    throw new RangeError(`Inference unavailable: this release requires at least ${minimum} usable numeric observations per group after missing values are excluded. Descriptive charts remain available.`);
  }
  if (plan.test === 'mann_whitney' && gv.every(g => g.values.every(value => value === gv[0].values[0]))) {
    throw new RangeError('Mann–Whitney inference is undefined when all observations are equal.');
  }
  const pair: [string, string] = [gv[0].group, gv[1].group];
  switch (plan.test) {
    case 't': return checkedResult(welchT(gv[0].values, gv[1].values, pair));
    case 'mann_whitney': return checkedResult(mannWhitneyU(gv[0].values, gv[1].values, pair));
    case 'kruskal_wallis': return checkedResult(kruskalWallis(gv));
    default: throw new RangeError('This statistical test is unavailable in this release.');
  }
};

const round = (v: number, places = 4) => Math.round(v * 10 ** places) / 10 ** places;

/** One-line plain rendering for the assistant's tool result. */
export const formatTestResult = (r: TestResult): string => {
  const df = r.df !== null ? `, df=${round(r.df, 2)}` : '';
  const ci = r.ci95 ? `, 95% CI [${round(r.ci95[0], 3)}, ${round(r.ci95[1], 3)}]` : '';
  const p = r.p < 0.001 ? r.p.toExponential(2) : String(round(r.p));
  return [
    `${r.test}: ${r.statLabel}=${round(r.statistic, 3)}${df}, p=${p}${ci}, ${r.effect.label}=${round(r.effect.value, 3)}.`,
    `Groups: ${r.groups.map(g => `${g.group} (n=${g.n})`).join(', ')}.`,
    ...r.caveats.map(c => `Caveat: ${c}`),
  ].join('\n');
};
