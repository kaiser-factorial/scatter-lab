// Replacing declared missing-value codes with blanks, and reporting what that did.
//
// The detector in `sentinels.ts` only ever WARNS: which code means what is the
// researcher's knowledge, not ours. This module is the other half — the user
// names the codes and the columns, and we carry out exactly that instruction and
// then show its effect.
//
// The reporting is not decoration. The MATLAB script this was modelled on
// verified a recode by correlating the original score against the rebuilt one on
// the rows the recode did not touch, expecting ~1.00 — and got 0.9365, which
// revealed the item set was wrong rather than the recode. A change to data
// should have to show its work.

import { DataTable, asNumber } from './table';
import {
  REASON_TEXT,
  scanTableForCodes,
  type CooccurrenceEvidence,
  type SentinelConfidence,
  type SentinelFinding,
  type SentinelReason,
} from './sentinels';

export type RecodePlan = {
  /** Column name -> the exact values to blank in it. */
  byColumn: Record<string, number[]>;
};

export type ColumnRecodeEffect = {
  column: string;
  /** How many cells were blanked. */
  replaced: number;
  /** Rows in the column that had a usable number before the recode. */
  nBefore: number;
  /** ...and after. */
  nAfter: number;
  meanBefore: number | null;
  meanAfter: number | null;
  sdBefore: number | null;
  sdAfter: number | null;
  /**
   * True when every value the recode did NOT target is byte-identical
   * afterwards. False here means a bug in this module, not a finding about the
   * data — it is asserted, not hoped for.
   */
  untouchedRowsIdentical: boolean;
};

export type RecodeResult = {
  table: DataTable;
  effects: ColumnRecodeEffect[];
  /** Total cells blanked across all columns. */
  totalReplaced: number;
};

const meanSd = (vals: number[]): { mean: number | null; sd: number | null } => {
  if (!vals.length) return { mean: null, sd: null };
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (vals.length < 2) return { mean, sd: null };
  // Sample sd, matching the convention `stats.ts` reports everywhere else.
  const ss = vals.reduce((a, b) => a + (b - mean) ** 2, 0);
  return { mean, sd: Math.sqrt(ss / (vals.length - 1)) };
};

/**
 * Blank the named values in the named columns.
 *
 * Returns a NEW table — the input is never mutated, which the rest of the app
 * relies on (tables are replaced wholesale and cached by identity in
 * `profile.ts`). Columns absent from the plan are passed through by reference.
 */
export const applyRecode = (table: DataTable, plan: RecodePlan): RecodeResult => {
  const effects: ColumnRecodeEffect[] = [];
  const data: Record<string, unknown[]> = { ...table.data };
  let totalReplaced = 0;

  for (const [column, rawCodes] of Object.entries(plan.byColumn)) {
    const codes = new Set(rawCodes);
    const original = table.data[column];
    if (!codes.size || !Array.isArray(original)) continue;

    const next: unknown[] = new Array(original.length);
    let replaced = 0;
    let untouchedRowsIdentical = true;

    for (let i = 0; i < original.length; i++) {
      const n = asNumber(original[i]);
      // Match on the NUMERIC value, so a code that arrived as the string "9"
      // from a text-formatted spreadsheet is caught too (finding C6's lesson).
      if (n !== null && codes.has(n)) {
        next[i] = null;
        replaced++;
      } else {
        next[i] = original[i];
        // Object.is so NaN compares equal to itself and -0 does not to 0.
        if (!Object.is(next[i], original[i])) untouchedRowsIdentical = false;
      }
    }

    const numsOf = (col: unknown[]) => {
      const out: number[] = [];
      for (const v of col) { const n = asNumber(v); if (n !== null) out.push(n); }
      return out;
    };
    const before = numsOf(original);
    const after = numsOf(next);
    const b = meanSd(before), a = meanSd(after);

    data[column] = next;
    totalReplaced += replaced;
    effects.push({
      column, replaced,
      nBefore: before.length, nAfter: after.length,
      meanBefore: b.mean, meanAfter: a.mean,
      sdBefore: b.sd, sdAfter: a.sd,
      untouchedRowsIdentical,
    });
  }

  return {
    table: { columns: [...table.columns], data, nRows: table.nRows },
    effects: effects.sort((x, y) => y.replaced - x.replaced || x.column.localeCompare(y.column)),
    totalReplaced,
  };
};

