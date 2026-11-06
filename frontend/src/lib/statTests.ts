// App-only dispatch and presentation around the standalone numerical package.
export * from '@scatterlab/stats/internal/statTests';
import { chiSquareTest, crossCounts, groupValues, welchT, mannWhitneyU, ksTwoSample, kruskalWallis, type TestResult } from '@scatterlab/stats/internal/statTests';
import type { DataTable } from './table';
import type { AnalysisProfile, TestPlan } from './analysisPlan';

/**
 * Dispatch a VALIDATED TestPlan against a table. Group sets come from the
 * profile's visible values (the same ones the validator checked), so a
 * withheld value can never re-enter through execution.
 */
export const runTestPlan = (plan: TestPlan, table: DataTable, profile: AnalysisProfile): TestResult => {
  const visibleOf = (name: string): string[] =>
    (profile.columns.find(c => c.name === name)?.groups ?? []).filter(g => !g.withheld).map(g => g.value);
  if (plan.test === 'chi_square') {
    const levelsA = visibleOf(plan.column);
    const levelsB = visibleOf(plan.groupBy);
    return chiSquareTest(levelsA, levelsB, crossCounts(table.data[plan.column], table.data[plan.groupBy], levelsA, levelsB));
  }
  const chosen = plan.groups ?? visibleOf(plan.groupBy);
  const gv = groupValues(table.data[plan.column], table.data[plan.groupBy], chosen);
  const pair: [string, string] = [gv[0].group, gv[1].group];
  switch (plan.test) {
    case 't': return welchT(gv[0].values, gv[1].values, pair);
    case 'mann_whitney': return mannWhitneyU(gv[0].values, gv[1].values, pair);
    case 'ks': return ksTwoSample(gv[0].values, gv[1].values, pair);
    case 'kruskal_wallis': return kruskalWallis(gv);
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
