import { describe, expect, it, vi } from 'vitest';
import { commitDatasetAnalysis } from '../datasetAnalysis';
import { createDatasetPartitions } from '../datasetSplit';
import { runPCA } from '../pca';
import type { DataTable } from '../table';

const source: DataTable = {
  columns: ['x', 'y', 'z'],
  data: {
    x: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    y: [4, 1, 7, 3, 6, 2, 9, 8, 5, 10],
    z: [2, 3, 1, 8, 4, 9, 5, 7, 6, 10],
  },
  nRows: 10,
};
const fixture = () => {
  const parts = createDatasetPartitions(source, 1);
  return [parts.full, parts.development, parts.holdout]
    .map((part, i) => ({ id: i + 1, ...part, provenance: [] as string[] }));
};

describe('publishing analyses into partitioned datasets', () => {
  it('publishes an actual development PCA only to its captured target and keeps both locked tables intact', () => {
    const datasets = fixture();
    const dev = datasets[1];
    const pca = runPCA(dev.table, ['x', 'y', 'z'], { k: 2, standardize: true, label: 'dev', missing: 'mean' });
    const result = commitDatasetAnalysis(datasets, { datasetId: dev.id, table: dev.table }, d => ({
      ...d, table: pca.table, provenance: [...d.provenance, 'PCA on development'],
    }));
    expect(result[0]).toBe(datasets[0]);
    expect(result[2]).toBe(datasets[2]);
    expect(result[1].table.nRows).toBe(7);
    expect(result[1].table.columns).toContain('PC1_dev');
    expect(result[1].samplePartition.sourceRows).toEqual(dev.samplePartition.sourceRows);
    expect(result[1].provenance).toEqual(['PCA on development']);
    expect(result[0].table.columns).not.toContain('PC1_dev');
  });

  it('rejects a late full-dataset result after the full dataset becomes locked, even with matching table identity', () => {
    const datasets = fixture();
    const update = vi.fn(d => ({ ...d, table: datasets[1].table }));
    expect(commitDatasetAnalysis(datasets, { datasetId: 1, table: source }, update)).toBe(datasets);
    expect(commitDatasetAnalysis(datasets, { datasetId: 1, table: datasets[0].table }, update)).toBe(datasets);
    expect(update).not.toHaveBeenCalled();
    expect(datasets[0].table.nRows).toBe(10);
  });

  it('rejects an obsolete result after a table edit or workspace reload and does not append its provenance', () => {
    const datasets = fixture();
    const oldTarget = { datasetId: 2, table: datasets[1].table };
    const edited = datasets.map(d => d.id === 2 ? { ...d, table: { ...d.table, data: { ...d.table.data, x: d.table.data.x.map(x => x + 1) } } } : d);
    const update = vi.fn(d => ({ ...d, provenance: [...d.provenance, 'obsolete fit'] }));
    expect(commitDatasetAnalysis(edited, oldTarget, update)).toBe(edited);
    const restored = structuredClone(datasets);
    expect(commitDatasetAnalysis(restored, oldTarget, update)).toBe(restored);
    expect(update).not.toHaveBeenCalled();
  });

  it('supports successive queued fits when each captures the preceding table, without losing partition metadata', () => {
    let datasets = fixture();
    const firstInput = datasets[1].table;
    const first = runPCA(firstInput, ['x', 'y'], { k: 1, standardize: true, label: 'first', missing: 'median' });
    const second = runPCA(first.table, ['y', 'z'], { k: 1, standardize: true, label: 'second', missing: 'median' });
    const firstTarget = { datasetId: 2, table: firstInput };
    const secondTarget = { datasetId: 2, table: first.table };
    datasets = commitDatasetAnalysis(datasets, firstTarget, d => ({ ...d, table: first.table, provenance: [...d.provenance, 'first'] }));
    datasets = commitDatasetAnalysis(datasets, secondTarget, d => ({ ...d, table: second.table, provenance: [...d.provenance, 'second'] }));
    expect(datasets[1].table.columns).toEqual(expect.arrayContaining(['COMP_first', 'COMP_second']));
    expect(datasets[1].provenance).toEqual(['first', 'second']);
    expect(datasets[1].samplePartition.role).toBe('development');
    expect(datasets[1].table.nRows).toBe(datasets[1].samplePartition.sourceRows.length);
    expect(datasets[0].table.nRows).toBe(10);
    expect(datasets[2].table.nRows).toBe(3);
  });
});
