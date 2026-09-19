import { describe, it, expect } from 'vitest';
import type { DataTable } from '../table';
import { selectExportColumns, serializeTable, dataExportFilename, isDerivedColumn } from '../export';
import { CSV_BOM } from '../csv';

const t: DataTable = {
  columns: ['id', 'note', 'PC1', 'COMP_open', 'Cluster'],
  data: {
    id: [1, 2], note: ['a,b', 'tab\there'], PC1: [-1.5, 0.25], COMP_open: [0.1, null], Cluster: ['Cluster 0', null],
  },
  nRows: 2,
};

describe('selectExportColumns', () => {
  it('drops PC, composite and Cluster columns when derived columns are excluded', () => {
    expect(selectExportColumns(t, true)).toEqual(t.columns);
    expect(selectExportColumns(t, false)).toEqual(['id', 'note']);
    expect(isDerivedColumn('PC2_openness')).toBe(true);
    expect(isDerivedColumn('PCA_notes')).toBe(false);
  });
});

describe('serializeTable', () => {
  it('csv quotes commas, carries the BOM, and keeps negative numbers bare', () => {
    const { content, ext } = serializeTable(t, t.columns, 'csv');
    expect(ext).toBe('csv');
    expect(content.startsWith(CSV_BOM)).toBe(true);
    const lines = content.slice(CSV_BOM.length).split('\r\n');
    expect(lines[0]).toBe('id,note,PC1,COMP_open,Cluster');
    expect(lines[1]).toBe('1,"a,b",-1.5,0.1,Cluster 0');
    expect(lines[2]).toBe('2,tab\there,0.25,,');
  });
  it('tsv separates with tabs and flattens tabs inside cells', () => {
    const { content } = serializeTable(t, ['id', 'note'], 'tsv');
    const lines = content.slice(CSV_BOM.length).split('\r\n');
    expect(lines[0]).toBe('id\tnote');
    expect(lines[1]).toBe('1\ta,b');
    expect(lines[2]).toBe('2\ttab here');
  });
  it('json is an array of row objects with null for gaps and no BOM', () => {
    const { content, mime } = serializeTable(t, ['id', 'Cluster'], 'json');
    expect(mime).toBe('application/json');
    expect(JSON.parse(content)).toEqual([{ id: 1, Cluster: 'Cluster 0' }, { id: 2, Cluster: null }]);
  });
});

describe('dataExportFilename', () => {
  it('suffixes a subset', () => {
    expect(dataExportFilename('iris', 'csv', false)).toBe('iris_data.csv');
    expect(dataExportFilename('iris', 'xlsx', true)).toBe('iris_data_filtered.xlsx');
  });
});
