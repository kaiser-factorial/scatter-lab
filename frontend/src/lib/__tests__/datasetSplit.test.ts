import { describe, expect, it } from 'vitest';
import { createDatasetPartitions, validateDatasetPartition } from '../datasetSplit';
import { validateWorkspace, WORKSPACE_VERSION } from '../workspaces';
import type { DataTable } from '../table';

const table = (): DataTable => ({
  columns: ['item', 'group', 'partition', 'PC1'],
  data: {
    item: Array.from({ length: 20 }, (_, i) => i === 4 ? null : i + 0.5),
    group: Array.from({ length: 20 }, (_, i) => `group${Math.floor(i / 2)}`),
    partition: Array.from({ length: 20 }, (_, i) => i < 14 ? 'dev' : 'test'),
    PC1: Array.from({ length: 20 }, (_, i) => i * 10),
  },
  nRows: 20,
});

describe('dataset development / holdout partitions', () => {
  it('covers every original row exactly once and retains original row order', () => {
    const result = createDatasetPartitions(table(), 101);
    expect(result.development.table.nRows).toBe(14);
    expect(result.holdout.table.nRows).toBe(6);
    const dev = result.development.samplePartition.sourceRows;
    const hold = result.holdout.samplePartition.sourceRows;
    expect([...dev, ...hold].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(new Set([...dev, ...hold]).size).toBe(20);
    for (const part of [result.development, result.holdout]) {
      expect(part.samplePartition.sourceRows).toEqual([...part.samplePartition.sourceRows].sort((a, b) => a - b));
      expect(part.table.data.item).toEqual(part.samplePartition.sourceRows.map(i => table().data.item[i]));
    }
    expect(result.full.samplePartition.locked).toBe(true);
    expect(result.holdout.samplePartition.locked).toBe(true);
    expect(result.development.samplePartition.locked).toBe(false);
  });

  it('reproduces membership with the same seed and keeps grouped respondents together', () => {
    const a = createDatasetPartitions(table(), 1, { seed: 91, fraction: 0.6, groupColumn: 'group' });
    const b = createDatasetPartitions(table(), 1, { seed: 91, fraction: 0.6, groupColumn: 'group' });
    expect(a.split.development).toEqual(b.split.development);
    const devGroups = new Set(a.development.table.data.group);
    expect(b.holdout.table.data.group.every(g => !devGroups.has(g))).toBe(true);
  });

  it('copies arrays without coercing values and removes full-sample derived columns only from children', () => {
    const source = table();
    const result = createDatasetPartitions(source, 1, { excludeColumns: ['PC1'] });
    expect(result.full.table).toEqual(source);
    expect(result.development.table.columns).toEqual(['item', 'group', 'partition']);
    expect(result.holdout.table.data.PC1).toBeUndefined();
    expect(result.full.table.columns).not.toBe(source.columns);
    expect(result.full.table.data.item).not.toBe(source.data.item);
    const row = result.development.samplePartition.sourceRows[0];
    result.development.table.data.item[0] = 9999;
    expect(source.data.item[row]).not.toBe(9999);
    expect(result.full.table.data.item[row]).not.toBe(9999);
    expect(result.holdout.table.data.item).not.toContain(9999);
  });

  it('honors a complete existing split column and rejects unassigned rows', () => {
    const options = { sourceColumn: 'partition', developmentValue: 'dev', holdoutValue: 'test' };
    const result = createDatasetPartitions(table(), 1, options);
    expect(result.development.table.nRows).toBe(14);
    expect(result.split.sourceColumn).toBe('partition');
    const incomplete = table();
    incomplete.data.partition[19] = null;
    expect(() => createDatasetPartitions(incomplete, 1, options)).toThrow(/Every row/);
    expect(() => createDatasetPartitions(table(), 1, { ...options, holdoutValue: 'dev' })).toThrow(/distinct/);
  });

  it('rejects malformed inputs and invalid fractions instead of leaving partial datasets', () => {
    expect(() => createDatasetPartitions({ ...table(), nRows: 1 }, 1)).toThrow(/At least two/);
    expect(() => createDatasetPartitions(table(), 1, { fraction: 1 })).toThrow(/between zero and one/);
    expect(() => createDatasetPartitions(table(), 1, { seed: 1.5 })).toThrow(/integer split seed/);
    expect(() => createDatasetPartitions({ ...table(), nRows: 21 }, 1)).toThrow(/one value per row/);
    expect(() => createDatasetPartitions(table(), 1, { excludeColumns: table().columns })).toThrow(/No original input/);
  });

  it('persists all locks and memberships and accepts an explicitly unlocked holdout', () => {
    const result = createDatasetPartitions(table(), 1);
    const datasets = [result.full, result.development, result.holdout].map((p, i) => ({ id: i + 1, name: p.samplePartition.role, ...p }));
    const workspace = JSON.parse(JSON.stringify({ version: WORKSPACE_VERSION, activeId: 2, datasets }));
    expect(() => validateWorkspace(workspace)).not.toThrow();
    expect(workspace.datasets.map((d: { samplePartition: { locked: boolean } }) => d.samplePartition.locked)).toEqual([true, false, true]);
    workspace.datasets[2].samplePartition.locked = false;
    workspace.datasets[2].samplePartition.unlockedAt = new Date().toISOString();
    expect(() => validateWorkspace(workspace)).not.toThrow();
  });

  it('rejects damaged membership and malformed lock states during workspace import', () => {
    const p = createDatasetPartitions(table(), 1).holdout;
    for (const bad of [
      { ...p.samplePartition, locked: 'false' },
      { ...p.samplePartition, role: 'unknown' },
      { ...p.samplePartition, sourceRows: [0, 0, 2, 3, 4, 5] },
      { ...p.samplePartition, sourceRows: [0, 1, 2, 3, 4, 20] },
      { ...p.samplePartition, sourceRows: [0] },
      { ...p.samplePartition, sourceRowCount: 2 },
    ]) {
      expect(() => validateWorkspace({ version: WORKSPACE_VERSION, datasets: [{ name: 'Holdout', table: p.table, samplePartition: bad }] })).toThrow(/damaged.*Holdout.*partition/);
    }
    expect(() => validateDatasetPartition(undefined, 20)).not.toThrow();
  });

  it('rejects overlapping siblings but permits a saved workspace after deleting a sibling', () => {
    const result = createDatasetPartitions(table(), 1);
    const datasets = [result.full, result.development, result.holdout];
    const workspace = { version: WORKSPACE_VERSION, datasets };
    expect(() => validateWorkspace({ ...workspace, datasets: [result.development] })).not.toThrow();
    result.holdout.samplePartition.sourceRows = result.development.samplePartition.sourceRows.slice(0, 6);
    expect(() => validateWorkspace(workspace)).toThrow(/disjoint membership/);
    expect(() => validateWorkspace({ ...workspace, datasets: [result.full, result.full] })).toThrow(/inconsistent source/);
  });
});
