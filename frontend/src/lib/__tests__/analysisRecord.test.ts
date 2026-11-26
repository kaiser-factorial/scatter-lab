import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { attachDigests, buildAnalysisRecord, efaEvents, event, fileDigest, filterFields, pcaEvent, plottedRows, splitEvent, type TraceEntry } from '../analysisRecord';
import { createDatasetPartitions } from '../datasetSplit';
import { runPCA } from '../pca';
import { buildRowMask, subsetTable } from '../rowFilter';
import type { EfaState } from '../efa/types';

const at = '2026-11-24T15:00:00.000Z';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const read = (text: string) => text.trimEnd().split('\n').map(line => JSON.parse(line));

describe('local analysis records', () => {
  it('exports immediately after import, waiting for exact input bytes (not parsed cells)', async () => {
    const entry = { at, action: 'Loaded data', event: event('import', { rows: 2 }) };
    const raw = '\uFEFFa\r\n1\r\n';
    attachDigests(entry, fileDigest(new File([raw], 'test.csv')).then(inputSha256 => ({inputSha256})));
    const [json, md, sums] = await buildAnalysisRecord([entry], { dimension: '2D' });
    const events = read(json.text);
    expect(events.map(row => row.kind)).toEqual(['import','view']);
    expect(events[0]).toMatchObject({schema:'scatterlab.analysis/1', fields:{inputSha256:hash(raw)}, missingFields:[]});
    expect(md.text).toContain(hash(raw));
    expect(sums.text).toBe(`${hash(json.text)}  analysis.jsonl\n${hash(md.text)}  analysis.md\n`);
    expect(sums.text).not.toContain(hash(json.text.replace('import','other')));
  });

  it('keeps exact metadata opt-in, ordered and projected through a nested allowlist', async () => {
    const filters = [{column:'team', op:'in' as const, value:['blue','red']}];
    const unsafe = { variables:['team'], filters, items:[{column:'Q2',categories:['Often','Sometimes'],reverse:true,rawRows:['NEVER']}], recodes:[{column:'Q2', values:[-9]}], chat:'NEVER', rawRows:['NEVER'], apiKey:'NEVER' };
    const trace = [{ at, action:'old label; token=abcdef123456', }, { at, action:'NEVER', event:event('pca', { ...filterFields(['Q2','team'],filters), reviewed:unsafe }) }];
    const masked = await buildAnalysisRecord(trace, {});
    expect(masked.map(file => file.text).join('')).not.toMatch(/old label|abcdef|blue|Often|NEVER|team/);
    expect(read(masked[0].text)[0]).toMatchObject({kind:'legacy',missingFields:expect.arrayContaining(['settings'])});
    const reviewed = await buildAnalysisRecord(trace, {}, undefined, true);
    expect(reviewed.map(file => file.text).join('')).not.toMatch(/NEVER|abcdef/);
    expect(read(reviewed[0].text)[0].metadata.legacyProse).toBe('old label; [credential withheld]');
    expect(read(reviewed[0].text)[1].metadata).toEqual({variables:['team'], filters, items:[{column:'Q2',categories:['Often','Sometimes'],reverse:true}],recodes:[{column:'Q2',values:[-9]}]});
    expect(reviewed[1].text).toContain('Sometimes');
  });

  it('distinguishes filtered, plottable and source-row membership without exporting row indices', async () => {
    const table = {columns:['x','y'], data:{x:[1,null,3,4],y:[0,2,3,4]}, nRows:4};
    const plotted = plottedRows(table,['x','y'],[true,true,true,false],row => row === 2);
    expect(plotted).toEqual([0]);
    const [json] = await buildAnalysisRecord([], {visible:3}, {role:'development',groupId:'split',sourceDatasetId:1,sourceRows:[3,6,8,10],locked:false,sourceRowCount:12,createdAt:at}, true, {plotted});
    const [membership,view] = read(json.text);
    expect(membership.fields.membershipSha256).toBe(hash('[3,6,8,10]'));
    expect(view.fields).toMatchObject({visible:3,plotted:1,plottedSha256:hash('[3]')});
    expect(view.missingFields).toContain('dataset-history');
    expect(json.text).not.toContain('[3,6,8,10]');
  });

  it('captures a saved fit once, preserving settings but excluding scores, response data and row arrays', async () => {
    const empty: EfaState = {runs:[],splits:[]};
    const saved = { ...empty, runs:[{id:'fit-1',kind:'fit',revision:1,createdAt:at,eligibleRows:[2,4,8],spec:{items:[{column:'Q3',categories:[3,2,1],reverse:true}], nFactors:1, rotation:'oblimin', missing:'complete',seed:23,label:'trial',sample:{partition:'all',fixedRows:[2,4]}}, result:{ fittingRows:[2,4], diagnostics:[{code:'warning',message:'NEVER'}],provenance:{engine:'scatter-efa/10',execution:{backend:'cpu'}}, extraction:{convergence:{converged:true,iterations:9}},rotation:{convergence:{converged:false,iterations:200}} }}]} as unknown as EfaState;
    const trace: TraceEntry[] = efaEvents(empty,saved,['Q1','Q3']);
    expect(efaEvents(saved,saved,['Q1','Q3'])).toEqual([]);
    const [json] = await buildAnalysisRecord(trace, {}, undefined,true,{efa:saved,plotted:[]});
    expect(read(json.text)[0]).toMatchObject({kind:'efa-fit',fields:{inputs:[2],eligible:3,fitted:2,converged:true,rotationConverged:false,backend:'cpu'},metadata:{runId:'fit-1',items:[{column:'Q3',categories:[3,2,1],reverse:true}]}});
    expect(read(json.text)[1].fields.fittingSha256).toBe(hash('[2,4]'));
    expect(json.text).not.toMatch(/NEVER|fixedRows|eligibleRows|fittingRows/);
  });

  it('reconstructs development membership, filter and PCA scores from original input plus the reviewed record', async () => {
    const values = Array.from({ length:40 }, (_, row) => row);
    const table = { nRows:40, columns:['target','other','stratum'], data:{target:values.map(row => row % 9), other:values.map(row => row % 13), stratum:values.map(row => row % 2 ? 'a' : 'b')} };
    const settings = {seed:31, fraction:0.65, stratumColumn:'stratum'};
    const parts = createDatasetPartitions(table,1,settings);
    const conditions = [{column:'target',op:'gte' as const,value:2}];
    const sample = subsetTable(parts.development.table,buildRowMask(parts.development.table,conditions));
    const variables = ['other','target'];
    const result = runPCA(sample,variables,{k:1,standardize:true,missing:'complete',label:'demo'});
    const [json] = await buildAnalysisRecord([
      { at, action:'split',event:splitEvent(parts.split,settings,1,table.columns,[]) },
      { at, action:'pca',event:pcaEvent(result,variables,sample,sample.nRows,true,{},conditions,2) },
    ], {}, parts.development.samplePartition,true);
    const [split,fit,membership] = read(json.text);
    const replay = createDatasetPartitions(table,split.metadata.sourceDatasetId,{ seed:split.fields.seed, fraction:split.fields.fraction, stratumColumn:split.metadata.stratumColumn });
    expect(hash(JSON.stringify(replay.development.samplePartition.sourceRows))).toBe(membership.fields.membershipSha256);
    const input = subsetTable(replay.development.table,buildRowMask(replay.development.table,fit.metadata.filters));
    const rerun = runPCA(input,fit.metadata.variables,{k:fit.fields.retained,standardize:fit.fields.standardized,missing:fit.fields.missing,label:fit.metadata.label});
    expect(rerun.table.data[fit.metadata.derived[0]]).toEqual(result.table.data[result.columns[0]]);
  });
});

it('reports legacy requested K with unknown observed count and flags unidentified transfer sources', async () => {
  const entries = [event('cluster', { method: 'KMEANS', retained: 8, fitted: 6 }), event('transfer', {})];
  const [json] = await buildAnalysisRecord(entries.map(e => ({ at, action: '', event: e })), {});
  const [cluster, transfer] = read(json.text);
  expect(cluster.fields).toMatchObject({ requestedK: 8, fitted: 6 });
  expect(cluster.fields).not.toHaveProperty('retained');
  expect(cluster.missingFields).toContain('retained');
  expect(transfer.missingFields).toContain('sourceInputSha256');
});
