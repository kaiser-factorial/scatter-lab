import { expect, it } from 'vitest';
import { materializeSelection, materializeTable, selectionRows, type InputTable } from '../src/data';

const table: InputTable = { columns: ['x', 'y'], nRows: 3, data: { x: [1, null, '2'], y: ['a', 'b', 'c'] } };
it('copies selected columns and rows in requested order without coercion or input mutation', () => {
  const selection = materializeSelection(table, { columns: ['y', 'x'], rows: [2, 0] });
  expect(selection).toEqual({ table: { columns: ['y', 'x'], data: { y: ['c', 'a'], x: ['2', 1] }, nRows: 2 }, columns: ['y', 'x'], rows: [2, 0], sourceRowCount: 3 });
  selection.table.data.x[0] = 99;
  expect(table.data.x).toEqual([1, null, '2']);
});
it('rejects ragged, duplicated, nonfinite, undefined, and sparse input explicitly', () => {
  expect(() => materializeTable({ ...table, nRows: 2 })).toThrow(/exactly nRows/);
  expect(() => materializeTable({ ...table, columns: ['x', 'x'] })).toThrow(/unique/);
  for (const bad of [NaN, Infinity, undefined, true]) expect(() => materializeTable({ columns: ['x'], nRows: 1, data: { x: [bad] } } as unknown as InputTable)).toThrow(/Cells/);
  expect(() => materializeTable({ columns: ['x'], nRows: 1, data: { x: new Array(1) } })).toThrow(/Cells/);
});
it('validates row membership and selected columns without silently deduplicating', () => {
  for (const rows of [[1, 1], [-1], [3], [.5]]) expect(() => selectionRows(3, rows)).toThrow();
  expect(selectionRows(3, [])).toEqual([]);
  expect(() => materializeSelection(table, { columns: ['missing'] })).toThrow();
  expect(() => materializeSelection(table, { columns: ['x', 'x'] })).toThrow();
});
