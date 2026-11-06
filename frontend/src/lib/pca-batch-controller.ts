import type { DataTable } from './table';
import type { PCAResult } from './pca';
import type { MeasurementChoice } from './measurement';
import { runPcaImputations, type PcaImputationBatch, type PcaImputationOptions } from './pca-imputation';

export type PcaBatchScope = {
  datasetId: string | number;
  /** Already filtered fitting table. */
  table: DataTable;
  /** Identity of the full active dataset, including immutable replacement on edits. */
  source: DataTable;
  filterKey: string;
  /** Application-owned original-pair support floor, never a tool argument. */
  minimumPairN: number;
};
export type PcaBatchRequest = {
  variables: string[];
  n_components?: number;
  standardize?: boolean;
  label?: string;
  measurements?: Record<string, MeasurementChoice>;
  imputations?: number;
  iterations?: number;
  seed?: number;
  predictors?: Record<string, string[]>;
  predictor_encoding?: 'ordered-polynomial' | 'rank';
};
export type PcaBatchStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'stale' | 'applied';
export type PcaBatchSummary = {
  jobId: string;
  status: PcaBatchStatus;
  variables: string[];
  requested: number;
  progress?: { stage: string; completed: number; total: number };
  settings: Omit<PcaBatchRequest, 'variables'>;
  fits: { imputation: number; components: number; label: string; varianceExplained: number[]; cumulative: number[] }[];
  failures: { imputation: number; stage: string; error: string }[];
  error?: string;
  appliedImputation?: number;
};
type Job = {
  summary: PcaBatchSummary;
  scope: PcaBatchScope;
  abort: AbortController;
  batch?: PcaImputationBatch;
};
export type PcaBatchDependencies = {
  capture: () => PcaBatchScope;
  apply: (scope: PcaBatchScope, batch: PcaImputationBatch, result: PCAResult) => string;
  onChange?: (summary: PcaBatchSummary) => void;
  /** Dependency injection for worker tests; production uses the actual worker dispatcher. */
  run?: typeof runPcaImputations;
};

