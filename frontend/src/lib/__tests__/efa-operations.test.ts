import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EfaController, type EfaContext } from '../efa/controller';
import { EfaService, type EfaJob } from '../efa/service';
import { conditionalCompletion, conditionalCompletionPrepared, type ConditionalCompletion } from '../efa/maximum-likelihood';
import { completionOperation } from '../efa/completion';
import { prepareEfa } from '../efa/prepare';
import { correlate } from '../efa/correlation';
import { fitEfa } from '../efa/fit';
import { validateEfaState } from '../efa/persistence';
import { ComputeTrace } from '../efa/telemetry';
import { validateMiceOptions, type MiceOptions } from '../efa/mice';
import { validateStability, type StabilityResult } from '../efa/stability';
import type { ImputationAnalysis } from '../efa/imputation-analysis';
import type { DataTable } from '../table';
import type { EfaRun, EfaSpec } from '../efa/types';
import { mulberry32 } from '../random';

// The actual fit and completion math run once; only asynchronous worker delivery
// and host publication/download effects are mocked below.
const random = mulberry32(47291);
const normal = () => Math.sqrt(-2 * Math.log(Math.max(1e-12, random()))) * Math.cos(2 * Math.PI * random());
const table: DataTable = { columns: ['A', 'B', 'C', 'D'], nRows: 70, data: { A: [], B: [], C: [], D: [] } };
for (let i = 0; i < table.nRows; i++) {
  const common = normal();
  table.columns.forEach((column, j) => table.data[column].push(j + 1 + common * (j + 2) + normal()));
}
table.data.A[9] = null; table.data.C[12] = null;
table.data.D[69] = 999123.456;
const rows = Array.from({ length: 60 }, (_, i) => i);
const spec: EfaSpec = { items: table.columns.map((column, j) => ({ column, categories: [], reverse: j === 0, measurement: 'continuous' })),
  nFactors: 1, rotation: 'promax', extraction: 'ml', correlation: 'pearson', missing: 'fiml', likelihood: { starts: 1 },
  label: 'operation fixture', seed: 17, sample: { partition: 'all', fixedRows: rows } };
const data = prepareEfa(table, spec, rows), result = fitEfa(data, correlate(data), spec);
result.provenance.inputSha256 = 'a'.repeat(64);
const run: EfaRun = { id: 'fit', revision: 1, createdAt: '2026-11-06', datasetRevision: 'fixture', spec, result,
  eligibleRows: rows, kind: 'fit', reviews: {}, reasons: '', revisedAfterHoldout: false, scoreColumns: [] };
const calculated = conditionalCompletion(table, spec, result);

function deferred<T>(id: string) {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  const job: EfaJob<T> = { id, trace: new ComputeTrace(id), status: 'running', progress: { stage: 'fixture', completed: 0, total: 1 },
    promise, cancel: () => { job.status = 'cancelled'; reject(new Error('cancelled')); } };
  return { job, resolve: (value: T) => { job.result = value; job.status = 'completed'; resolve(value); }, reject };
}
function setup(withAdapters = true) {
  let context: EfaContext = { datasetId: 1, table, eligibleRows: rows, state: { runs: [structuredClone(run)], splits: [] },
    privateMode: true, afterFullExploration: false, filterKey: 'fitting' };
  const service = new EfaService(), completion = deferred<ConditionalCompletion>('completion');
  const download = vi.fn(), publish = vi.fn((_id: number, _old: DataTable, next: DataTable, id: string, record: NonNullable<EfaRun['completions']>[number]) => {
    context = { ...context, table: next, state: { ...context.state, runs: context.state.runs.map(saved => saved.id === id ? { ...saved, completions: [record] } : saved) } };
  });
  vi.spyOn(service, 'complete').mockReturnValue(completion.job);
  const controller = new EfaController(service, () => ({ context: () => context,
    state: (_id, _old, update) => { context = { ...context, state: update(context.state) }; }, scores: vi.fn(),
    ...(withAdapters ? { complete: publish, download } : {}),
  }));
  return { controller, service, completion, download, publish, get: () => context,
    set: (patch: Partial<EfaContext>) => { context = { ...context, ...patch }; } };
}
beforeEach(() => vi.restoreAllMocks());

