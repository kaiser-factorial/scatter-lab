import { beforeEach, expect, it, vi } from 'vitest';
import { EfaController, type EfaContext } from '../efa/controller';
import { EfaService, type EfaJob } from '../efa/service';
import { EfaError, type EfaResult, type EfaSpec } from '../efa/types';
import { ComputeTrace } from '../efa/telemetry';
import type { ConvergenceIssue } from '../convergence';
import type { DataTable } from '../table';

const columns = ['a', 'b', 'c', 'd'];
const table: DataTable = { columns, nRows: 20, data: Object.fromEntries(columns.map((column, j) => [column, Array.from({ length: 20 }, (_, i) => i + j / 10)])) };
const rows = Array.from({ length: 20 }, (_, i) => i);
const spec: EfaSpec = { items: columns.map((column, j) => ({ column, categories: [], reverse: j === 1, measurement: 'continuous' })),
  extraction: 'ml', correlation: 'pearson', missing: 'fiml', nFactors: 1, rotation: 'promax', seed: 41, label: 'retry fixture',
  likelihood: { maxIterations: 10, tolerance: 1e-10, starts: 2, uniquenessFloor: 1e-5 }, sample: { partition: 'all', fixedRows: rows.slice(0, 12) } };
const issue: ConvergenceIssue = { method: 'fiml', reason: 'iteration-limit', settings: { maxIterations: 10, tolerance: 1e-10, starts: 2, uniquenessFloor: 1e-5 },
  iterations: 10, objective: 4.7, gradient: .002, bestStart: 1, partialAvailable: false,
  starts: [1, 2].map(start => ({ start, iterations: 10, objective: 4.7, gradient: .002, reason: 'iteration-limit' })) };
const changed = { maxIterations: 1000, tolerance: 1e-8, starts: 4, uniquenessFloor: 1e-6 };

function setup(privateMode = true) {
  let context: EfaContext = { datasetId: 1, table, eligibleRows: rows, state: { runs: [], splits: [] }, privateMode,
    afterFullExploration: false, filterKey: 'original-filter' };
  const service = new EfaService(), jobs: { job: EfaJob<EfaResult>; reject: (error: Error) => void }[] = [];
  const fit = vi.spyOn(service, 'fit').mockImplementation(() => {
    const id = `job-${jobs.length + 1}`;
    let reject!: (error: Error) => void;
    const promise = new Promise<EfaResult>((_resolve, no) => { reject = no; });
    const job: EfaJob<EfaResult> = { id, trace: new ComputeTrace(id), status: 'running', progress: { stage: 'fixture', completed: 0, total: 10 }, promise,
      cancel: () => { if (job.status === 'running') { job.status = 'cancelled'; reject(new EfaError('cancelled', 'Analysis cancelled.')); } } };
    jobs.push({ job, reject }); return job;
  });
  vi.spyOn(service, 'getJob').mockImplementation(id => jobs.find(entry => entry.job.id === id)?.job);
  vi.spyOn(service, 'cancelAll').mockImplementation(() => jobs.forEach(entry => entry.job.cancel()));
  const publish = vi.fn((_id: number, _table: DataTable, update: (state: EfaContext['state']) => EfaContext['state']) => { context = { ...context, state: update(context.state) }; });
  const controller = new EfaController(service, () => ({ context: () => context, state: publish, scores: vi.fn() }));
  const fail = async (index = jobs.length - 1, structured = true) => {
    const entry = jobs[index]; entry.job.status = 'failed'; entry.job.error = 'Private local failure text';
    if (structured) entry.job.convergenceIssue = structuredClone(issue);
    entry.reject(new EfaError(structured ? 'ml-nonconvergence' : 'worker', entry.job.error, [], entry.job.convergenceIssue));
    await Promise.resolve(); await Promise.resolve();
  };
  return { service, controller, fit, jobs, publish, fail, get: () => context,
    set: (patch: Partial<EfaContext>) => { context = { ...context, ...patch }; } };
}
beforeEach(() => vi.restoreAllMocks());

