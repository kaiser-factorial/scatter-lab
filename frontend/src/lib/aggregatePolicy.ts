import { compareGroups, type GroupComparison } from './stats';
import { valueIsTooRare, isIdentifierColumn, MIN_AGGREGATE_COUNT } from './defaults';
import type { DataPolicy } from './dataPolicy';
import type { Cell } from './stats';

// The privacy floor for AGGREGATES the assistant receives, in one place.
//
// The column profile already applies a per-value rule (D8): a category is
// listed only when at least MIN_AGGREGATE_COUNT rows share it. The same rule
// has to hold for every other number the assistant sees, or a summary route
// becomes a row route — a group of one has a "mean" that IS that person's
// value, and a column's minimum IS the value of whoever is at the extreme.
// Everything here is pure so those cases can be pinned by tests.

/**
 * The extremes of a numeric column, subject to the floor: an extreme is
 * reported only when at least MIN_AGGREGATE_COUNT rows share that exact
 * value — a Likert ceiling of 7 shared by forty people describes a group; a
 * lone income of 987,000 describes a person. Quartiles stay: with n ≥ 5 a
 * quartile is a position in the middle of the distribution, not an
 * attributable extreme. `sorted` must be ascending.
 */
export const numericTails = (
  sorted: number[], policy: DataPolicy,
): { min?: number; max?: number; tailsWithheld: boolean } => {
  const n = sorted.length;
  if (!n) return { tailsWithheld: false };
  if (policy.fullCategories) return { min: sorted[0], max: sorted[n - 1], tailsWithheld: false };
  let lo = 0; while (lo < n && sorted[lo] === sorted[0]) lo++;
  let hi = 0; while (hi < n && sorted[n - 1 - hi] === sorted[n - 1]) hi++;
  const out: { min?: number; max?: number; tailsWithheld: boolean } = { tailsWithheld: false };
  if (!valueIsTooRare(lo)) out.min = sorted[0]; else out.tailsWithheld = true;
  if (!valueIsTooRare(hi)) out.max = sorted[n - 1]; else out.tailsWithheld = true;
  return out;
};

/** Minimum complete pairs for a correlation to be reported in private mode. */
export const correlationAllowed = (n: number, policy: DataPolicy): boolean =>
  policy.fullCategories || n >= MIN_AGGREGATE_COUNT;

export type GroupReport =
  | { ok: false; message: string }
  | { ok: true; message: string; comparison: GroupComparison; withheldGroups: number; withheldRows: number };

const f2 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? 'n/a' : x.toFixed(2));

/**
 * The compare_groups tool result. In private mode a group below the floor is
 * pooled into one unnamed line, never listed with its mean — and the caveats
 * that used to say "one group has a single observation" or "the smallest
 * group has n=1" go too, since either would confirm what was withheld.
 */
export const groupComparisonReport = (
  numericCol: string, groupCol: string, numeric: Cell[], groups: Cell[], policy: DataPolicy,
): GroupReport => {
  const res = compareGroups(numeric, groups);
  if (!res.groups.length) return { ok: false, message: 'No complete observations to compare.' };

  // A grouping with (nearly) one row per group is an identifier, not a
  // grouping: eta-squared is 1.000 by construction and means nothing.
  if (res.nGroups >= res.overall.n) {
    return { ok: false, message: `"${groupCol}" has ${res.nGroups} distinct values across ${res.overall.n} observations — one per row. That is an identifier rather than a grouping, and eta-squared would be exactly 1.000 by construction. Pick a column with repeated values (a condition, demographic, or cluster).` };
  }
  if (res.nGroups > res.overall.n / 2) {
    return { ok: false, message: `"${groupCol}" has ${res.nGroups} distinct values across only ${res.overall.n} observations. Group means are not estimable at that granularity and eta-squared would be inflated to near 1 by construction. Pick a coarser grouping.` };
  }
  const open = policy.fullCategories;
  // An explicitly-named identifier column is withheld in private mode even
  // when values repeat (long-format participant IDs), as in the profile.
  if (!open && isIdentifierColumn(groupCol)) {
    return { ok: false, message: `"${groupCol}" is an identifier column, so its groups are individuals rather than categories. Pick a column with repeated categories (a condition, demographic, or cluster).` };
  }
  const shown = res.groups.filter(g => open || !valueIsTooRare(g.n));
  const withheld = res.groups.filter(g => !open && valueIsTooRare(g.n));
  const withheldRows = withheld.reduce((s, g) => s + g.n, 0);
  if (!shown.length) {
    return { ok: false, message: `"${groupCol}" has no value covering enough rows to describe a group, so a breakdown would list individuals. Pick a column with repeated categories.` };
  }

  const lines = shown.map(g => `${g.group}: mean=${f2(g.mean)}, sd=${f2(g.sd)}, n=${g.n}`);
  if (withheld.length) {
    lines.push(`(${withheld.length} group${withheld.length === 1 ? '' : 's'} below the privacy floor of ${MIN_AGGREGATE_COUNT} rows — ${withheldRows} row${withheldRows === 1 ? '' : 's'} in total — not listed; ${withheld.length === 1 ? 'it is' : 'they are'} still part of the overall figures and effect sizes)`);
  }
  const caveats: string[] = [];
  if (open && res.singletonGroups) {
    caveats.push(`${res.singletonGroups} group${res.singletonGroups === 1 ? ' has' : 's have'} a single observation, so no standard deviation exists for ${res.singletonGroups === 1 ? 'it' : 'them'}`);
  }
  const minShownN = Math.min(...shown.map(g => g.n));
  if ((open ? res.minGroupN : minShownN) < 30) {
    caveats.push(`the smallest listed group has n=${open ? res.minGroupN : minShownN}, so its mean is unstable`);
  }
  if (res.etaSquared != null && res.omegaSquared != null && res.etaSquared - res.omegaSquared > 0.05) {
    caveats.push('eta-squared is inflated here by the number of groups — omega-squared is the corrected figure');
  }
  const message = `${numericCol} by ${groupCol} (overall mean=${f2(res.overall.mean)}, sd=${f2(res.overall.sd)} [sample, n-1], n=${res.overall.n}, ${res.nGroups} groups):\n${lines.join('\n')}\neta-squared=${res.etaSquared?.toFixed(3) ?? 'n/a'}, omega-squared=${res.omegaSquared?.toFixed(3) ?? 'n/a'} (share of variance explained by group; descriptive effect sizes, not significance tests).${caveats.length ? ` Note: ${caveats.join('; ')}.` : ''}`;
  return { ok: true, message, comparison: res, withheldGroups: withheld.length, withheldRows };
};