describe('saved EFA completion operations', () => {
  it('publishes completed copies locally and returns no respondent values through the private tool', async () => {
    const h = setup(), pending = h.controller.tool('complete_efa_values', { runId: run.id, destination: 'columns' });
    expect(h.publish).not.toHaveBeenCalled();
    h.completion.resolve(structuredClone(calculated));
    const response = await pending;
    expect(response).toContain('Added completed item columns');
    expect(response).not.toContain(String(calculated.values[0][9]));
    expect(h.publish).toHaveBeenCalledTimes(1);
    const after = h.get().table, record = h.get().state.runs[0].completions![0];
    expect(record.filledCells).toBe(2);
    expect(after.data.A).toBe(table.data.A);
    expect(after.data[record.columns.A][9]).toBe(calculated.values[0][9]);
    expect(after.data[record.columns.A][1]).toBe(table.data.A[1]);
    expect(after.data[record.columns.D][69]).toBe(table.data.D[69]);
    expect(record.rows).toEqual(rows);
  });
  it('downloads fitting-row-only CSV/operation JSON while private tool responses contain only status', async () => {
    for (const destination of ['csv', 'operation'] as const) {
      const h = setup(), pending = h.controller.tool('complete_efa_values', { runId: run.id, destination });
      h.completion.resolve(structuredClone(calculated));
      const response = await pending;
      expect(response).toContain('Downloaded');
      expect(response).not.toContain(String(calculated.values[0][9]));
      expect(h.download).toHaveBeenCalledTimes(1);
      const content = h.download.mock.calls[0][1] as string;
      expect(content).not.toContain('999123.456');
      if (destination === 'operation') {
        const op = JSON.parse(content);
        expect(op.rows).toEqual(rows);
        expect(op.input).toHaveLength(rows.length);
        expect(op.input[9][0]).toBeNull();
        expect(op.completed[9][0]).toBe(calculated.values[0][9]);
      } else {
        expect(content.split('\r\n')).toHaveLength(rows.length + 1);
        expect(content).toContain('source_row,A,B,C,D');
      }
      expect(h.publish).not.toHaveBeenCalled();
    }
  });
  it('blocks narrower filters and stale dataset/table/filter completions before publishing or downloading', async () => {
    const narrowed = setup(); narrowed.set({ eligibleRows: rows.slice(1) });
    await expect(narrowed.controller.complete(run.id, 'csv')).rejects.toThrow(/fitting population/);
    expect(narrowed.service.complete).not.toHaveBeenCalled();
    for (const destination of ['columns', 'csv', 'operation'] as const) for (const patch of [{ datasetId: 2 }, { table: { ...table } }, { filterKey: 'changed' }]) {
      const h = setup(), pending = h.controller.tool('complete_efa_values', { runId: run.id, destination });
      h.set(patch); h.completion.resolve(structuredClone(calculated));
      await expect(pending).resolves.toContain('EFA action failed (stale)');
      expect(h.publish).not.toHaveBeenCalled(); expect(h.download).not.toHaveBeenCalled();
    }
  });
  it('fails explicitly when the host cannot publish or download, and exports replay code without computing', async () => {
    for (const destination of ['columns', 'csv'] as const) {
      const h = setup(false), pending = h.controller.tool('complete_efa_values', { runId: run.id, destination });
      h.completion.resolve(structuredClone(calculated));
      await expect(pending).resolves.toContain(destination === 'columns' ? 'completion-publish' : 'download');
    }
    const h = setup();
    expect(await h.controller.tool('complete_efa_values', { runId: run.id, destination: 'code' })).toContain('Downloaded R code');
    expect(h.service.complete).not.toHaveBeenCalled();
    expect(h.download.mock.calls[0][1]).toContain('solve(Sigma[observed, observed');
  });
  it('retains numeric reverse offsets consistently in helper, worker and replay operations for mean/median ML fits', () => {
    for (const missing of ['mean', 'median'] as const) {
      const imputedSpec: EfaSpec = { ...spec, missing }, prepared = prepareEfa(table, imputedSpec, rows);
      const imputedResult = fitEfa(prepared, correlate(prepared), imputedSpec), imputedRun = { ...run, spec: imputedSpec, result: imputedResult };
      expect(imputedResult.numericReverseOffsets).toBeUndefined();
      const direct = conditionalCompletion(table, imputedSpec, imputedResult), worker = conditionalCompletionPrepared(prepared, imputedResult);
      const operation = completionOperation(table, imputedRun, direct);
      expect(operation.model.reverseOffsets).toEqual(imputedResult.imputation!.reverseOffsets);
      expect(worker.filled).toEqual(direct.filled);
      expect(worker.completedCells).toBe(2);
      direct.values.forEach((column, j) => column.forEach((value, i) => {
        expect(worker.values[j][i]).toBeCloseTo(value!, 12);
        if (!direct.filled[j][i]) expect(value).toBe(table.data[table.columns[j]][rows[i]]);
      }));
    }
  });
  it('accepts valid completion receipts and rejects wrong fingerprints, source collisions and duplicate receipts on restore', async () => {
    const h = setup(), pending = h.controller.complete(run.id, 'columns');
    h.completion.resolve(structuredClone(calculated)); await pending;
    const state = h.get().state;
    expect(() => validateEfaState(state, table.nRows)).not.toThrow();
    for (const mutate of [
      (saved: EfaRun) => { saved.completions![0].sourceFingerprint = 'b'.repeat(64); },
      (saved: EfaRun) => { saved.completions![0].columns.A = 'A'; },
      (saved: EfaRun) => { saved.completions!.push(structuredClone(saved.completions![0])); },
      (saved: EfaRun) => { saved.completions![0].rows = rows.slice(1); },
      (saved: EfaRun) => { saved.completions![0].filledCells = rows.length * table.columns.length + 1; },
    ]) {
      const invalid = structuredClone(state); mutate(invalid.runs[0]);
      expect(() => validateEfaState(invalid, table.nRows)).toThrow(/invalid EFA state/);
    }
  });
});