it('exposes only a current failed numerical attempt, without publishing an unconverged fit', async () => {
  const h = setup(), started = h.controller.start(spec);
  expect(h.controller.convergenceRetry(started.job.id)).toBeUndefined();
  await h.fail(); await expect(started.completion).rejects.toMatchObject({ code: 'ml-nonconvergence' });
  expect(h.controller.convergenceRetry(started.job.id)).toMatchObject({ issue, spec, assistantSafe: false });
  expect(h.publish).not.toHaveBeenCalled(); expect(h.get().state.runs).toEqual([]);
  const generic = h.controller.start(spec); await h.fail(1, false);
  expect(h.controller.convergenceRetry(generic.job.id)).toBeUndefined();
  expect(() => h.controller.retryNonconverged(generic.job.id, changed)).toThrow(/no longer current/);
});

it('retries the captured specification and fitting rows with only explicit optimizer settings changed', async () => {
  const h = setup(), candidate = structuredClone(spec), options = { reasons: 'original rationale', reviews: { a: { status: 'retain' as const, note: 'original note' } } };
  const initial = h.controller.start(candidate, options);
  candidate.label = 'edited later'; candidate.items[1].reverse = false; candidate.sample.fixedRows = rows.slice(2);
  options.reasons = 'edited later'; options.reviews.a.note = 'edited later';
  await h.fail();
  const exposed = h.controller.convergenceRetry(initial.job.id)!;
  exposed.spec.label = 'edited inspection copy';
  const retry = h.controller.retryNonconverged(initial.job.id, changed);
  expect(retry.job.id).not.toBe(initial.job.id);
  expect(h.fit.mock.calls[1][0]).toBe(table);
  expect(h.fit.mock.calls[1][1]).toEqual({ ...spec, likelihood: changed });
  expect(h.fit.mock.calls[1][2]).toEqual(rows.slice(0, 12));
  expect(h.fit.mock.calls[1][4]).toBe(0);
  expect(h.controller.convergenceRetry(initial.job.id)).toBeUndefined();
  expect(h.publish).not.toHaveBeenCalled();
});

it('keeps saved starts/floor when a retry changes only its budget and tolerance, and rejects invalid settings', async () => {
  const h = setup(), initial = h.controller.start(spec); await h.fail();
  expect(() => h.controller.retryNonconverged(initial.job.id, { maxIterations: 1000, tolerance: 0 })).toThrow(/tolerance/);
  expect(h.fit).toHaveBeenCalledTimes(1);
  h.controller.retryNonconverged(initial.job.id, { maxIterations: 1000, tolerance: 1e-8 });
  expect(h.fit.mock.calls[1][1].likelihood).toEqual({ maxIterations: 1000, tolerance: 1e-8, starts: 2, uniquenessFloor: 1e-5 });
});

it('rejects retries after dataset, table, filter, or resolved fitting-row membership changes', async () => {
  for (const patch of [{ datasetId: 2 }, { table: { ...table } }, { filterKey: 'changed-filter' }, { eligibleRows: rows.slice(1) }]) {
    const h = setup(), initial = h.controller.start(spec); await h.fail(); h.set(patch);
    expect(h.controller.convergenceRetry(initial.job.id)).toBeUndefined();
    expect(() => h.controller.retryNonconverged(initial.job.id, changed)).toThrow(/no longer current/);
    expect(h.fit).toHaveBeenCalledTimes(1); expect(h.publish).not.toHaveBeenCalled();
  }
  const h = setup();
  const split = { id: 'split', label: 'split', seed: 1, fraction: .6, development: rows.slice(0, 12), holdout: rows.slice(12), eligible: rows,
    createdAt: '2026-11-06', afterFullExploration: false };
  h.set({ state: { runs: [], splits: [split] } });
  const initial = h.controller.start({ ...spec, sample: { partition: 'development', splitId: 'split' } }); await h.fail();
  h.set({ state: { runs: [], splits: [{ ...split, development: rows.slice(1, 13), holdout: [0, ...rows.slice(13)] }] } });
  expect(h.controller.convergenceRetry(initial.job.id)).toBeUndefined();
  expect(() => h.controller.retryNonconverged(initial.job.id, changed)).toThrow(/no longer current/);
});

