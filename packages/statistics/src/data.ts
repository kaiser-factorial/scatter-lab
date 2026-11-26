export type Cell = number | string | null;
/** Columnar input. Missingness is null; numeric strings retain their original type. */
export interface InputTable {
  readonly columns: readonly string[];
  readonly data: Readonly<Record<string, readonly Cell[]>>;
  readonly nRows: number;
}
export interface Selection { columns?: readonly string[]; rows?: readonly number[] }
/** A validated, independent mutable copy; still contains only supported cell types. */
export interface MaterializedTable { columns: string[]; data: Record<string, Cell[]>; nRows: number }
export interface MaterializedSelection {
  table: MaterializedTable;
  columns: string[];
  /** Original input indices, in the requested order. */
  rows: number[];
  sourceRowCount: number;
}

export function materializeTable(input: InputTable): MaterializedTable {
  if (!input || !Array.isArray(input.columns) || !input.data || typeof input.data !== 'object' ||
      !Number.isSafeInteger(input.nRows) || input.nRows < 0 ||
      input.columns.some(name => typeof name !== 'string' || !name.length) ||
      new Set(input.columns).size !== input.columns.length)
    throw new TypeError('A table needs unique nonempty column names, a data record, and a nonnegative integer row count.');
  const data: Record<string, Cell[]> = Object.create(null);
  for (const name of input.columns) {
    const values = input.data[name];
    if (!Object.prototype.hasOwnProperty.call(input.data, name) || !Array.isArray(values) || values.length !== input.nRows)
      throw new TypeError('Every named column must contain exactly nRows cells.');
    data[name] = Array.from(values, value => {
      if (value === null || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)) return value;
      throw new TypeError('Cells must be finite numbers, strings, or null. Normalize undefined, NaN, and infinite values explicitly.');
    });
  }
  return { columns: [...input.columns], data, nRows: input.nRows };
}

export function selectionRows(nRows: number, rows?: readonly number[]): number[] {
  if (!Number.isSafeInteger(nRows) || nRows < 0 || rows !== undefined && !Array.isArray(rows))
    throw new TypeError('Row selection must be an array of input row indices.');
  const selected = rows === undefined ? Array.from({ length: nRows }, (_, i) => i) : [...rows];
  if (new Set(selected).size !== selected.length || selected.some(row => !Number.isSafeInteger(row) || row < 0 || row >= nRows))
    throw new RangeError('Row selection must contain distinct in-range integer indices.');
  return selected;
}

export function materializeSelection(input: InputTable, selection: Selection = {}): MaterializedSelection {
  const source = materializeTable(input);
  if (!selection || typeof selection !== 'object' || Array.isArray(selection) || Object.keys(selection).some(key => !['columns', 'rows'].includes(key)))
    throw new TypeError('Selection accepts only columns and rows.');
  const columns = selection.columns === undefined ? source.columns.slice() : [...selection.columns];
  if (selection.columns !== undefined && !Array.isArray(selection.columns) || !columns.length ||
      new Set(columns).size !== columns.length || columns.some(column => !source.columns.includes(column)))
    throw new RangeError('Select distinct existing columns.');
  const rows = selectionRows(source.nRows, selection.rows), data: Record<string, Cell[]> = Object.create(null);
  for (const column of columns) data[column] = rows.map(row => source.data[column][row] as Cell);
  return { table: { columns: columns.slice(), data, nRows: rows.length }, columns, rows, sourceRowCount: source.nRows };
}