describe('assistant MICE and resampling job routes', () => {
  const miceOptions: MiceOptions = { imputations: 2, iterations: 2, seed: 41, predictors: [[1, 2, 3], [0, 2, 3], [0, 1, 3], [0, 1, 2]] };
  const stabilityOptions = { replicates: 2, seed: 42, confidence: .95, crossLoadingThreshold: .3 };
  it('routes explicit options to jobs, snapshots parameters, and exposes only job identifiers in private mode', async () => {
    const h = setup(), mice = deferred<ImputationAnalysis>('mice'), stability = deferred<StabilityResult>('stability');
    const impute = vi.spyOn(h.service, 'impute').mockImplementation((_table, candidate, _rows, options) => {
      validateMiceOptions(options, candidate.items.length); return mice.job;
    });
    const resample = vi.spyOn(h.service, 'stability').mockImplementation((_table, _run, options) => { validateStability(options); return stability.job; });
    vi.spyOn(h.service, 'getJob').mockImplementation(id => id === 'mice' ? mice.job : stability.job);
    const candidate = { ...spec, missing: 'complete' as const }, options = structuredClone(miceOptions);
    const started = JSON.parse(await h.controller.tool('impute_efa', { spec: candidate, options }));
    expect(started.jobId).toBe('mice'); expect(impute.mock.calls[0][4]).toBe(5);
    options.seed = 999; candidate.label = 'changed after dispatch';
    expect(impute.mock.calls[0][3].seed).toBe(41); expect(impute.mock.calls[0][1].label).toBe(spec.label);
    const stable = JSON.parse(await h.controller.tool('stability_efa', { runId: run.id, options: stabilityOptions }));
    expect(stable.jobId).toBe('stability');
    expect(resample.mock.calls[0][2]).toMatchObject(stabilityOptions);
    // Invalid options are rejected before a new job can be published.
    expect(await h.controller.tool('impute_efa', { spec: { ...spec, missing: 'complete' }, options: { ...miceOptions, imputations: 1 } })).toContain('mice-settings');
    expect(await h.controller.tool('stability_efa', { runId: run.id, options: { ...stabilityOptions, replicates: 1 } })).toContain('stability-settings');
    expect(h.get().state.imputationRuns).toBeUndefined(); expect(h.get().state.stabilityRuns).toBeUndefined();
  });
  it('does not publish MICE or resampling results after current context changes', async () => {
    const h = setup(), pending = deferred<StabilityResult>('stability');
    vi.spyOn(h.service, 'stability').mockReturnValue(pending.job);
    vi.spyOn(h.service, 'getJob').mockReturnValue(pending.job);
    await h.controller.tool('stability_efa', { runId: run.id, options: stabilityOptions });
    h.set({ filterKey: 'changed' });
    pending.resolve({ requested: 2, completed: 0 } as StabilityResult);
    expect(await h.controller.tool('efa_job', { jobId: 'stability' })).toContain('stale');
    expect(h.get().state.stabilityRuns).toBeUndefined();
    const m = setup(), imputation = deferred<ImputationAnalysis>('mice');
    vi.spyOn(m.service, 'impute').mockReturnValue(imputation.job);
    vi.spyOn(m.service, 'getJob').mockReturnValue(imputation.job);
    await m.controller.tool('impute_efa', { spec: { ...spec, missing: 'complete' }, options: miceOptions });
    m.set({ datasetId: 9 });
    imputation.resolve({ requested: 2, completed: 0 } as ImputationAnalysis);
    expect(await m.controller.tool('efa_job', { jobId: 'mice' })).toContain('stale');
    expect(m.get().state.imputationRuns).toBeUndefined();
  });
});
