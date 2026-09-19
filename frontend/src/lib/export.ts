import { CSV_BOM, csvCell } from './csv';
import { isPCColumn } from './pca';
import type { DataTable } from './table';

// Dataset export as pure functions: which columns, and how a table becomes
// bytes for each text format. XLSX is written at the call site (SheetJS is a
// dynamic import) from the same column selection.

export type DataFormat = 'csv' | 'tsv' | 'json' | 'xlsx';
export type ImageFormat = 'png' | 'svg' | 'gif' | 'html';

export const DATA_FORMATS: { id: DataFormat; label: string; hint: string }[] = [
  { id: 'csv', label: 'CSV', hint: 'comma-separated, UTF-8 with BOM — opens cleanly in Excel' },
  { id: 'tsv', label: 'TSV', hint: 'tab-separated, UTF-8 with BOM' },
  { id: 'xlsx', label: 'XLSX', hint: 'Excel workbook, one sheet' },
  { id: 'json', label: 'JSON', hint: 'array of row objects' },
];

/** Columns this app added: PC scores, composites and cluster labels. */
export const isDerivedColumn = (name: string): boolean => isPCColumn(name) || /^COMP_/i.test(name) || name === 'Cluster';

export const selectExportColumns = (table: DataTable, includeDerived: boolean): string[] =>
  includeDerived ? [...table.columns] : table.columns.filter(c => !isDerivedColumn(c));

const tsvCell = (value: unknown): string => {
  if (value == null) return '';
  // Same formula guard as CSV; tabs and newlines cannot be quoted in TSV, so
  // they are replaced with spaces.
  const c = csvCell(value);
  const raw = c.startsWith('"') && c.endsWith('"') ? c.slice(1, -1).replace(/""/g, '"') : c;
  return raw.replace(/[\t\r\n]+/g, ' ');
};

export const serializeTable = (
  table: DataTable, columns: string[], format: Exclude<DataFormat, 'xlsx'>,
): { content: string; mime: string; ext: string } => {
  if (format === 'json') {
    const rows = Array.from({ length: table.nRows }, (_, i) => {
      const row: Record<string, unknown> = {};
      for (const c of columns) row[c] = table.data[c]?.[i] ?? null;
      return row;
    });
    return { content: JSON.stringify(rows), mime: 'application/json', ext: 'json' };
  }
  const sep = format === 'csv' ? ',' : '\t';
  const cell = format === 'csv' ? csvCell : tsvCell;
  const lines = [
    columns.map(cell).join(sep),
    ...Array.from({ length: table.nRows }, (_, i) => columns.map(c => cell(table.data[c]?.[i])).join(sep)),
  ];
  return {
    content: CSV_BOM + lines.join('\r\n'),
    mime: format === 'csv' ? 'text/csv;charset=utf-8' : 'text/tab-separated-values;charset=utf-8',
    ext: format,
  };
};

/** `<dataset>_data[_filtered].<ext>` — the suffix says the file is a subset. */
export const dataExportFilename = (dataset: string, ext: string, filtered: boolean): string =>
  `${dataset}_data${filtered ? '_filtered' : ''}.${ext}`;
