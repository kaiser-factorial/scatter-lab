import { scanTable, MAX_CATEGORIES } from './profile';
import type { DataTable } from './table';
import { isIdentifierColumn, valueIsTooRare } from './defaults';
import {
  MAX_BAR_CATEGORIES, MAX_BINS, MAX_GROUP_CARDINALITY, MIN_BINS,
  MIN_GROUP_N, MIN_GROUP_N_KS, MARK_KINDS, TEST_KINDS,
  type AnalysisColumn, type AnalysisPlan, type AnalysisProfile,
  type ChartPlan, type TestPlan, type ValidationFailure,
} from './analysisPlan';
import type { DataPolicy } from './dataPolicy';

// Deterministic gates for analysis plans. Pure functions only: same plan +
// same profile → same failures, which is what makes the replay harness able
// to test every rejection path without a model in the loop.

// ---------------------------------------------------------------------------
// Building the profile the validator reads
// ---------------------------------------------------------------------------

// Conservative temporal detection: unambiguous date STRINGS only. Bare numbers
// are never temporal here — a column of 1998..2024 is at least as likely an
// ID or a count, and a wrong "temporal" unlocks line charts that mislead.
const TEMPORAL_PATTERNS = [
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/, // ISO date / datetime
  /^\d{4}\/\d{1,2}\/\d{1,2}$/,                     // 2024/3/14
  /^\d{1,2}\/\d{1,2}\/\d{4}$/,                     // 3/14/2024 or 14/3/2024
];

export const isTemporalValue = (v: unknown): boolean =>
  typeof v === 'string' && TEMPORAL_PATTERNS.some(p => p.test(v.trim()));

const TEMPORAL_SHARE = 0.8;

export const isTemporalColumn = (vals: unknown[]): boolean => {
  let nonNull = 0, temporal = 0;
  for (const v of vals) {
    if (v == null) continue;
    nonNull++;
    if (isTemporalValue(v)) temporal++;
  }
  return nonNull > 0 && temporal / nonNull >= TEMPORAL_SHARE;
};

/**
 * One flat description per column, from the table and the session policy.
 * Group lists carry the per-value withholding flag; in private mode a withheld
 * or identifier value must then be treated exactly like one that does not
 * exist (see availableGroups / validateGroups below).
 */
export const analysisProfileOf = (table: DataTable, policy: DataPolicy): AnalysisProfile => ({
  policy,
  columns: scanTable(table).map((s): AnalysisColumn => {
    const identifier = isIdentifierColumn(s.col);
    const vals = table.data[s.col] ?? [];
    const col: AnalysisColumn = {
      name: s.col,
      isNumeric: s.isNumeric,
      isCategorical: s.kind === 'categorical',
      isTemporal: isTemporalColumn(vals),
      isIdentifier: identifier,
    };
    if (s.kind === 'categorical' && s.nUnique <= MAX_CATEGORIES) {
      const counts = new Map<string, number>();
      for (const v of vals) {
        if (v == null) continue;
        const key = String(v);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      col.groups = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([value, n]) => ({
          value, n,
          withheld: !policy.fullCategories && (identifier || valueIsTooRare(n)),
        }));
    }
    return col;
  }),
});

// ---------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------

const fail = (
  code: ValidationFailure['code'], message: string, fix: string, available?: string[],
): ValidationFailure => ({ code, message, fix, ...(available?.length ? { available } : {}) });

const namesWhere = (p: AnalysisProfile, pred: (c: AnalysisColumn) => boolean): string[] =>
  p.columns.filter(pred).map(c => c.name);

/**
 * The group values a plan may name: what the profile shows. In private mode a
 * withheld value is NOT in this list — and everything downstream words its
 * rejection from this list alone, so probing a withheld value gets the same
 * bytes as probing a value that was never in the data. The error channel must
 * not confirm what the profile conceals.
 */
const availableGroups = (col: AnalysisColumn): string[] =>
  (col.groups ?? []).filter(g => !g.withheld).map(g => g.value);

const findColumn = (p: AnalysisProfile, name: string): AnalysisColumn | undefined =>
  p.columns.find(c => c.name === name);

