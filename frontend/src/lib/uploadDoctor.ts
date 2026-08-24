import { asNumber, type DataTable } from './table';

// Diagnoses WHY an upload has nothing to plot, and fixes what is fixable —
// entirely in the browser, from column-level shape statistics.
//
// Privacy: nothing here echoes a cell value. Every result is a count or a
// pattern label ("thousands separators", "currency symbol"), so the dialog
// built on top of this is identical in Private and Open data modes, and works
// with no assistant configured.
//
// What counts as fixable: a column where values are numbers WRITTEN AS
// FORMATTED TEXT — "$1,234.50", "45%", "3,14", "(120)", "1 234" — which
// asNumber (deliberately strict, see table.ts) rejects. Plain numeric strings
// ("123") already parse everywhere, so they never show up here.

export type ColumnDiagnosis = {
  col: string;
  kind: 'numeric' | 'fixable' | 'date-like' | 'text' | 'empty';
  nonNull: number;
  /** Values asNumber already accepts. */
  numericNow: number;
  /** Values that would parse after cleanNumericText. */
  numericAfterFix: number;
  /** Format-pattern labels seen in this column (counts, never values). */
  patterns: string[];
};

const CURRENCY = /[$€£¥₹]/g;
// NBSP and thin space turn up as group separators in European exports.
const SPACES = /[\s   ]/g;

const PATTERNS: { label: string; test: RegExp }[] = [
  { label: 'currency symbol', test: /^[$€£¥₹]\s*[-+]?[\d.,\s ]+$|^[-+]?[\d.,\s ]+\s*[$€£¥₹]$/ },
  { label: 'percent sign', test: /^[-+]?[\d.,]+\s*%$/ },
  { label: 'thousands separators (1,234)', test: /^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/ },
  { label: 'European format (1.234,56)', test: /^[-+]?\d{1,3}(\.\d{3})+(,\d+)?$/ },
  { label: 'comma as decimal (3,14)', test: /^[-+]?\d+,\d{1,2}$/ },
  { label: 'space-grouped digits (1 234)', test: /^[-+]?\d{1,3}([\s   ]\d{3})+([.,]\d+)?$/ },
  { label: 'parentheses negative (123)', test: /^\([\d.,\s ]+\)$/ },
];

const DATE_LIKE = /^\d{4}-\d{2}-\d{2}([T ]|$)|^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/;

/** The pattern label a string value matches, or null. Labels only — no values. */
export const numericTextPattern = (s: string): string | null => {
  const trimmed = s.trim();
  for (const p of PATTERNS) if (p.test.test(trimmed)) return p.label;
  return null;
};

/**
 * Parse a formatted-number string that asNumber rejects. Returns null for
 * anything ambiguous — a wrong guess here would silently change data, which
 * is worse than leaving the column as text.
 */
export const cleanNumericText = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.trim();
  if (!s) return null;

  let negative = false;
  const paren = s.match(/^\((.+)\)$/);
  if (paren) { negative = true; s = paren[1].trim(); }

  s = s.replace(CURRENCY, '').trim();
  if (s.endsWith('%')) s = s.slice(0, -1).trim();

  // Disambiguate separators BEFORE stripping spaces, most specific first.
  if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) {
    s = s.replace(/,/g, '');                                 // 1,234.56
  } else if (/^[-+]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.');              // 1.234,56
  } else if (/^[-+]?\d+,\d{1,2}$/.test(s)) {
    s = s.replace(',', '.');                                 // 3,14
  } else if (/^[-+]?\d{1,3}([\s   ]\d{3})+([.,]\d+)?$/.test(s)) {
    s = s.replace(SPACES, '').replace(',', '.');             // 1 234,5
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
};

/** Per-column shape statistics for the whole table. */
export const diagnoseTable = (table: DataTable): ColumnDiagnosis[] =>
  table.columns.map(col => {
    const vals = table.data[col] ?? [];
    let nonNull = 0, numericNow = 0, numericAfterFix = 0, dateLike = 0;
    const patternCounts = new Map<string, number>();
    for (const v of vals) {
      if (v == null || (typeof v === 'string' && v.trim() === '')) continue;
      nonNull++;
      if (asNumber(v) !== null) { numericNow++; numericAfterFix++; continue; }
      if (typeof v === 'string') {
        if (cleanNumericText(v) !== null) {
          numericAfterFix++;
          const p = numericTextPattern(v);
          if (p) patternCounts.set(p, (patternCounts.get(p) ?? 0) + 1);
        } else if (DATE_LIKE.test(v.trim())) {
          dateLike++;
        }
      }
    }
    const kind: ColumnDiagnosis['kind'] =
      nonNull === 0 ? 'empty'
      : numericNow > 0 ? 'numeric' // the app already treats it as numeric
      : numericAfterFix >= Math.max(1, Math.ceil(nonNull * 0.8)) ? 'fixable'
      : dateLike >= Math.ceil(nonNull * 0.8) ? 'date-like'
      : 'text';
    return {
      col, kind, nonNull, numericNow, numericAfterFix,
      patterns: Array.from(patternCounts.entries()).sort((a, b) => b[1] - a[1]).map(([label]) => label),
    };
  });

/**
 * Plain-language verdict for the error dialog. Counts and column NAMES only —
 * column names are metadata the sidebar already shows, never cell values.
 */
export const summarizeDiagnosis = (diags: ColumnDiagnosis[]): string => {
  const fixable = diags.filter(d => d.kind === 'fixable');
  const numeric = diags.filter(d => d.kind === 'numeric');
  const dates = diags.filter(d => d.kind === 'date-like');
  const parts: string[] = [];
  if (numeric.length) {
    parts.push(`${numeric.length} column${numeric.length === 1 ? ' is' : 's are'} already numeric.`);
  }
  if (fixable.length) {
    parts.push(
      `${fixable.length} column${fixable.length === 1 ? ' looks' : 's look'} numeric but ${fixable.length === 1 ? 'is' : 'are'} stored as formatted text ` +
      `(${fixable.map(d => d.col).join(', ')}) — fixable right here.`
    );
  } else if (numeric.length < 2) {
    parts.push('No column contains numeric values, even written as text — there is nothing to put on a scatter axis.');
    if (dates.length) {
      parts.push(`${dates.map(d => d.col).join(', ')} look${dates.length === 1 ? 's' : ''} like dates, which this app cannot use as an axis.`);
    }
  }
  return parts.join(' ');
};

/** A new table with the chosen columns coerced number-by-number. */
export const applyNumericFix = (table: DataTable, cols: string[]): DataTable => {
  const data = { ...table.data };
  for (const col of cols) {
    if (!table.columns.includes(col)) continue;
    data[col] = (table.data[col] ?? []).map(v => (v == null ? null : cleanNumericText(v)));
  }
  return { columns: table.columns, data, nRows: table.nRows };
};
