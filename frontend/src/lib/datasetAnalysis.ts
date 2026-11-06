import type { DataTable } from './table';

export type DatasetAnalysisTarget = { datasetId: number; table: DataTable };
type AnalysisDataset = { id: number; table: DataTable; samplePartition?: { locked: boolean } };

/** Publish against the input snapshot, never against a formerly active dataset. */
export function commitDatasetAnalysis<T extends AnalysisDataset>(
  datasets: T[],
  target: DatasetAnalysisTarget,
  update: (dataset: T) => T,
): T[] {
  const index = datasets.findIndex(d => d.id === target.datasetId
    && d.table === target.table && !d.samplePartition?.locked);
  if (index < 0) return datasets;
  const next = datasets.slice();
  next[index] = update(datasets[index]);
  return next;
}
