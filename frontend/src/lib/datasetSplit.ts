import type { DataTable } from './table';
import { createSampleSplit, existingSampleSplit } from './efa/state';
import type { SampleSplit } from './efa/types';

/** Membership is expressed in the original full table's row coordinates. */
export interface DatasetPartition {
  groupId: string;
  role: 'full' | 'development' | 'holdout';
  locked: boolean;
  sourceDatasetId: number;
  sourceRowCount: number;
  sourceRows: number[];
  createdAt: string;
  unlockedAt?: string;
}

export interface DatasetSplitOptions {
  seed?: number;
  fraction?: number;
  groupColumn?: string;
  stratumColumn?: string;
  sourceColumn?: string;
  developmentValue?: string;
  holdoutValue?: string;
  afterFullExploration?: boolean;
  /** Full-sample derived scores must not become inputs in the child datasets. */
  excludeColumns?: string[];
}

export interface PartitionTable {
  table: DataTable;
  samplePartition: DatasetPartition;
}

export interface DatasetPartitions {
  split: SampleSplit;
  full: PartitionTable;
  development: PartitionTable;
  holdout: PartitionTable;
}

/**
 * Partition the complete input, independently of any plot or analysis filter.
 * Each child is a real table, so every analysis uses the same membership. Its
 * arrays are independent of both the source and its sibling's arrays.
 */
export function createDatasetPartitions(
  table: DataTable,
  sourceDatasetId: number,
  options: DatasetSplitOptions = {},
): DatasetPartitions {
  if (!Number.isSafeInteger(sourceDatasetId)) throw new Error('The source dataset needs a valid ID.');
  if (!Number.isSafeInteger(table.nRows) || table.nRows < 2)
    throw new Error('At least two rows are needed to create development and holdout datasets.');
  if (!table.columns.length || new Set(table.columns).size !== table.columns.length
      || table.columns.some(c => !Array.isArray(table.data[c]) || table.data[c].length !== table.nRows))
    throw new Error('The dataset columns must contain one value per row before splitting.');

  const allRows = Array.from({ length: table.nRows }, (_, i) => i);
  const split = options.sourceColumn
    ? existingSampleSplit(
      table, allRows, options.sourceColumn,
      options.developmentValue ?? 'development', options.holdoutValue ?? 'holdout',
      options.afterFullExploration ?? false,
    )
    : createSampleSplit(table, allRows, {
      seed: options.seed ?? 2026,
      fraction: options.fraction ?? 0.7,
      groupColumn: options.groupColumn,
      stratumColumn: options.stratumColumn,
      afterFullExploration: options.afterFullExploration ?? false,
    });
  if (split.development.length + split.holdout.length !== table.nRows)
    throw new Error('Every row must match either the development or holdout value in the split column.');

  const excluded = new Set(options.excludeColumns ?? []);
  const childColumns = table.columns.filter(c => !excluded.has(c));
  if (!childColumns.length) throw new Error('No original input columns remain for the split datasets.');
  const part = (role: DatasetPartition['role'], rows: number[], columns: string[]): PartitionTable => ({
    table: {
      columns: columns.slice(),
      data: Object.fromEntries(columns.map(c => [c, rows.map(row => table.data[c][row])])),
      nRows: rows.length,
    },
    samplePartition: {
      groupId: split.id,
      role,
      locked: role !== 'development',
      sourceDatasetId,
      sourceRowCount: table.nRows,
      sourceRows: rows.slice(),
      createdAt: split.createdAt,
    },
  });
  return {
    split,
    full: part('full', allRows, table.columns),
    development: part('development', split.development, childColumns),
    holdout: part('holdout', split.holdout, childColumns),
  };
}

/** A missing partition is a legacy or unsplit dataset; malformed locks fail closed. */
export function validateDatasetPartition(value: unknown, nRows: number): void {
  if (value == null) return;
  const fail = () => { throw new Error('Invalid dataset partition membership or lock state.'); };
  if (typeof value !== 'object' || Array.isArray(value)) return fail();
  const p = value as Record<string, unknown>;
  if (typeof p.groupId !== 'string' || !p.groupId.trim()
      || !['full', 'development', 'holdout'].includes(String(p.role))
      || typeof p.locked !== 'boolean'
      || !Number.isSafeInteger(p.sourceDatasetId)
      || !Number.isSafeInteger(p.sourceRowCount) || (p.sourceRowCount as number) < 2
      || typeof p.createdAt !== 'string' || !Number.isFinite(Date.parse(p.createdAt))
      || (p.unlockedAt !== undefined && (typeof p.unlockedAt !== 'string' || !Number.isFinite(Date.parse(p.unlockedAt))))
      || !Array.isArray(p.sourceRows) || p.sourceRows.length !== nRows) return fail();
  let previous = -1;
  for (const row of p.sourceRows) {
    if (!Number.isSafeInteger(row) || row <= previous || row >= (p.sourceRowCount as number)) return fail();
    previous = row;
  }
  if (p.role === 'full' && (nRows !== p.sourceRowCount || p.sourceRows.some((row, i) => row !== i))) return fail();
  if (p.role !== 'full' && (nRows < 1 || nRows >= (p.sourceRowCount as number))) return fail();
}

/** Allow deleted siblings, but reject contradictory membership among surviving ones. */
export function validatePartitionGroups(partitions: DatasetPartition[]): void {
  const groups = new Map<string, DatasetPartition[]>();
  for (const partition of partitions) {
    const siblings = groups.get(partition.groupId) ?? [];
    if (siblings.some(s => s.role === partition.role
        || s.sourceDatasetId !== partition.sourceDatasetId
        || s.sourceRowCount !== partition.sourceRowCount))
      throw new Error('Dataset partition siblings have inconsistent source metadata.');
    siblings.push(partition);
    groups.set(partition.groupId, siblings);
  }
  for (const siblings of groups.values()) {
    const dev = siblings.find(p => p.role === 'development');
    const holdout = siblings.find(p => p.role === 'holdout');
    if (!dev || !holdout) continue;
    const developmentRows = new Set(dev.sourceRows);
    if (dev.sourceRows.length + holdout.sourceRows.length !== dev.sourceRowCount
        || holdout.sourceRows.some(row => developmentRows.has(row)))
      throw new Error('Development and holdout datasets must have disjoint membership covering the original rows.');
  }
}
