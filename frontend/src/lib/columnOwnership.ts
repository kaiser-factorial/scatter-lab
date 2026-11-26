import type { PCAResult } from './pca';
import { scatterBack } from './rowFilter';
import type { DataTable } from './table';
import type { TraceEntry } from './analysisRecord';
import type { EfaState } from './efa/types';

interface DatasetColumns {
  table: DataTable;
  originalColumns?: string[];
  samplePartition?: { role: string };
  clusterColumn?: string;
  pcaRuns?: { columns: string[] }[];
  efa?: EfaState;
  provenance?: TraceEntry[];
  summary?: { top_contributors?: Record<string, unknown> } | null;
}

export function availableColumn(base: string, occupied: ReadonlySet<string>) {
  let name = base;
  for (let suffix = 2; occupied.has(name); suffix++) name = `${base}_${suffix}`;
  return name;
}

export function fittedClusterColumn(dataset: DatasetColumns | undefined | null): string | undefined {
  if (!dataset) return;
  if (dataset.clusterColumn || dataset.originalColumns) return dataset.clusterColumn;
  // Older partitions inherit their parent's trace. Only a later cluster action
  // establishes ownership in this table.
  for (const entry of (dataset.provenance ?? []).slice().reverse()) {
    if (entry.event?.kind === 'partition') break;
    if (entry.event?.kind === 'cluster' || (!entry.event && /clustering .*wrote the "Cluster" column$/.test(entry.action)))
      return dataset.table.columns.includes('Cluster') ? 'Cluster' : undefined;
  }
}

export function derivedColumns(dataset: DatasetColumns): string[] {
  if (dataset.originalColumns) {
    const inputs = new Set(dataset.originalColumns);
    return dataset.table.columns.filter(column => !inputs.has(column));
  }
  // Legacy workspaces can identify outputs through saved fits and publication records.
  const owned = new Set<string>(Object.keys(dataset.summary?.top_contributors ?? {}));
  for (const run of dataset.pcaRuns ?? []) for (const column of run.columns) owned.add(column);
  for (const run of dataset.efa?.runs ?? []) {
    for (const column of run.scoreColumns) owned.add(column);
    for (const completion of run.completions ?? [])
      for (const column of Object.values(completion.columns)) owned.add(column);
  }
  const cluster = fittedClusterColumn(dataset);
  if (cluster) owned.add(cluster);
  for (const {event} of dataset.provenance ?? []) {
    if (event?.kind === 'transfer' || event?.kind === 'efa-completion') {
      const outputs = event.fields.reviewed?.derived;
      if (Array.isArray(outputs)) for (const column of outputs) if (typeof column === 'string') owned.add(column);
    }
  }
  return dataset.table.columns.filter(column => owned.has(column));
}

// Publish only the scores calculated by this fit. The numerical result may have
// used conventional PC names already present in an imported input table.
export function publishPcaScores(table: DataTable, result: PCAResult, previous: string[], mask: boolean[] | null) {
  const replaced = previous.filter(column => table.columns.includes(column));
  const retained = table.columns.filter(column => !replaced.includes(column));
  const occupied = new Set(retained);
  const data = { ...table.data };
  for (const column of replaced) delete data[column];
  const columns: string[] = [];
  const loadings: PCAResult['loadings'] = {};
  for (const base of result.columns) {
    const name = availableColumn(base, occupied);
    occupied.add(name);
    columns.push(name);
    const scores = result.table.data[base];
    data[name] = mask ? scatterBack(table.nRows, mask, scores) : scores;
    loadings[name] = result.loadings[base];
  }
  return { ...result, replaced, columns, loadings, table: { ...table, columns: [...retained, ...columns], data } };
}

export function inheritedCompletions(dataset?: DatasetColumns | null): string[] {
  if (!dataset?.samplePartition || dataset.samplePartition.role === 'full' || dataset.originalColumns) return [];
  const outputs = new Set<string>();
  for (const { event } of dataset.provenance ?? []) {
    if (event?.kind === 'partition') return dataset.table.columns.filter(name => outputs.has(name));
    const names = event?.fields.reviewed?.derived;
    if (event?.kind === 'efa-completion' && Array.isArray(names))
      for (const name of names) if (typeof name === 'string') outputs.add(name);
  }
  return [];
}