// One shared check: `name` must exist and satisfy `role`. Returns failures.
const checkColumn = (
  p: AnalysisProfile, name: unknown, field: string,
  role: 'numeric' | 'categorical' | 'temporal',
): ValidationFailure[] => {
  const legal = namesWhere(p, c =>
    role === 'numeric' ? c.isNumeric : role === 'temporal' ? c.isTemporal : c.isCategorical);
  if (typeof name !== 'string' || !name) {
    return [fail('bad_plan_shape', `\`${field}\` is required.`,
      `Set \`${field}\` to a ${role} column.`, legal)];
  }
  const col = findColumn(p, name);
  if (!col) {
    return [fail('unknown_column', `"${name}" is not a column of the active dataset.`,
      `Set \`${field}\` to an existing ${role} column.`, legal)];
  }
  const ok = role === 'numeric' ? col.isNumeric : role === 'temporal' ? col.isTemporal : col.isCategorical;
  if (!ok) {
    const code = role === 'temporal' ? 'not_temporal' : 'wrong_column_type';
    return [fail(code, `"${name}" is not usable as a ${role} column.`,
      `Set \`${field}\` to a ${role} column.`, legal)];
  }
  return [];
};

// Group-list checks shared by tests and grouped charts. `minN` = per-group
// minimum sample size, 0 to skip the size gate.
const validateGroups = (
  p: AnalysisProfile, groupCol: AnalysisColumn, requested: string[] | undefined, minN: number,
): ValidationFailure[] => {
  const out: ValidationFailure[] = [];
  const visible = availableGroups(groupCol);
  const byValue = new Map((groupCol.groups ?? []).map(g => [g.value, g]));
  const chosen = requested ?? visible;

  for (const value of requested ?? []) {
    const g = byValue.get(value);
    // A withheld value gets the SAME failure as a nonexistent one — never
    // reveal that it exists, has a count, or was withheld for privacy.
    if (!g || g.withheld) {
      out.push(fail('unknown_group_value',
        `"${value}" is not an available group of "${groupCol.name}".`,
        `Choose groups from the available values of "${groupCol.name}".`, visible));
    }
  }
  if (out.length) return out; // sizes of unknown groups are meaningless

  if (chosen.length > MAX_GROUP_CARDINALITY) {
    out.push(fail('high_cardinality_group',
      `"${groupCol.name}" would compare ${chosen.length} groups; the limit is ${MAX_GROUP_CARDINALITY}.`,
      `Name at most ${MAX_GROUP_CARDINALITY} groups explicitly via \`groups\`, or group by a lower-cardinality column.`,
      visible));
  }
  if (minN > 0) {
    const small = chosen.filter(v => (byValue.get(v)?.n ?? 0) < minN);
    if (small.length) {
      out.push(fail('group_too_small',
        `Group(s) ${small.map(v => `"${v}"`).join(', ')} of "${groupCol.name}" have fewer than ${minN} rows.`,
        `Choose groups with at least ${minN} rows each.`,
        visible.filter(v => (byValue.get(v)?.n ?? 0) >= minN)));
    }
  }
  return out;
};

const validateTest = (plan: TestPlan, p: AnalysisProfile): ValidationFailure[] => {
  const out: ValidationFailure[] = [];
  if (!TEST_KINDS.includes(plan.test)) {
    return [fail('bad_plan_shape', `"${String(plan.test)}" is not a known test.`,
      'Set `test` to one of the available tests.', [...TEST_KINDS])];
  }
  // chi_square relates two categoricals; every other test needs numeric-by-group.
  out.push(...checkColumn(p, plan.column, 'column', plan.test === 'chi_square' ? 'categorical' : 'numeric'));
  out.push(...checkColumn(p, plan.groupBy, 'groupBy', 'categorical'));
  if (out.length) return out;

  const groupCol = findColumn(p, plan.groupBy)!;
  const twoGroup = plan.test === 't' || plan.test === 'mann_whitney' || plan.test === 'ks';
  if (twoGroup) {
    const visible = availableGroups(groupCol);
    if (plan.groups && plan.groups.length !== 2) {
      out.push(fail('wrong_group_count',
        `${plan.test} compares exactly 2 groups; the plan names ${plan.groups.length}.`,
        'Set `groups` to exactly two values (or use kruskal_wallis for 3+ groups).', visible));
    } else if (!plan.groups && visible.length !== 2) {
      out.push(fail('wrong_group_count',
        `${plan.test} compares exactly 2 groups; "${plan.groupBy}" has ${visible.length} available.`,
        'Name the two groups to compare via `groups`.', visible));
    }
  } else if (plan.test === 'kruskal_wallis' && plan.groups && plan.groups.length < 2) {
    out.push(fail('wrong_group_count',
      `kruskal_wallis needs at least 2 groups; the plan names ${plan.groups.length}.`,
      'Name 2 or more groups, or omit `groups` to use all.', availableGroups(groupCol)));
  }
  if (plan.test === 'chi_square' && plan.groups) {
    out.push(fail('bad_plan_shape', 'chi_square uses every available level of both columns.',
      'Remove `groups` from the plan.'));
  }
  const minN = plan.test === 'ks' ? MIN_GROUP_N_KS : plan.test === 'chi_square' ? 0 : MIN_GROUP_N;
  out.push(...validateGroups(p, groupCol, plan.test === 'chi_square' ? undefined : plan.groups, minN));
  return out;
};

