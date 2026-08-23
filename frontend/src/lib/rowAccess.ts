import { asNumber, type DataTable } from './table';
import { sampleIndices } from './random';
import { MAX_SAMPLE_ROWS, MAX_SAMPLE_COLUMNS, MAX_CELL_CHARS } from './dataPolicy';

// The open-mode row-reading tools, as pure functions over a table.
//
// Deliberately policy-free: whether these may run at all is decided by the
// bridge in page.tsx (session policy) and by the tool registry in assistant.ts
// (toolsFor). What lives here is only HOW a read works, so it can be tested
// without a browser. The caps are token budgets — one tool result lands
// verbatim in the model's context — not privacy rules.

export type SampleRowsOpts = {
  n?: number;
  columns?: string[];
  sort_by?: string;
  direction?: 'asc' | 'desc';
  seed?: number;
};

export type RowsWhereOpts = {
  column: string;
  op: 'eq' | 'lt' | 'gt' | 'contains';
  value: string | number;
  columns?: string[];
  limit?: number;
};

/** A long free-text cell is truncated, never dropped. */
const truncateCell = (v: unknown): string => {
  const s = String(v);
  return s.length > MAX_CELL_CHARS ? s.slice(0, MAX_CELL_CHARS - 1) + '…' : s;
};

/** Validate a requested column subset; default to all columns, capped. */
const prepareColumns = (t: DataTable, columns?: string[]): { cols: string[]; note: string } | string => {
  const wanted = columns?.length ? columns : t.columns;
  const bad = wanted.filter(c => !t.columns.includes(c));
  if (bad.length) return `Not columns of the active dataset: ${bad.join(', ')}. Columns: ${t.columns.join(', ')}.`;
  const cols = wanted.slice(0, MAX_SAMPLE_COLUMNS);
  const note = cols.length < wanted.length
    ? `${cols.length} of ${wanted.length} (capped at ${MAX_SAMPLE_COLUMNS} — request specific columns for the rest)`
    : cols.join(', ');
  return { cols, note };
};

const readRows = (t: DataTable, idx: number[], cols: string[]): Record<string, unknown>[] =>
  idx.map(i => {
    const row: Record<string, unknown> = { _row: i + 1 };
    for (const c of cols) {
      const v = t.data[c]?.[i];
      row[c] = v == null ? null : typeof v === 'number' ? v : truncateCell(v);
    }
    return row;
  });

export const sampleRowsCore = (t: DataTable, { n, columns, sort_by, direction, seed }: SampleRowsOpts): string => {
  const prep = prepareColumns(t, columns);
  if (typeof prep === 'string') return prep;
  const count = Math.min(Math.max(Math.floor(n ?? 10), 1), MAX_SAMPLE_ROWS);
  let idx: number[];
  let how: string;
  if (sort_by) {
    if (!t.columns.includes(sort_by)) return `"${sort_by}" is not a column. Columns: ${t.columns.join(', ')}.`;
    const vals = t.data[sort_by];
    const dir = direction === 'desc' ? -1 : 1;
    idx = Array.from({ length: t.nRows }, (_, i) => i)
      // Nulls sort last in either direction — an outlier probe should never
      // lead with empty cells.
      .sort((a, b) => {
        const va = vals[a], vb = vals[b];
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        const na = asNumber(va), nb = asNumber(vb);
        if (na !== null && nb !== null) return (na - nb) * dir;
        return String(va).localeCompare(String(vb)) * dir;
      })
      .slice(0, count);
    how = `top ${idx.length} by ${sort_by} (${direction === 'desc' ? 'desc' : 'asc'})`;
  } else {
    idx = sampleIndices(t.nRows, count, Math.floor(seed ?? 1));
    how = `seeded random sample of ${idx.length} (seed ${Math.floor(seed ?? 1)})`;
  }
  return JSON.stringify({ nRows: t.nRows, returned: how, columns: prep.note, rows: readRows(t, idx, prep.cols) });
};

export const rowsWhereCore = (t: DataTable, { column, op, value, columns, limit }: RowsWhereOpts): string => {
  if (!column || !t.columns.includes(column)) return `"${column}" is not a column. Columns: ${t.columns.join(', ')}.`;
  const prep = prepareColumns(t, columns);
  if (typeof prep === 'string') return prep;
  const cap = Math.min(Math.max(Math.floor(limit ?? 10), 1), MAX_SAMPLE_ROWS);
  const vals = t.data[column];
  const num = typeof value === 'number' ? value : asNumber(value);
  const matches = (v: unknown): boolean => {
    if (v == null) return false;
    switch (op) {
      case 'eq': {
        const nv = asNumber(v);
        return (num !== null && nv !== null) ? nv === num : String(v) === String(value);
      }
      case 'lt': case 'gt': {
        const nv = asNumber(v);
        if (num === null || nv === null) return false;
        return op === 'lt' ? nv < num : nv > num;
      }
      case 'contains':
        return String(v).toLowerCase().includes(String(value).toLowerCase());
      default:
        return false;
    }
  };
  const idx: number[] = [];
  let total = 0;
  for (let i = 0; i < t.nRows; i++) {
    if (!matches(vals[i])) continue;
    total++;
    if (idx.length < cap) idx.push(i);
  }
  if (!total) return `No rows match ${column} ${op} ${JSON.stringify(value)}.`;
  return JSON.stringify({ matched: total, returned: idx.length, columns: prep.note, rows: readRows(t, idx, prep.cols) });
};

export const listCategoriesCore = (t: DataTable, column: string): string => {
  if (!column || !t.columns.includes(column)) return `"${column}" is not a column. Columns: ${t.columns.join(', ')}.`;
  const counts = new Map<string, number>();
  let missing = 0;
  for (const v of t.data[column]) {
    if (v == null) { missing++; continue; }
    const s = truncateCell(v);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const entries = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const CAP = 200;
  const shown = entries.slice(0, CAP);
  const tail = entries.length > CAP ? `\n…and ${entries.length - CAP} more distinct values (of ${entries.length} total).` : '';
  return `${column}: ${entries.length} distinct values${missing ? `, ${missing} missing` : ''} across ${t.nRows} rows.\n${shown.map(([v, c]) => `${v}: ${c}`).join('\n')}${tail}`;
};
