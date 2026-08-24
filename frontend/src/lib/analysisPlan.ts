import type { DataPolicy } from './dataPolicy';

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
/**
 * Rejected-plan revisions the assistant may attempt per user turn before it
 * must stop and report the failures to the user instead of retrying.
 */
export const MAX_PLAN_REVISIONS = 3;