const validateChart = (plan: ChartPlan, p: AnalysisProfile): ValidationFailure[] => {
  const out: ValidationFailure[] = [];
  if (!MARK_KINDS.includes(plan.mark)) {
    return [fail('bad_plan_shape', `"${String(plan.mark)}" is not a known chart mark.`,
      'Set `mark` to one of the available marks.', [...MARK_KINDS])];
  }
  // Per-mark roles: bar plots a categorical; everything else plots a numeric.
  out.push(...checkColumn(p, plan.column, 'column', plan.mark === 'bar' ? 'categorical' : 'numeric'));
  if (plan.groupBy !== undefined) out.push(...checkColumn(p, plan.groupBy, 'groupBy', 'categorical'));

  if (plan.mark === 'line') {
    out.push(...checkColumn(p, plan.x, 'x', 'temporal'));
  } else if (plan.x !== undefined) {
    out.push(fail('bad_plan_shape', '`x` only applies to line charts.', 'Remove `x` from the plan.'));
  }
  if (plan.mark === 'histogram') {
    if (plan.bins !== undefined && (!Number.isInteger(plan.bins) || plan.bins < MIN_BINS || plan.bins > MAX_BINS)) {
      out.push(fail('bad_bins', `\`bins\` must be an integer between ${MIN_BINS} and ${MAX_BINS}.`,
        `Set \`bins\` within ${MIN_BINS}–${MAX_BINS}, or omit it for an automatic choice.`));
    }
  } else if (plan.bins !== undefined) {
    out.push(fail('bad_plan_shape', '`bins` only applies to histograms.', 'Remove `bins` from the plan.'));
  }
  if (plan.orientation !== undefined && plan.mark !== 'bar') {
    out.push(fail('bad_orientation', '`orientation` only applies to bar charts.',
      'Remove `orientation` from the plan.'));
  }
  if (plan.agg !== undefined && plan.mark !== 'bar' && plan.mark !== 'line') {
    out.push(fail('bad_plan_shape', '`agg` only applies to bar and line charts.',
      'Remove `agg` from the plan.'));
  }
  if (out.length) return out;

  if (plan.mark === 'bar') {
    const barCol = findColumn(p, plan.column)!;
    const visible = availableGroups(barCol);
    if (visible.length > MAX_BAR_CATEGORIES) {
      out.push(fail('high_cardinality_group',
        `"${plan.column}" has ${visible.length} available categories; bar charts cap at ${MAX_BAR_CATEGORIES}.`,
        'Choose a lower-cardinality column, or aggregate the long tail first.'));
    }
    // Bar's `column` is the categorical, so there is no numeric to average:
    // bars aggregate row counts per category. A mean/median/sum bar would need
    // a separate `value` field the contract deliberately does not have yet.
    if (plan.agg && plan.agg !== 'count') {
      out.push(fail('bad_plan_shape', 'Bar charts aggregate row counts per category.',
        'Remove `agg` (or set it to "count").'));
    }
  }
  if (plan.groupBy !== undefined) {
    out.push(...validateGroups(p, findColumn(p, plan.groupBy)!, undefined, 0));
  }
  return out;
};

/** All gates, in layers; an empty array means the plan may execute. */
export const validatePlan = (plan: unknown, profile: AnalysisProfile): ValidationFailure[] => {
  if (typeof plan !== 'object' || plan === null || !('kind' in plan)) {
    return [fail('bad_plan_shape', 'A plan is an object with a `kind` of "test" or "chart".',
      'Send { kind: "test", ... } or { kind: "chart", ... }.')];
  }
  const p = plan as AnalysisPlan;
  if (p.kind === 'test') return validateTest(p, profile);
  if (p.kind === 'chart') return validateChart(p, profile);
  return [fail('bad_plan_shape', `"${String((plan as { kind: unknown }).kind)}" is not a plan kind.`,
    'Set `kind` to "test" or "chart".', ['test', 'chart'])];
};
