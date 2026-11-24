import type { DataPolicy } from './dataPolicy';
import { MIN_AGGREGATE_COUNT } from './defaults';

// The analysis-plan contract: every statistical test and chart request —
// whether it comes from the assistant or from the Analyze panel — is ONE typed
// plan object, checked by a deterministic validator (validators.ts) before
// anything computes. This file is the frozen interface the validator, the
// executors, the Analyze panel, and the replay harness all build against.
//
// The shape is adapted from a harness contributed by the project owner: a
// constrained plan schema whose validator raises MACHINE-READABLE observations
// (code + message + the legal options), so a model that proposed a bad plan
// can revise it in a bounded loop instead of guessing at prose errors.

export const TEST_KINDS = ['t', 'mann_whitney', 'kruskal_wallis', 'ks', 'chi_square'] as const;
export type TestKind = (typeof TEST_KINDS)[number];

// Temporary application release gate. Keep the known kinds for old results and
// numerical qualification, but do not offer or execute legacy KS inference.
export const ENABLED_TEST_KINDS = TEST_KINDS.filter(test => test !== 'ks');
export const KS_DISABLED_REASON = 'KS inference is temporarily unavailable pending validation of its p-value calibration. Descriptive ECDF charts remain available.';

export const MARK_KINDS = ['ecdf', 'histogram', 'box', 'violin', 'qq', 'bar', 'line'] as const;
export type MarkKind = (typeof MARK_KINDS)[number];

export type TestPlan = {
  kind: 'test';
  test: TestKind;
  /** Numeric outcome column — for chi_square, the SECOND categorical column. */
  column: string;
  /** Categorical column defining the groups. */
  groupBy: string;
  /**
   * Which groups to compare. Exactly 2 for t / mann_whitney / ks; 2 or more
   * for kruskal_wallis; omitted = all (visible) groups. chi_square ignores it.
   */
  groups?: string[];
};

export type ChartPlan = {
  kind: 'chart';
  mark: MarkKind;
  /** Numeric column — for bar, the categorical column; for line, the y value. */
  column: string;
  groupBy?: string;
  /** bar only. Default vertical. */
  orientation?: 'vertical' | 'horizontal';
  /** line only: the temporal x-axis column. */
  x?: string;
  /** bar & line: how to aggregate `column` per category / period. */
  agg?: 'mean' | 'median' | 'sum' | 'count';
  /** histogram only. */
  bins?: number;
};

export type AnalysisPlan = TestPlan | ChartPlan;

// ---------------------------------------------------------------------------
// Validation failures
// ---------------------------------------------------------------------------

export type ValidationFailureCode =
  | 'bad_plan_shape'
  | 'test_unavailable'
  | 'unknown_column'
  | 'wrong_column_type'
  | 'unknown_group_value'
  | 'wrong_group_count'
  | 'group_too_small'
  | 'high_cardinality_group'
  | 'insufficient_variance'
  | 'not_temporal'
  | 'bad_bins'
  | 'bad_orientation'
  | 'mode_forbidden';

export type ValidationFailure = {
  code: ValidationFailureCode;
  /** What failed, in plain terms. */
  message: string;
  /** Imperative: exactly what to change. */
  fix: string;
  /** The legal options, when they are enumerable. */
  available?: string[];
};

/**
 * How a batch of failures reaches the model as a tool result. One line per
 * failure, machine-parseable prefix first, so the revise loop can key on the
 * code while a human reading the trace still gets a sentence.
 */
export const formatFailures = (failures: ValidationFailure[]): string =>
  ['Plan rejected — revise it and call again:']
    .concat(
      failures.map(
        f =>
          `[${f.code}] ${f.message} Fix: ${f.fix}${
            f.available?.length ? ` Available: ${f.available.join(', ')}.` : ''
          }`,
      ),
    )
    .join('\n');

// ---------------------------------------------------------------------------
// The profile the validator reads
// ---------------------------------------------------------------------------

