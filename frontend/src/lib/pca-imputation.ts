import type { DataTable } from './table';
import type { PCAOptions, PCAResult } from './pca';
import { validateMiceOptions, type MiceTrace } from './efa/mice';
import type { Progress } from './efa/types';
import { preparePcaMice, runPcaMiceChain, type PcaMiceSettings, type PcaMiceChain, type PcaMiceFailure } from './pca-imputation-core';

export type PcaImputationOptions = {
  k?: number;
  standardize?: boolean;
  label?: string;
  measurements?: PCAOptions['measurements'];
  imputations?: number;
  iterations?: number;
  seed?: number;
  predictors?: number[][];
  predictorEncoding?: 'ordered-polynomial' | 'rank';
  /** Original observed-pair floor, checked before any cells are imputed. */
  minimumPairN?: number;
  signal?: AbortSignal;
  onProgress?: Progress;
};
export type PcaImputationBatch = {
  variables: string[];
  requested: number;
  completed: { imputation: number; result: PCAResult }[];
  failures: PcaMiceFailure[];
  trace: MiceTrace[];
  settings: PcaMiceSettings;
  provenance: { method: string; execution: 'web-worker' | 'main-thread'; scoring: string };
};

/** Independent ordinal MICE chains, each with its own PCA. No pooling or score averaging. */
export async function runPcaImputations(table: DataTable, variables: string[], options: PcaImputationOptions = {}): Promise<PcaImputationBatch> {
  const settings: PcaMiceSettings = { k: options.k, standardize: options.standardize ?? true, label: options.label ?? '',
    measurements: { ...options.measurements },
    imputations: options.imputations ?? 20, iterations: options.iterations ?? 10, seed: options.seed ?? 73021,
    predictorEncoding: options.predictorEncoding ?? 'ordered-polynomial',
    predictors: options.predictors ? options.predictors.map(row => row.slice()) : variables.map((_, j) => variables.flatMap((_, i) => i === j ? [] : [i])) };
  validateMiceOptions(settings, variables.length);
  const abort = () => {
    if (options.signal?.aborted) { const error = new Error('PCA imputation cancelled.'); error.name = 'AbortError'; throw error; }
  };
  abort();
  const source = preparePcaMice(table, variables, settings.measurements);
  const minimumPairN = options.minimumPairN ?? 0;
  if (!Number.isSafeInteger(minimumPairN) || minimumPairN < 0) throw new Error('Use a nonnegative observed-pair support floor.');
  for (let j = 0; minimumPairN && j < variables.length; j++) for (let k = j; k < variables.length; k++) {
    let count = 0;
    for (let row = 0; row < source.nRows; row++) if (source.observed[j * source.nRows + row] && source.observed[k * source.nRows + row]) count++;
    if (count < minimumPairN) throw new Error('The selected items have observed pair support below the aggregate floor. Imputed responses do not add observed support.');
  }
  if (source.observed.every(value => value === 1)) throw new Error('The selected items have no missing responses. Run PCA directly.');
  const worker = typeof Worker !== 'undefined'
    ? new Worker(new URL('./pca-imputation.worker.ts', import.meta.url), { type: 'module' }) : undefined;
  const result: PcaImputationBatch = { variables: variables.slice(), requested: settings.imputations,
    completed: [], failures: [], trace: [], settings,
    provenance: { method: `Separate ordinal polr / binary logreg imputations, ${settings.iterations} sweeps per chain, followed by independently fitted PCA; no pooled uncertainty or averaged scores`,
      execution: worker ? 'web-worker' : 'main-thread',
      scoring: 'Each completed PCA fit has its own axes and score columns; select one fit explicitly before adding its scores. Source input cells are preserved.' } };
  let rejectPending: ((error: Error) => void) | undefined;
  const abortWorker = () => {
    worker?.terminate();
    const error = new Error('PCA imputation cancelled.'); error.name = 'AbortError'; rejectPending?.(error);
  };
  const request = (message: unknown): Promise<PcaMiceChain | undefined> => new Promise((resolve, reject) => {
    rejectPending = reject;
    worker!.onerror = event => reject(new Error(event.message || 'PCA imputation worker failed.'));
    worker!.onmessage = event => {
      if (event.data.kind === 'progress') { options.onProgress?.(event.data.progress); return; }
      rejectPending = undefined;
      if (event.data.kind === 'error') reject(new Error(event.data.error));
      else resolve(event.data.result);
    };
    worker!.postMessage(message);
  });
  options.signal?.addEventListener('abort', abortWorker, { once: true });
  try {
    abort();
    if (worker) await request({ op: 'initialize', context: { table, source, settings } });
    for (let index = 0; index < settings.imputations; index++) {
      abort();
      // The non-worker fallback also yields between independent chains.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      abort();
      const chain = worker ? (await request({ op: 'chain', index }))!
        : runPcaMiceChain(table, source, settings, index, options.onProgress);
      abort();
      result.trace.push(...chain.trace);
      if (chain.failure) result.failures.push(chain.failure);
      if (chain.result) {
        if (worker) chain.result.table = { columns: [...table.columns.filter(c => !chain.result!.replaced.includes(c)), ...chain.result.columns], nRows: table.nRows,
          data: { ...Object.fromEntries(Object.entries(table.data).filter(([c]) => !chain.result!.replaced.includes(c))), ...chain.result.table.data } };
        result.completed.push({ imputation: chain.imputation, result: chain.result });
      }
      options.onProgress?.({ stage: 'MICE + PCA', completed: index + 1, total: settings.imputations });
    }
    return result;
  } finally {
    options.signal?.removeEventListener('abort', abortWorker);
    worker?.terminate();
  }
}