const fmt = (v: number | null, dp = 2) =>
  v === null ? '—' : (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(dp));

/**
 * Plain-language account of what a recode did, one line per column, for the
 * surface that shows it. Deliberately reports the SHIFT rather than just the
 * count: "40 cells blanked" is not enough to notice that a variable's mean moved
 * by two points.
 */
export const describeRecode = (result: RecodeResult): string[] => {
  const lines: string[] = [];
  for (const e of result.effects) {
    if (!e.replaced) { lines.push(`${e.column}: nothing matched — left unchanged.`); continue; }
    const dMean = e.meanBefore !== null && e.meanAfter !== null
      ? ` mean ${fmt(e.meanBefore)} → ${fmt(e.meanAfter)}` : '';
    const dSd = e.sdBefore !== null && e.sdAfter !== null
      ? `, sd ${fmt(e.sdBefore)} → ${fmt(e.sdAfter)}` : '';
    lines.push(
      `${e.column}: ${e.replaced} cell${e.replaced === 1 ? '' : 's'} blanked, ` +
      `n ${e.nBefore} → ${e.nAfter}.${dMean}${dSd}`,
    );
  }
  const broken = result.effects.filter(e => !e.untouchedRowsIdentical).map(e => e.column);
  if (broken.length) {
    lines.push(`INTERNAL ERROR: values outside the recode changed in ${broken.join(', ')}. Do not trust this result.`);
  }
  return lines;
};

export type CodeEntry = {
  value: number;
  /** How many rows carry it. */
  count: number;
  /**
   * How sure the detector is — or null when it never flagged this value and the
   * entry exists only because the user declared the code.
   */
  confidence: SentinelConfidence | null;
  reasons: SentinelReason[];
  /** What the other columns holding this value say about it, if any do. */
  cooccurrence: CooccurrenceEvidence | null;
  /** Whether this box starts ticked. See `suggest` below for the reasoning. */
  suggested: boolean;
};

const tierOrder = { certain: 0, likely: 1, possible: 2, declared: 3 };
export const codeTierRank = (entry: CodeEntry): number => tierOrder[entry.confidence ?? 'declared'];

export type ColumnCodes = {
  column: string;
  /** Codes present in this column, ascending by value. */
  entries: CodeEntry[];
};

/**
 * Which boxes start ticked.
 *
 * The default is the whole safety argument of this dialog. Ticking everything
 * makes the destructive choice the lazy one: declaring 9 finds it in a Likert
 * item AND in a child's age, and a user who clicks straight through blanks a
 * nine-year-old. Ticking nothing is safe but makes the common case — a Don't
 * Know code across a battery of items — a click per column.
 *
 * So the default follows the evidence. Anything the detector is confident about
 * starts ticked; a bare possibility does not. A declared code the detector never
 * flagged starts UNTICKED unless the co-occurrence test found its rows lining up
 * with the same code elsewhere, which is the one piece of evidence available for
 * a value sitting inside its column's range.
 */
const suggest = (confidence: SentinelConfidence | null, co: CooccurrenceEvidence | null): boolean =>
  confidence === 'certain' || confidence === 'likely' ? true
  : confidence === 'possible' ? false
  : co?.supports === true;

/**
 * Which columns contain which codes — the detector's own findings, plus any the
 * user declares.
 *
 * Declared codes are searched for LITERALLY, with no gap or plausibility test:
 * the user saying "9 means Don't Know in my survey" is knowledge the detector
 * does not have and must not second-guess. That is also why the result is
 * per-column rather than global — declaring 9 will find it in a Likert item and
 * in a child's age alike, and only the user can say which is which.
 */