// Deliberately NOT the raw table: the validator sees one flat description per
// column, built once by analysisProfileOf (validators.ts) from the table and
// the session policy. Group entries carry a `withheld` flag so the validator
// can refuse a withheld value — but its refusal text must be byte-for-byte the
// text for a value that does not exist, so the error channel cannot be used as
// an oracle to enumerate what the profile withholds (D8 applies to errors too).

export type AnalysisColumn = {
  name: string;
  isNumeric: boolean;
  isCategorical: boolean;
  isTemporal: boolean;
  /** True when the name matches the identifier boundary (defaults.ts). */
  isIdentifier: boolean;
  /** Distinct values with counts — categorical columns only, capped. */
  groups?: { value: string; n: number; withheld: boolean }[];
};

export type AnalysisProfile = {
  columns: AnalysisColumn[];
  policy: DataPolicy;
};

// ---------------------------------------------------------------------------
// House policy constants
// ---------------------------------------------------------------------------

/** A grouped test/chart with more levels than this is unreadable — split it. */
export const MAX_GROUP_CARDINALITY = 12;
/** Bar charts cap out here; suggest horizontal orientation above ~8. */
export const MAX_BAR_CATEGORIES = 30;
export const MIN_BINS = 5;
export const MAX_BINS = 100;
/** Per-group minimum for rank/ECDF tests to be computable at all. */
export const MIN_GROUP_N = 2;
export const MIN_GROUP_N_KS = 3;
// Shared by runtime eligibility checks and assistant/help guidance. These are
// conservative release policies, not general calibration guarantees.
export const TEST_MIN_USABLE = { t: MIN_GROUP_N, mann_whitney: 8, kruskal_wallis: 5 } as const;
export const CHI_SQUARE_MIN_EXPECTED = 5;
export const TEST_RELEASE_REQUIREMENTS = [
  `Welch's t: exactly two independent groups, at least ${TEST_MIN_USABLE.t} usable numeric observations per group, and positive within-group variance in at least one group; uses the Welch–Satterthwaite t approximation and reports a 95% mean-difference interval.`,
  `Mann–Whitney U: exactly two independent groups, at least ${TEST_MIN_USABLE.mann_whitney} usable numeric observations per group, and not all observations equal; uses a tie-corrected normal approximation without continuity correction.`,
  `Kruskal–Wallis: at least two independent groups, at least ${TEST_MIN_USABLE.kruskal_wallis} usable numeric observations per group, and not all observations equal; uses a tie-corrected asymptotic chi-square calculation.`,
  `Pearson chi-square: two categorical variables with at least two observed levels each, positive row and column margins after excluding incomplete observations, and every expected cell count at least ${CHI_SQUARE_MIN_EXPECTED}; uses asymptotic chi-square without Yates correction. Sparse tables are rejected, not merely flagged.`,
  `All counts use the actual analysis sample after missing/unusable values are excluded. Private mode additionally requires at least ${MIN_AGGREGATE_COUNT} usable observations per reported group or contingency margin. Nonfinite or degenerate results are rejected.`,
] as const;
export const TEST_RELEASE_SUMMARY = `The assistant offers four tests: Welch's t, Mann–Whitney U, Kruskal–Wallis and Pearson chi-square. ${KS_DISABLED_REASON} Paired and clustered inference is unsupported. Confirm independent observations before using run_test. Do not substitute another hypothesis when a test is unavailable.`;
export const TEST_RELEASE_GUIDANCE = `${TEST_RELEASE_SUMMARY} ${TEST_RELEASE_REQUIREMENTS.join(' ')} These are conservative release eligibility limits, not proof that assumptions hold or that inference is calibrated for every accepted dataset. Report the returned p-value method, effect size and interval where available; do not describe these approximations as exact tests.`;
/**
 * Rejected-plan revisions the assistant may attempt per user turn before it
 * must stop and report the failures to the user instead of retrying.
 */
export const MAX_PLAN_REVISIONS = 3;
