import { describe, it, expect } from 'vitest';
import type { DataTable } from '../table';
import { sampleRowsCore, rowsWhereCore, listCategoriesCore } from '../rowAccess';
import { MAX_SAMPLE_ROWS, MAX_SAMPLE_COLUMNS, MAX_CELL_CHARS } from '../dataPolicy';

const table = (data: Record<string, unknown[]>): DataTable => {
  const columns = Object.keys(data);
  return { columns, data, nRows: data[columns[0]].length };
};

const wide = (nCols: number, nRows: number): DataTable => {
  const data: Record<string, unknown[]> = {};
  for (let c = 0; c < nCols; c++) data[`c${c}`] = Array.from({ length: nRows }, (_, i) => i);
  return table(data);
};

const t = table({
  id: [1, 2, 3, 4, 5, 6],
  score: [10, 50, 30, null, 20, 99],
  group: ['a', 'a', 'b', 'b', 'a', 'zebra'],
});

describe('sampleRowsCore', () => {
  it('samples deterministically for a fixed seed', () => {
    const a = sampleRowsCore(t, { n: 3, seed: 7 });
    const b = sampleRowsCore(t, { n: 3, seed: 7 });
    expect(a).toBe(b);
    expect(JSON.parse(a).rows).toHaveLength(3);
  });

  it('different seeds can draw different samples', () => {
    const big = wide(1, 200);
    const a = JSON.parse(sampleRowsCore(big, { n: 5, seed: 1 })).rows.map((r: { _row: number }) => r._row);
    const b = JSON.parse(sampleRowsCore(big, { n: 5, seed: 2 })).rows.map((r: { _row: number }) => r._row);
    expect(a).not.toEqual(b);
  });

  it('caps n at MAX_SAMPLE_ROWS', () => {
    const big = wide(1, 500);
    const res = JSON.parse(sampleRowsCore(big, { n: 10_000 }));
    expect(res.rows).toHaveLength(MAX_SAMPLE_ROWS);
  });

  it('caps columns at MAX_SAMPLE_COLUMNS and says so', () => {
    const res = JSON.parse(sampleRowsCore(wide(30, 5), { n: 2 }));
    expect(Object.keys(res.rows[0])).toHaveLength(MAX_SAMPLE_COLUMNS + 1); // + _row
    expect(res.columns).toContain('capped');
  });

  it('sorts descending with nulls last', () => {
    const res = JSON.parse(sampleRowsCore(t, { n: 6, sort_by: 'score', direction: 'desc' }));
    expect(res.rows.map((r: { score: number | null }) => r.score)).toEqual([99, 50, 30, 20, 10, null]);
  });

  it('sorts ascending with nulls last too', () => {
    const res = JSON.parse(sampleRowsCore(t, { n: 6, sort_by: 'score', direction: 'asc' }));
    expect(res.rows.map((r: { score: number | null }) => r.score)).toEqual([10, 20, 30, 50, 99, null]);
  });

  it('rejects unknown columns by name', () => {
    expect(sampleRowsCore(t, { columns: ['nope'] })).toContain('Not columns');
    expect(sampleRowsCore(t, { sort_by: 'nope' })).toContain('not a column');
  });

  it('truncates long text cells', () => {
    const long = 'x'.repeat(1000);
    const res = JSON.parse(sampleRowsCore(table({ txt: [long] }), { n: 1 }));
    expect(res.rows[0].txt.length).toBe(MAX_CELL_CHARS);
    expect(res.rows[0].txt.endsWith('…')).toBe(true);
  });
});

describe('rowsWhereCore', () => {
  it('eq matches numerically and by string', () => {
    expect(JSON.parse(rowsWhereCore(t, { column: 'score', op: 'eq', value: 30 })).matched).toBe(1);
    expect(JSON.parse(rowsWhereCore(t, { column: 'group', op: 'eq', value: 'b' })).matched).toBe(2);
  });

  it('lt/gt compare numerically and skip nulls', () => {
    const lt = JSON.parse(rowsWhereCore(t, { column: 'score', op: 'lt', value: 30 }));
    expect(lt.matched).toBe(2);
    const gt = JSON.parse(rowsWhereCore(t, { column: 'score', op: 'gt', value: 30 }));
    expect(gt.matched).toBe(2);
  });

  it('contains is case-insensitive substring', () => {
    const res = JSON.parse(rowsWhereCore(t, { column: 'group', op: 'contains', value: 'ZEB' }));
    expect(res.matched).toBe(1);
    expect(res.rows[0].group).toBe('zebra');
  });

  it('reports total matches beyond the returned cap', () => {
    const big = wide(1, 300);
    const res = JSON.parse(rowsWhereCore(big, { column: 'c0', op: 'gt', value: -1, limit: 5 }));
    expect(res.matched).toBe(300);
    expect(res.returned).toBe(5);
    expect(res.rows).toHaveLength(5);
  });

  it('says so when nothing matches', () => {
    expect(rowsWhereCore(t, { column: 'score', op: 'eq', value: 12345 })).toContain('No rows match');
  });

  it('rejects an unknown filter column', () => {
    expect(rowsWhereCore(t, { column: 'nope', op: 'eq', value: 1 })).toContain('not a column');
  });
});

describe('listCategoriesCore', () => {
  it('lists every value with counts, including single-row values', () => {
    const res = listCategoriesCore(t, 'group');
    expect(res).toContain('a: 3');
    expect(res).toContain('b: 2');
    expect(res).toContain('zebra: 1');
    expect(res).toContain('3 distinct values');
  });

  it('counts missing values', () => {
    expect(listCategoriesCore(t, 'score')).toContain('1 missing');
  });

  it('caps the listing at 200 distinct values with a tail note', () => {
    const many = table({ v: Array.from({ length: 500 }, (_, i) => `v${i}`) });
    const res = listCategoriesCore(many, 'v');
    expect(res.split('\n').length).toBeLessThan(210);
    expect(res).toContain('300 more distinct values');
  });
});