export const scanForCodes = (table: DataTable, declared: number[] = []): ColumnCodes[] => {
  const decl = new Set(declared.filter(v => Number.isFinite(v)));
  // One pass per column, then a cross-column pass over the values that turned
  // up in more than one. The per-column work used to map the column through
  // asNumber into a fresh array, run the multi-pass detector over it, then count
  // in yet another pass.
  const { byColumn, cooccurrence } = scanTableForCodes(
    table.columns, table.data, table.nRows, decl.size ? decl : undefined,
  );
  const out: ColumnCodes[] = [];

  for (const column of table.columns) {
    const scan = byColumn.get(column);
    if (!scan || !scan.numericCount) continue;   // nothing numeric to look at
    const co = cooccurrence.get(column);

    const entries = new Map<number, CodeEntry>();
    const add = (value: number, count: number, f?: SentinelFinding) => {
      const evidence = co?.get(value) ?? null;
      const confidence = f?.confidence ?? null;
      entries.set(value, {
        value, count, confidence,
        reasons: f?.reasons ?? [],
        cooccurrence: evidence,
        suggested: suggest(confidence, evidence),
      });
    };

    for (const f of scan.findings) add(f.value, f.count, f);
    for (const d of decl) {
      if (entries.has(d)) continue;
      const c = scan.candidateCounts.get(d) ?? scan.declaredOnlyCounts.get(d) ?? 0;
      if (c > 0) add(d, c);
    }
    if (!entries.size) continue;

    out.push({
      column,
      entries: [...entries.values()].sort((a, b) => a.value - b.value),
    });
  }

  // Strongest evidence first, and within a tier the table's own column order.
  // Declaring 9 in a survey turns up an incidental 9 in the id column, and file
  // order put that above the battery of items the user is actually here for.
  const rank = (h: ColumnCodes) => Math.min(...h.entries.map(codeTierRank));
  return out.map((h, i) => ({ h, i })).sort((a, b) => rank(a.h) - rank(b.h) || a.i - b.i).map(x => x.h);
};

/** Lift is a ratio against chance, so precision past a couple of figures is noise. */
const fmtLift = (lift: number) =>
  !Number.isFinite(lift) || lift > 99 ? '>99' : lift >= 10 ? lift.toFixed(0) : lift.toFixed(1);

/** The one-word tier shown beside a code. */
export const codeTierLabel = (e: CodeEntry): string => e.confidence ?? 'declared';

/**
 * Why this code is listed, in one line, for the surface that shows it.
 *
 * Written for a reader deciding whether to blank a column, so it reports the
 * EVIDENCE rather than the verdict. The co-occurrence line is quantified because
 * that is the only claim here a researcher can check against their own survey:
 * "the same rows, six other columns, twelve times chance" is either recognisably
 * their Don't Know block or it is not.
 */
export const describeCodeEntry = (e: CodeEntry): string => {
  const parts: string[] = [];
  for (const r of e.reasons) if (r !== 'co-occurs') parts.push(REASON_TEXT[r]);

  const co = e.cooccurrence;
  const others = (n: number) => `${n} other column${n === 1 ? '' : 's'}`;
  if (co?.supports) {
    // Deliberately does NOT say "in N other columns": `peers` counts every column
    // holding the value, which is not the same as the columns whose ROWS line up
    // with this one — an id column containing a single 9 is a peer and shares
    // nothing. The lift is the claim being made, so the lift is what is quoted.
    parts.push(`same rows as ${e.value} in other columns (${fmtLift(co.lift)}× chance)`);
  } else if (e.confidence === null) {
    // A declared code the detector never flagged. The user asked us to look for
    // it, so it is listed either way — but this is the column where a real value
    // gets blanked by accident, and the line has to say so.
    parts.push(co && co.peers > 0
      ? `declared; also in ${others(co.peers)}, but on unrelated rows`
      : 'declared; the detector did not flag this column');
  }
  return parts.join('; ');
};

/**
 * Parse a user-typed list of codes: "9, 99, -99".
 *
 * Empty entries are dropped BEFORE Number() sees them, because `Number('')` is 0
 * — so the naive version turns an empty box into a declaration that 0 is a
 * missing-value code, and offers to blank every zero in the file. That shipped
 * for exactly one browser run before the test caught it.
 */
export const parseDeclaredCodes = (text: string): number[] => {
  const out: number[] = [];
  for (const piece of text.split(/[,\s]+/)) {
    const t = piece.trim();
    if (t === '') continue;
    const n = Number(t);
    if (Number.isFinite(n)) out.push(n);
  }
  return [...new Set(out)];
};