/** Async PCA/MICE tools expose aggregate fit summaries; original rows and scores stay local. */
export function createPcaBatchController(deps: PcaBatchDependencies) {
  const jobs = new Map<string, Job>();
  let sequence = 0, disposed = false;
  const publicSummary = (job: Job): PcaBatchSummary => structuredClone(job.summary);
  const emit = (job: Job) => { if (!disposed) deps.onChange?.(publicSummary(job)); };
  const matches = (scope: PcaBatchScope) => {
    try {
      const current = deps.capture();
      return current.datasetId === scope.datasetId && current.source === scope.source && current.filterKey === scope.filterKey
        && current.minimumPairN === scope.minimumPairN;
    } catch { return false; }
  };
  const requireJob = (id: string) => {
    const job = jobs.get(id);
    if (!job) throw new Error(`Unknown PCA imputation job: ${id}.`);
    return job;
  };
  const fresh = (job: Job) => {
    if (['running', 'completed'].includes(job.summary.status) && !matches(job.scope)) {
      job.abort.abort(); job.batch = undefined;
      job.summary.status = 'stale'; job.summary.error = 'The active dataset or fitting filter changed. Start a new PCA imputation batch.';
      emit(job);
    }
    return job.summary.status !== 'stale';
  };
  const start = (input: PcaBatchRequest): PcaBatchSummary => {
    if (disposed) throw new Error('This PCA imputation controller was disposed.');
    if (!input || !Array.isArray(input.variables) || input.variables.length < 2 || new Set(input.variables).size !== input.variables.length
      || input.variables.some(column => typeof column !== 'string')) throw new Error('Select at least two unique numeric variables for PCA imputation.');
    const scope = deps.capture();
    if (!Number.isSafeInteger(scope.minimumPairN) || scope.minimumPairN < 0) throw new Error('The application must supply an observed-pair support floor.');
    if (input.variables.some(column => !scope.table.columns.includes(column))) throw new Error('PCA imputation variables must belong to the current fitting table.');
    if (input.n_components !== undefined && (!Number.isInteger(input.n_components) || input.n_components < 1 || input.n_components > Math.min(10, input.variables.length)))
      throw new Error('PCA component count must be between one and the selected item count (at most ten).');
    if (input.standardize !== undefined && typeof input.standardize !== 'boolean') throw new Error('Standardize must be boolean.');
    if (input.measurements && (Object.keys(input.measurements).some(column => !input.variables.includes(column))
      || Object.values(input.measurements).some(value => !['auto', 'ordinal', 'continuous'].includes(value))))
      throw new Error('Measurement overrides must name selected items and use auto, ordinal or continuous.');
    let predictors: number[][] | undefined;
    if (input.predictors) {
      if (Object.keys(input.predictors).some(column => !input.variables.includes(column))) throw new Error('Predictor targets must be selected items.');
      predictors = input.variables.map((target, j) => {
        const names = input.predictors?.[target] ?? input.variables.filter((_, i) => i !== j);
        if (!Array.isArray(names) || new Set(names).size !== names.length || names.some(name => name === target || !input.variables.includes(name)))
          throw new Error('Predictors must be distinct selected items other than their target.');
        return names.map(name => input.variables.indexOf(name));
      });
    }
    for (const job of jobs.values()) fresh(job);
    if ([...jobs.values()].filter(job => job.summary.status === 'running').length >= 2) throw new Error('Two PCA imputation jobs are already running. Inspect or cancel one before starting another.');
    for (const [id, job] of jobs) if (jobs.size >= 8 && job.summary.status !== 'running') jobs.delete(id);
    const request: PcaBatchRequest = structuredClone({ variables: input.variables, n_components: input.n_components,
      standardize: input.standardize, label: input.label, measurements: input.measurements, imputations: input.imputations,
      iterations: input.iterations, seed: input.seed, predictors: input.predictors, predictor_encoding: input.predictor_encoding });
    const jobId = `pca-mi-${Date.now().toString(36)}-${++sequence}`;
    const { variables, ...settings } = request;
    const job: Job = { scope, abort: new AbortController(), summary: { jobId, status: 'running', variables,
      requested: input.imputations ?? 20, settings: { ...settings, imputations: input.imputations ?? 20,
        iterations: input.iterations ?? 10, seed: input.seed ?? 73021, standardize: input.standardize ?? true,
        predictor_encoding: input.predictor_encoding ?? 'ordered-polynomial' }, fits: [], failures: [] } };
    jobs.set(jobId, job); emit(job);
    const options: PcaImputationOptions = { k: input.n_components, standardize: input.standardize, label: input.label,
      measurements: request.measurements, imputations: request.imputations, iterations: request.iterations, seed: request.seed,
      predictors, predictorEncoding: input.predictor_encoding, minimumPairN: scope.minimumPairN, signal: job.abort.signal,
      onProgress: progress => { if (job.summary.status === 'running' && fresh(job)) { job.summary.progress = { ...progress }; emit(job); } } };
    void Promise.resolve().then(() => (deps.run ?? runPcaImputations)(scope.table, variables, options)).then(batch => {
      if (job.summary.status !== 'running' || !fresh(job)) return;
      job.batch = batch; job.summary.status = 'completed';
      job.summary.fits = batch.completed.map(fit => ({ imputation: fit.imputation, components: fit.result.k,
        label: fit.result.label, varianceExplained: fit.result.varianceExplained.slice(), cumulative: fit.result.cumulative.slice() }));
      job.summary.failures = batch.failures.map(failure => ({ ...failure }));
      emit(job);
    }).catch(error => {
      if (job.summary.status !== 'running') return;
      job.summary.status = job.abort.signal.aborted ? 'cancelled' : 'failed';
      job.summary.error = error instanceof Error ? error.message : String(error); emit(job);
    });
    return publicSummary(job);
  };
  const inspect = (jobId: string) => { const job = requireJob(jobId); fresh(job); return publicSummary(job); };
  const cancel = (jobId: string) => {
    const job = requireJob(jobId);
    if (job.summary.status === 'running') { job.abort.abort(); job.summary.status = 'cancelled'; job.batch = undefined; emit(job); }
    return publicSummary(job);
  };
  const apply = (jobId: string, imputation: number) => {
    const job = requireJob(jobId);
    if (!fresh(job) || job.summary.status !== 'completed' || !job.batch) throw new Error('Only a completed batch matching the current dataset and filter can add scores.');
    const fit = job.batch.completed.find(fit => fit.imputation === imputation);
    if (!fit) throw new Error('Select the one-based imputation number of a completed fit.');
    const message = deps.apply(job.scope, job.batch, fit.result);
    job.summary.status = 'applied'; job.summary.appliedImputation = imputation; emit(job);
    return { ...publicSummary(job), message };
  };
  const dispose = () => { disposed = true; for (const job of jobs.values()) if (job.summary.status === 'running') { job.summary.status = 'cancelled'; job.abort.abort(); } jobs.clear(); };
  return { start, inspect, cancel, apply, dispose };
}
