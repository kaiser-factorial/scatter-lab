// Columnar table shared across the app: one array per column.
// Cells are number | string | null — null covers empty, NaN, and ±Infinity,
// mirroring how the old pandas backend serialized missing values.
export type DataTable = { columns: string[]; data: Record<string, any[]>; nRows: number };

export const sanitizeCell = (v: any): number | string | null => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  // hyparquet returns BigInt for int64 columns. Handling it here rather than in
  // parseParquet lets that function pass rows straight to rowsToTable instead of
  // building a second full copy first (finding F20) — and closes the hole where
  // the old BigInt branch bypassed the finite check above entirely.
  if (typeof v === 'bigint') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (v instanceof Date) return v.toISOString();
  const s = String(v).trim();
  return s === '' ? null : s;
};

// Rows-of-objects (as parsers emit) → columnar table
export const rowsToTable = (rows: Record<string, any>[], columns: string[]): DataTable => {
  const data: Record<string, any[]> = {};
  for (const c of columns) data[c] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    for (const c of columns) data[c][i] = sanitizeCell(rows[i][c]);
  }
  return { columns, data, nRows: rows.length };
};

/**
 * The app's single answer to "is this cell a number, and which one".
 *
 * Excel columns formatted as Text arrive as strings, and so do CSV values
 * PapaParse declined to convert. `pca.ts` and `engine.ts` already coerced them;
 * `numericColumns`, `numericPairs` and the clustering imputer did not, so the
 * same column was a usable measurement in one half of the app and missing data
 * in the other (finding C6). Worst case, clustering median-imputed *every* row
 * of a text-formatted column and silently clustered on the median.
 *
 * A finite number written as text is a number. Anything else — blank, NaN,
 * ±Infinity, a word — is null, meaning "not observed as a number".
 */
export const asNumber = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim();
    // Number('') is 0 and Number(' ') is 0, so the emptiness check must come first.
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/** True when the column holds at least one value usable as a number. */
export const isNumericColumn = (vals: unknown[]): boolean => vals.some(v => asNumber(v) !== null);

export const numericValues = (vals: any[]): number[] =>
  vals.filter((v): v is number => typeof v === 'number');

export const median = (vals: number[]): number => {
  if (vals.length === 0) return 0;
  const s = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
