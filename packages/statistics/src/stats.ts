/** Full-precision descriptive, association and hypothesis-test functions. */
import { asNumber, median } from './internal/table';
import * as tests from './internal/statTests';

export { correlation, compareGroups } from './internal/stats';
export type { Cell, CorrelationResult, GroupComparison, GroupStat } from './internal/stats';
export type { TestKind, TestResult } from './internal/statTests';

export interface NumericSummary {
  n: number;
  missing: number;
  mean: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
  variancePopulation: number | null;
  varianceSample: number | null;
  sdPopulation: number | null;
  sdSample: number | null;
}

/** Numeric strings follow the same finite-number coercion as the workbench.
 * Missing/non-numeric values are omitted. Sample quantities require n >= 2. */
export function describeNumeric(values: readonly unknown[]): NumericSummary {
  const numeric = values.map(asNumber).filter((x): x is number => x !== null);
  const n = numeric.length;
  if (!n) return { n, missing: values.length, mean: null, median: null, min: null, max: null, variancePopulation: null, varianceSample: null, sdPopulation: null, sdSample: null };
  const mean = numeric.reduce((sum, value) => sum + value, 0) / n;
  let sumSquares = 0, min = Infinity, max = -Infinity;
  for (const value of numeric) { sumSquares += (value - mean) ** 2; min = Math.min(min, value); max = Math.max(max, value); }
  const variancePopulation = sumSquares / n, varianceSample = n > 1 ? sumSquares / (n - 1) : null;
  return { n, missing: values.length - n, mean, median: median(numeric), min, max, variancePopulation, varianceSample,
    sdPopulation: Math.sqrt(variancePopulation), sdSample: varianceSample === null ? null : Math.sqrt(varianceSample) };
}

const finiteSample = (values: readonly number[], name: string, minimum = 1): number[] => {
  if (values.length < minimum || values.some(value => typeof value !== 'number' || !Number.isFinite(value)))
    throw new RangeError(`${name} must contain at least ${minimum} finite numeric observations.`);
  return [...values];
};

/** Two-sided unequal-variance t test, 95% mean-difference interval and pooled-SD Cohen d. */
export function welchT(a: readonly number[], b: readonly number[], labels: [string, string] = ['a', 'b']): tests.TestResult {
  const x = finiteSample(a, 'a', 2), y = finiteSample(b, 'b', 2);
  if (x.every(v => v === x[0]) && y.every(v => v === y[0])) throw new RangeError('Welch inference requires positive within-group variance.');
  return tests.welchT(x, y, labels);
}

/** Tie-corrected normal approximation; no continuity correction or exact small-sample enumeration.
 * Rank-biserial effect uses the existing workbench convention 1 - 2 U_a/(n_a n_b). */
export function mannWhitneyU(a: readonly number[], b: readonly number[], labels: [string, string] = ['a', 'b']): tests.TestResult {
  return tests.mannWhitneyU(finiteSample(a, 'a'), finiteSample(b, 'b'), labels);
}

/** Tie-corrected Kruskal-Wallis H with asymptotic chi-square inference. */
export function kruskalWallis(groups: readonly { group: string; values: readonly number[] }[]): tests.TestResult {
  if (groups.length < 2) throw new RangeError('Kruskal-Wallis requires at least two groups.');
  const checked = groups.map(g => ({ group: g.group, values: finiteSample(g.values, g.group) }));
  const all = checked.flatMap(g => g.values);
  if (all.every(value => value === all[0])) throw new RangeError('Kruskal-Wallis inference is undefined when all values are equal.');
  return tests.kruskalWallis(checked);
}

export interface KSTestResult extends tests.TestResult {
  pValueMethod: 'stephens-adjusted-asymptotic';
  /** The continuous-null approximation is not calibrated for tied/discrete data. */
  continuousNullAssumption: true;
  tiesPresent: boolean;
  /** Legacy workbench behavior sets p=1 when adjusted lambda is below 0.3. */
  lowLambdaClamped: boolean;
}

/** Two-sample ECDF maximum D. The p-value preserves the workbench's Stephens-adjusted
 * asymptotic approximation, including p=1 for adjusted lambda<0.3. It is not R's
 * exact KS p-value, nor its unadjusted asymptotic method. D is meaningful for tied
 * samples, but the continuous-null p-value is not a calibrated discrete test. */
export function ksTwoSample(a: readonly number[], b: readonly number[], labels: [string, string] = ['a', 'b']): KSTestResult {
  const x = finiteSample(a, 'a'), y = finiteSample(b, 'b');
  const result = tests.ksTwoSample(x, y, labels);
  const tiesPresent = new Set([...x, ...y]).size < x.length + y.length;
  const effectiveN = x.length * y.length / (x.length + y.length);
  const lowLambdaClamped = (Math.sqrt(effectiveN) + .12 + .11 / Math.sqrt(effectiveN)) * result.statistic < .3;
  const caveats = [...result.caveats];
  if (tiesPresent) caveats.push('Ties present: this continuous-null KS p-value is not calibrated for discrete/tied data.');
  return { ...result, caveats, pValueMethod: 'stephens-adjusted-asymptotic', continuousNullAssumption: true, tiesPresent, lowLambdaClamped };
}

/** Pearson chi-square, no Yates correction; positive row/column margins required. */
export function chiSquareTest(rows: string[], columns: string[], counts: number[][]): tests.TestResult {
  if (rows.length < 2 || columns.length < 2 || counts.length !== rows.length ||
      counts.some(row => row.length !== columns.length || row.some(n => !Number.isFinite(n) || n < 0 || !Number.isInteger(n))))
    throw new RangeError('A contingency table must have at least two rows and columns of non-negative integer counts.');
  if (counts.some(row => row.every(n => n === 0)) || columns.some((_, j) => counts.every(row => row[j] === 0)))
    throw new RangeError('Contingency table row and column margins must be positive.');
  return tests.chiSquareTest(rows, columns, counts);
}
