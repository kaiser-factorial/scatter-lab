import { describe, expect, it, vi } from 'vitest';
import { createPcaBatchController, type PcaBatchScope } from '../pca-batch-controller';
import type { PcaImputationBatch, PcaImputationOptions } from '../pca-imputation';
import type { PCAResult } from '../pca';
import type { DataTable } from '../table';
const table = { columns: ['a', 'b'], nRows: 6, data: { a: [1, 2, null, 2, 1, 2], b: [1, null, 2, 2, 1, 2] } };
const fit = (imputation: number) => ({ imputation, result: { k: 1, label: `run_mi${imputation}`,
  varianceExplained: [.6 + imputation / 10], cumulative: [.6 + imputation / 10],
  table: { ...table, data: { ...table.data, privatePayload: ['ROW_VALUE_CANARY'] } },
} as unknown as PCAResult });
const batch: PcaImputationBatch = { variables: ['a', 'b'], requested: 2, completed: [fit(1), fit(2)], failures: [], trace: [],
  settings: { imputations: 2, iterations: 3, seed: 44, predictors: [[1], [0]] }, provenance: { method: 'test', execution: 'main-thread', scoring: 'separate' } };
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function harness() {
  let scope: PcaBatchScope = { datasetId: 3, source: table, table, filterKey: '[]', minimumPairN: 5 };
  let resolve!: (batch: PcaImputationBatch) => void;
  const run = vi.fn((_table: DataTable, _variables: string[], options: PcaImputationOptions = {}) => { void options; return new Promise<PcaImputationBatch>(done => { resolve = done; }); });
  const apply = vi.fn(() => 'Scores added.');
  const controller = createPcaBatchController({ capture: () => scope, apply, run });
  return { controller, run, apply, resolve: () => resolve(batch), scope: () => scope, setScope: (next: PcaBatchScope) => { scope = next; } };
}
describe('PCA imputation controller', () => {
  it('passes requested policy and exposes aggregate summaries until explicit selected-fit publication', async () => {
    const h = harness();
    const started = h.controller.start({ variables: ['a', 'b'], n_components: 1, imputations: 2, iterations: 3, seed: 44,
      measurements: { a: 'ordinal' }, predictors: { a: ['b'], b: ['a'] }, predictor_encoding: 'rank' });
    expect(started.status).toBe('running'); expect(h.apply).not.toHaveBeenCalled(); await flush();
    expect(h.run.mock.calls[0][2]).toMatchObject({ k: 1, imputations: 2, iterations: 3, seed: 44,
      measurements: { a: 'ordinal' }, predictors: [[1], [0]], predictorEncoding: 'rank', minimumPairN: 5 });
    h.resolve(); await flush();
    const completed = h.controller.inspect(started.jobId);
    expect(completed.status).toBe('completed'); expect(completed.fits).toHaveLength(2);
    expect(JSON.stringify(completed)).not.toContain('ROW_VALUE_CANARY'); expect(JSON.stringify(completed)).not.toContain('table');
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.controller.apply(started.jobId, 2)).toMatchObject({ status: 'applied', appliedImputation: 2, message: 'Scores added.' });
    expect(h.apply).toHaveBeenCalledWith(h.scope(), batch, batch.completed[1].result);
    expect(() => h.controller.apply(started.jobId, 1)).toThrow(/completed batch/);
  });
  it.each(['dataset', 'source', 'filter', 'floor'] as const)('rejects %s changes and cannot resurrect an obsolete completion', async kind => {
    const h = harness(), started = h.controller.start({ variables: ['a', 'b'] }); await flush();
    const next = { ...h.scope() };
    if (kind === 'dataset') next.datasetId = 4;
    if (kind === 'source') next.source = structuredClone(table);
    if (kind === 'filter') next.filterKey = '[changed]';
    if (kind === 'floor') next.minimumPairN = 6;
    h.setScope(next);
    expect(h.controller.inspect(started.jobId).status).toBe('stale'); expect(h.run.mock.calls[0][2]?.signal?.aborted).toBe(true);
    h.resolve(); await flush(); expect(h.controller.inspect(started.jobId).status).toBe('stale');
    expect(() => h.controller.apply(started.jobId, 1)).toThrow(/current dataset/); expect(h.apply).not.toHaveBeenCalled();
  });
  it('cancels without publishing late results and validates predictor references', async () => {
    const h = harness();
    expect(() => h.controller.start({ variables: ['a', 'b'], predictors: { a: ['a'] } })).toThrow(/other than their target/);
    const started = h.controller.start({ variables: ['a', 'b'] }); await flush();
    expect(h.controller.cancel(started.jobId).status).toBe('cancelled'); h.resolve(); await flush();
    expect(h.controller.inspect(started.jobId).fits).toEqual([]); expect(h.apply).not.toHaveBeenCalled();
  });
  it('does not allow a request to lower the application support floor', async () => {
    const h = harness(); const started = h.controller.start({ variables: ['a', 'b'], minimumPairN: 0 } as never); await flush();
    expect(started.settings).not.toHaveProperty('minimumPairN');
    expect(h.run.mock.calls[0][2]?.minimumPairN).toBe(5);
    h.controller.dispose(); expect(h.run.mock.calls[0][2]?.signal?.aborted).toBe(true);
    expect(() => h.controller.start({ variables: ['a', 'b'] })).toThrow(/disposed/);
  });
});