it('invalidates the previous retry when a newer fit starts or the controller is cancelled', async () => {
  const h = setup(), first = h.controller.start(spec); await h.fail();
  const second = h.controller.start({ ...spec, label: 'newer' });
  expect(h.controller.convergenceRetry(first.job.id)).toBeUndefined();
  expect(() => h.controller.retryNonconverged(first.job.id, changed)).toThrow(/no longer current/);
  await h.fail(); expect(h.controller.convergenceRetry(second.job.id)).toBeDefined();
  h.controller.cancel();
  expect(h.controller.convergenceRetry(second.job.id)).toBeUndefined();
  expect(() => h.controller.retryNonconverged(second.job.id, changed)).toThrow(/no longer current/);
});

it('withholds private UI-started failure metrics while exposing a private assistant attempt that passed its floor', async () => {
  const ui = setup(), local = ui.controller.start(spec); await ui.fail();
  expect(ui.controller.convergenceRetry(local.job.id)?.issue).toEqual(issue);
  const hidden = JSON.parse(await ui.controller.tool('efa_job', { jobId: local.job.id }));
  expect(hidden.status).toBe('failed'); expect(hidden.convergence).toBeUndefined(); expect(hidden.error).toBeUndefined();
  const assistant = setup(), started = JSON.parse(await assistant.controller.tool('run_efa', { spec }));
  expect(assistant.fit.mock.calls[0][4]).toBe(5);
  await assistant.fail();
  const visible = JSON.parse(await assistant.controller.tool('efa_job', { jobId: started.jobId }));
  expect(visible.convergence).toEqual(issue); expect(visible.nextAction).toContain('retry_efa');
  expect(visible.error).toBeUndefined(); expect(visible).not.toHaveProperty('rows'); expect(visible).not.toHaveProperty('spec');
});

it('does not expose an open-mode attempt after switching into private mode without a prior private floor check', async () => {
  const h = setup(false), started = JSON.parse(await h.controller.tool('run_efa', { spec }));
  expect(h.fit.mock.calls[0][4]).toBe(0); await h.fail();
  expect(JSON.parse(await h.controller.tool('efa_job', { jobId: started.jobId })).convergence).toEqual(issue);
  h.set({ privateMode: true });
  expect(h.controller.convergenceRetry(started.jobId)?.assistantSafe).toBe(false);
  expect(JSON.parse(await h.controller.tool('efa_job', { jobId: started.jobId })).convergence).toBeUndefined();
});

it('routes tool retries through the assistant floor even if the original fit was started locally', async () => {
  for (const fixedRows of [rows.slice(0, 4), rows.slice(0, 18)]) {
    const h = setup(), initial = h.controller.start({ ...spec, sample: { partition: 'all', fixedRows } }); await h.fail();
    expect(await h.controller.tool('retry_efa', { jobId: initial.job.id, settings: changed })).toContain('privacy');
    expect(h.fit).toHaveBeenCalledTimes(1); expect(h.publish).not.toHaveBeenCalled();
  }
  const h = setup(), initial = h.controller.start(spec); await h.fail();
  const retried = JSON.parse(await h.controller.tool('retry_efa', { jobId: initial.job.id, settings: changed }));
  expect(retried.jobId).toBe('job-2'); expect(retried.status).toBe('running');
  expect(h.fit.mock.calls[1][4]).toBe(5);
  expect(h.fit.mock.calls[1][2]).toEqual(h.fit.mock.calls[0][2]);
  expect(h.fit.mock.calls[1][1]).toEqual({ ...spec, likelihood: changed });
});
