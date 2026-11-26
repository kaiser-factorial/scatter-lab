import { expect, it } from 'vitest';
import { event } from '../analysisRecord';
import { derivedColumns, fittedClusterColumn, inheritedCompletions, publishPcaScores } from '../columnOwnership';
import { runPCA } from '../pca';
import { createDatasetPartitions } from '../datasetSplit';
import { subsetTable } from '../rowFilter';

const table = { nRows: 6, columns: ['A', 'B', 'Cluster', 'PC1', 'COMP_Index'],
  data: { A: [1,2,3,4,5,6], B: [3,1,4,6,5,9], Cluster: [4,4,5,5,6,6], PC1: [8,7,6,5,4,3], COMP_Index: [1,2,1,2,1,2] } };
const trace = (e: ReturnType<typeof event>) => ({ at: '', action: '', event: e });

it('keeps original names and only replaces outputs owned by the previous PCA', () => {
  const mask = [true,true,true,true,true,false];
  const fit = runPCA(subsetTable(table, mask), ['A','B'], { k: 2, standardize: true });
  const published = publishPcaScores(table, fit, [], mask);
  expect(published.columns).toEqual(['PC1_2','PC2']);
  expect(published.table.data.PC1).toEqual(table.data.PC1);
  expect(published.table.data.PC1_2[5]).toBeNull();
  const rerun = publishPcaScores(published.table, fit, published.columns, mask);
  expect(rerun.table.columns).toEqual(published.table.columns);
  expect(rerun.loadings.PC1_2).toEqual(fit.loadings.PC1);
  const excluded = derivedColumns({table: rerun.table, originalColumns: table.columns});
  const split = createDatasetPartitions(rerun.table, 1, {excludeColumns: excluded});
  expect(split.development.table.columns).toEqual(table.columns);
  expect(split.holdout.table.columns).toEqual(table.columns);
});

it('uses saved output evidence for legacy workspaces and identifies old full-fit completions', () => {
  const provenance = [trace(event('cluster')), trace(event('efa-completion', {reviewed: {derived: ['A_completed']}}))];
  const legacy = {table: {...table, columns: [...table.columns,'A_completed']}, provenance};
  expect(derivedColumns({table})).toEqual([]);
  expect(derivedColumns(legacy)).toEqual(['Cluster','A_completed']);
  const child = {...legacy, samplePartition: {role: 'development'}, provenance: [...provenance,trace(event('partition'))]};
  expect(fittedClusterColumn(child)).toBeUndefined();
  expect(inheritedCompletions(child)).toEqual(['A_completed']);
  expect(inheritedCompletions({...child, provenance: [...child.provenance,trace(event('efa-completion',{reviewed:{derived:['B_completed']}}))]})).toEqual(['A_completed']);
});
