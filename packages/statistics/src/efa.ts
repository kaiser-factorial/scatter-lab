import { materializeSelection, materializeTable, type Cell, type InputTable } from './data';
import { prepareEfa, validateSpec } from './internal/efa/prepare';
import { correlate } from './internal/efa/correlation';
import { fitEfa as fitKernel } from './internal/efa/fit';
import { createConditionalProjector } from './internal/efa/maximum-likelihood';
import { parallelAnalysis as parallelKernel } from './internal/efa/parallel';
import { rotate as rotateKernel } from './internal/efa/rotation';
import { bootstrapStability as bootstrapKernel, type StabilityResult } from './internal/efa/stability';
import { EfaError, EFA_ENGINE, type EfaResult, type EfaSpec } from './internal/efa/types';

export { EfaError };
export type EfaExtraction = 'minres' | 'dwls' | 'wlsmv' | 'ml';
export type EfaRotation = 'promax' | 'oblimin' | 'varimax';
export type EfaMissing = 'complete' | 'pairwise' | 'mean' | 'median' | 'fiml';
export interface EfaItem {
  column: string;
  categories?: readonly (number | string)[];
  reverse?: boolean;
  measurement?: 'auto' | 'ordinal' | 'continuous';
}
export interface EfaLikelihoodOptions { maxIterations?: number; tolerance?: number; starts?: number; uniquenessFloor?: number }
export interface EfaOptions {
  items: readonly EfaItem[];
  factors: number;
  rows?: readonly number[];
  correlation?: 'auto' | 'pearson' | 'polychoric';
  extraction?: EfaExtraction;
  rotation?: EfaRotation;
  missing?: EfaMissing;
  seed?: number;
  likelihood?: EfaLikelihoodOptions;
}
/** Structural subset accepted from a standard AbortSignal, without requiring DOM ambient types. */
export interface EfaCancellationSignal { readonly aborted: boolean }
export interface EfaExecutionOptions {
  signal?: EfaCancellationSignal;
  onProgress?: (progress: { stage: string; completed: number; total: number }) => void;
}
export interface EfaConvergence { converged: boolean; iterations: number; objective: number; gradient: number; maxIterations?: number }
export interface EfaLikelihoodModel {
  kind: 'ml' | 'fiml'; means: number[]; covariance: number[][]; residualVariances: number[];
  logLikelihood: number; nRows: number; parameters: number; df: number; aic: number; bic: number;
  settings: Required<EfaLikelihoodOptions>;
}
/** Portable fitted values, never a workbench run, dataset record, or worker handle. */
export interface EfaModel {
  format: 'scatterlab-efa-model/1';
  engine: string;
  status: 'converged' | 'unconverged';
  configuration: {
    items: { column: string; categories: (number | string)[]; reverse: boolean; measurement: 'auto' | 'ordinal' | 'continuous' }[];
    factors: number; correlation: 'pearson' | 'polychoric'; extraction: EfaExtraction;
    rotation: EfaRotation; missing: EfaMissing; seed: number;
  };
  preprocessing: { means: number[]; scales: number[]; reverseOffsets: (number | null)[]; replacements: number[] | null };
  parameters: { pattern: number[][]; phi: number[][]; structure: number[][]; weights: number[][]; likelihood?: EfaLikelihoodModel };
  convergence: { extraction: EfaConvergence; rotation: EfaConvergence };
  training: { rows: number[]; fittingRows: number[]; sourceRowCount: number; inputFingerprint: string };
}
export interface EfaScores { rows: number[]; scores: (number | null)[][]; unscoredRows: number[] }
export interface EfaScoringOptions { rows?: readonly number[]; allowUnconverged?: boolean }
export interface EfaFit {
  model: EfaModel;
  scores: EfaScores;
  correlation: number[][];
  communalities: number[];
  uniquenesses: number[];
  reproduced: number[][];
  residuals: number[][];
  rmsr: number;
  diagnostics: { code: string; message: string; items?: string[]; count?: number }[];
  /** Statistical outputs only; no execution plans or workbench identifiers. */
  weighted?: {
    estimator: 'dwls' | 'wlsmv'; rawStatistic: number; df: number;
    samplingVariances: number[]; fittingWeights: number[]; uncertaintyMethod: string;
    robust?: { test: NonNullable<NonNullable<EfaResult['weighted']>['robust']>['test']; standardErrors: NonNullable<NonNullable<EfaResult['weighted']>['robust']>['standardErrors'] };
  };
}
export interface EfaCompletion {
  columns: string[]; rows: number[]; values: (number | null)[][]; filled: boolean[][];
  completedCells: number; uninformativeRows: number[]; method: 'conditional-gaussian-mean';
}

function fail(message: string): never { throw new EfaError('public-model', message); }
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function vector(value: unknown, size: number, positive = false): value is number[] {
  return Array.isArray(value) && value.length === size && value.every(x => finite(x) && (!positive || x > 0));
}
function matrix(value: unknown, rows: number, columns: number): value is number[][] {
  return Array.isArray(value) && value.length === rows && value.every(row => vector(row, columns));
}
function resolvedSpec(options: EfaOptions): EfaSpec {
  if (!object(options as unknown) || Object.keys(options).some(key => !['items', 'factors', 'rows', 'correlation', 'extraction', 'rotation', 'missing', 'seed', 'likelihood'].includes(key)) || !Array.isArray(options.items))
    throw new EfaError('options', 'EFA accepts items, factors, explicit rows, correlation, extraction, rotation, missing, seed, and likelihood settings.');
  if (options.likelihood !== undefined && !object(options.likelihood)) throw new EfaError('likelihood-settings', 'Likelihood settings must be an object.');
  const items = options.items.map(item => {
    if (!object(item) || Object.keys(item).some(key => !['column', 'categories', 'reverse', 'measurement'].includes(key)) ||
        typeof item.column !== 'string' || !item.column.length || item.categories !== undefined && !Array.isArray(item.categories) ||
        item.reverse !== undefined && typeof item.reverse !== 'boolean' ||
        item.measurement !== undefined && !['auto', 'ordinal', 'continuous'].includes(String(item.measurement)))
      throw new EfaError('items', 'Each EFA item needs a column and optional categories, reverse flag, and measurement type.');
    const categories = [...(item.categories ?? [])];
    if (new Set(categories).size !== categories.length || categories.some(value => typeof value !== 'string' && !finite(value) || value === ''))
      throw new EfaError('category-order', 'Category orders contain distinct finite numbers or nonempty strings.');
    return { column: item.column, categories, reverse: item.reverse ?? false, measurement: (item.measurement ?? 'auto') as 'auto' | 'ordinal' | 'continuous' };
  });
  const spec: EfaSpec = { items, nFactors: options.factors, correlation: options.correlation ?? 'auto', extraction: options.extraction ?? 'minres',
    rotation: options.rotation ?? 'promax', missing: options.missing ?? 'pairwise', seed: options.seed ?? 61001,
    ...(options.likelihood === undefined ? {} : { likelihood: { ...options.likelihood } }), label: 'library', sample: { partition: 'all' }, compute: { backend: 'cpu' } };
  validateSpec(spec);
  return spec;
}
async function fingerprint(input: InputTable, columns: string[], rows: number[]): Promise<string> {
  const selected = materializeSelection(input, { columns, rows });
  const bytes = new TextEncoder().encode(JSON.stringify({ columns, rows, sourceRowCount: selected.sourceRowCount, values: columns.map(column => selected.table.data[column]) }));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
}
function checkAbort(signal?: EfaCancellationSignal) { if (signal?.aborted) throw new EfaError('cancelled', 'Analysis cancelled.'); }

/** CPU fit. Progress callbacks are synchronous; use a host worker for event-loop-responsive cancellation. */
export async function fitEfa(input: InputTable, options: EfaOptions, execution: EfaExecutionOptions = {}): Promise<EfaFit> {
  checkAbort(execution.signal);
  const spec = resolvedSpec(options), selected = materializeSelection(input, { columns: spec.items.map(item => item.column), rows: options.rows });
  const data = prepareEfa(selected.table, spec, Array.from({ length: selected.table.nRows }, (_, i) => i));
  const inputFingerprint = await fingerprint(input, selected.columns, selected.rows);
  const progress = (value: { stage: string; completed: number; total: number }) => { checkAbort(execution.signal); execution.onProgress?.(value); checkAbort(execution.signal); };
  checkAbort(execution.signal);
  const correlation = correlate(data, progress), result = fitKernel(data, correlation, spec, progress);
  checkAbort(execution.signal);
  const likelihood = result.likelihood;
  const model: EfaModel = {
    format: 'scatterlab-efa-model/1', engine: EFA_ENGINE,
    status: result.extraction.convergence.converged && result.rotation.convergence.converged ? 'converged' : 'unconverged',
    configuration: { items: data.items.map(item => ({ ...structuredClone(item), measurement: item.measurement ?? 'auto' })),
      factors: spec.nFactors, correlation: result.correlationMethod!, extraction: spec.extraction!, rotation: spec.rotation, missing: spec.missing, seed: spec.seed },
    preprocessing: { means: result.means.slice(), scales: result.sds.slice(),
      reverseOffsets: (result.correlationMethod === 'polychoric' ? Array(spec.items.length).fill(null) : result.numericReverseOffsets ?? result.imputation?.reverseOffsets ?? Array(spec.items.length).fill(null)).map(value => value ?? null),
      replacements: result.imputation?.values.slice() ?? null },
    parameters: { pattern: structuredClone(result.rotation.pattern), phi: structuredClone(result.rotation.phi),
      structure: structuredClone(result.structure), weights: structuredClone(result.weights),
      ...(likelihood ? { likelihood: { kind: likelihood.kind, means: likelihood.means.slice(), covariance: structuredClone(likelihood.covariance),
        residualVariances: likelihood.residualVariances.slice(), logLikelihood: likelihood.logLikelihood, nRows: likelihood.nRows,
        parameters: likelihood.parameters, df: likelihood.df, aic: likelihood.aic, bic: likelihood.bic, settings: { ...likelihood.settings } } } : {}) },
    convergence: { extraction: { ...result.extraction.convergence }, rotation: { ...result.rotation.convergence } },
    training: { rows: selected.rows.slice(), fittingRows: result.fittingRows.map(row => selected.rows[row]), sourceRowCount: selected.sourceRowCount, inputFingerprint },
  };
  const weighted = result.weighted;
  const localScores = scoreEfa(model, selected.table, { allowUnconverged: true });
  const scores = { scores: localScores.scores, rows: selected.rows.slice(), unscoredRows: localScores.unscoredRows.map(row => selected.rows[row]) };
  return { model, scores, correlation: structuredClone(result.correlation.matrix),
    communalities: result.communalities.slice(), uniquenesses: result.uniquenesses.slice(), reproduced: structuredClone(result.reproduced),
    residuals: structuredClone(result.residuals), rmsr: result.rmsr, diagnostics: structuredClone(result.diagnostics),
    ...(weighted ? { weighted: { estimator: weighted.estimator, rawStatistic: weighted.rawStatistic, df: weighted.df,
      samplingVariances: weighted.samplingVariances.slice(), fittingWeights: weighted.fittingWeights.slice(), uncertaintyMethod: weighted.uncertaintyMethod,
      ...(weighted.robust ? { robust: { test: structuredClone(weighted.robust.test), standardErrors: structuredClone(weighted.robust.standardErrors) } } : {}) } } : {}) };
}

/** Validate the portable scoring model, without accepting workspace records or executable state. */
export function validateEfaModel(value: unknown): asserts value is EfaModel {
  if (!object(value) || value.format !== 'scatterlab-efa-model/1' || typeof value.engine !== 'string' || !['converged', 'unconverged'].includes(String(value.status)) ||
      !object(value.configuration) || !object(value.preprocessing) || !object(value.parameters) || !object(value.training) || !object(value.convergence)) fail('Unsupported EFA model format.');
  const c = value.configuration, prep = value.preprocessing, parameters = value.parameters, training = value.training;
  if (!Array.isArray(c.items)) fail('Missing fitted item metadata.');
  resolvedSpec({ items: c.items, factors: c.factors, correlation: c.correlation, extraction: c.extraction,
    rotation: c.rotation, missing: c.missing, seed: c.seed } as EfaOptions);
  if (!['pearson', 'polychoric'].includes(String(c.correlation))) fail('A portable model must resolve its correlation method.');
  const p = c.items.length, k = c.factors as number;
  if (!vector(prep.means, p) || !vector(prep.scales, p, true) || !Array.isArray(prep.reverseOffsets) || prep.reverseOffsets.length !== p ||
      prep.reverseOffsets.some(offset => offset !== null && !finite(offset)) || prep.replacements !== null && !vector(prep.replacements, p)) fail('Invalid fitted preprocessing.');
  if ((c.missing === 'mean' || c.missing === 'median') !== (prep.replacements !== null)) fail('Fitted replacement values do not match the missing-data method.');
  for (const name of ['pattern', 'structure', 'weights']) if (!matrix(parameters[name], p, k)) fail('Invalid fitted loading or score dimensions.');
  if (!matrix(parameters.phi, k, k)) fail('Invalid factor correlation dimensions.');
  if (!Number.isSafeInteger(training.sourceRowCount) || (training.sourceRowCount as number) < 0 || !Array.isArray(training.rows) || !Array.isArray(training.fittingRows) ||
      typeof training.inputFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(training.inputFingerprint)) fail('Invalid fitting provenance.');
  for (const rows of [training.rows, training.fittingRows]) if (new Set(rows).size !== rows.length || rows.some(row => !Number.isSafeInteger(row) || row < 0 || row >= (training.sourceRowCount as number))) fail('Invalid fitted row membership.');
  const requestedRows = training.rows;
  if (training.fittingRows.some(row => !requestedRows.includes(row))) fail('Fitting rows must belong to the requested training rows.');
  for (const name of ['extraction', 'rotation']) {
    const status = value.convergence[name];
    if (!object(status) || typeof status.converged !== 'boolean' || !Number.isSafeInteger(status.iterations) || (status.iterations as number) < 0 ||
        !finite(status.objective) || !finite(status.gradient)) fail('Invalid convergence status.');
  }
  const converged = (value.convergence.extraction as { converged: boolean }).converged && (value.convergence.rotation as { converged: boolean }).converged;
  if ((value.status === 'converged') !== converged) fail('Model status disagrees with extraction or rotation status.');
  const likelihood = parameters.likelihood;
  if (c.extraction === 'ml') {
    if (!object(likelihood) || likelihood.kind !== (c.missing === 'fiml' ? 'fiml' : 'ml') || !vector(likelihood.means, p) ||
        !matrix(likelihood.covariance, p, p) || !vector(likelihood.residualVariances, p, true) || !object(likelihood.settings)) fail('Missing or invalid likelihood model.');
    for (const name of ['logLikelihood', 'nRows', 'parameters', 'df', 'aic', 'bic']) if (!finite(likelihood[name])) fail('Invalid likelihood statistics.');
    resolvedSpec({ items: c.items, factors: k, extraction: 'ml', correlation: 'pearson', missing: c.missing, likelihood: likelihood.settings } as EfaOptions);
  } else if (likelihood !== undefined) fail('Likelihood parameters require ML extraction.');
}

// The kernel projector reads only these numerical fields. Keep this adapter
// private so public serialization need not expose the broader internal result.
function projector(model: EfaModel) {
  return createConditionalProjector({ likelihood: model.parameters.likelihood, rotation: { pattern: model.parameters.pattern, phi: model.parameters.phi }, sds: model.preprocessing.scales } as EfaResult);
}
function analysisValues(model: EfaModel, values: readonly Cell[]): (number | null)[] {
  return values.map((value, j) => {
    if (value === null || value === '') return null;
    const item = model.configuration.items[j];
    if (model.configuration.correlation === 'pearson') {
      if (typeof value !== 'number') throw new EfaError('numeric-item', 'EFA scoring requires finite numeric values; numeric strings are not silently converted.');
      const offset = model.preprocessing.reverseOffsets[j];
      return offset === null ? value : offset - value;
    }
    const rank = item.categories.indexOf(value);
    if (rank < 0) throw new EfaError('category-order', 'A scoring value is outside the fitted category order.');
    return item.reverse ? item.categories.length - rank : rank + 1;
  });
}

/** Score new respondents using fitted category order, means/scales, reverse keys, and replacement values. */
export function scoreEfa(model: EfaModel, input: InputTable, options: EfaScoringOptions = {}): EfaScores {
  validateEfaModel(model);
  if (!object(options as unknown) || Object.keys(options).some(key => !['rows', 'allowUnconverged'].includes(key)) ||
      options.allowUnconverged !== undefined && typeof options.allowUnconverged !== 'boolean') throw new EfaError('options', 'Scoring accepts explicit rows and an optional allowUnconverged flag.');
  if (model.status !== 'converged' && !options.allowUnconverged) throw new EfaError('unconverged-model', 'Check the fitted convergence diagnostics before scoring an unconverged model; an explicit allowUnconverged flag is required.');
  const selected = materializeSelection(input, { columns: model.configuration.items.map(item => item.column), rows: options.rows });
  const project = model.parameters.likelihood ? projector(model) : null, unscoredRows: number[] = [];
  const scores = selected.rows.map((row, i) => {
    let values = analysisValues(model, selected.columns.map(column => selected.table.data[column][i] as Cell));
    if (model.preprocessing.replacements) values = values.map((value, j) => value ?? model.preprocessing.replacements![j]);
    let score: number[] | undefined;
    if (project) {
      if (model.configuration.missing === 'fiml' || values.every(value => value !== null)) score = project(values)?.factors;
    } else if (values.every(value => value !== null)) {
      score = Array.from({ length: model.configuration.factors }, (_, f) => values.reduce<number>((sum, value, j) => sum +
        (value! - model.preprocessing.means[j]) / model.preprocessing.scales[j] * model.parameters.weights[j][f], 0));
    }
    if (!score) { unscoredRows.push(row); return Array<number | null>(model.configuration.factors).fill(null); }
    if (score.some(value => !Number.isFinite(value))) throw new EfaError('scoring-range', 'Scoring exceeded the finite numeric range.');
    return score;
  });
  return { rows: selected.rows, scores, unscoredRows };
}

/** Complete only the original fitting cells after content/membership verification; never refit or overwrite observed cells. */
export async function completeEfa(model: EfaModel, input: InputTable): Promise<EfaCompletion> {
  validateEfaModel(model);
  model = structuredClone(model);
  const snapshot = materializeTable(input);
  if (!model.parameters.likelihood) throw new EfaError('completion-method', 'Conditional completion requires a Gaussian ML/FIML model.');
  if (model.status !== 'converged') throw new EfaError('unconverged-model', 'Conditional completion requires a converged model.');
  const columns = model.configuration.items.map(item => item.column), training = model.training;
  if (snapshot.nRows !== training.sourceRowCount || await fingerprint(snapshot, columns, training.rows) !== training.inputFingerprint)
    throw new EfaError('completion-data', 'Completion requires the original selected input values, missing mask, and fitting row membership.');
  const selected = materializeSelection(snapshot, { columns, rows: training.fittingRows });
  const values = columns.map(() => Array<number | null>(selected.rows.length).fill(null)), filled = columns.map(() => Array(selected.rows.length).fill(false));
  const project = projector(model), uninformativeRows: number[] = []; let completedCells = 0;
  selected.rows.forEach((row, i) => {
    const original = columns.map(column => selected.table.data[column][i] as Cell), transformed = analysisValues(model, original), completed = project(transformed)?.means;
    if (!completed) uninformativeRows.push(row);
    original.forEach((value, j) => {
      if (value !== null && value !== '') values[j][i] = value as number;
      else if (completed) {
        const offset = model.preprocessing.reverseOffsets[j];
        values[j][i] = offset === null ? completed[j] : offset - completed[j]; filled[j][i] = true; completedCells++;
      }
    });
  });
  return { columns, rows: selected.rows, values, filled, completedCells, uninformativeRows, method: 'conditional-gaussian-mean' };
}
export function serializeEfaModel(model: EfaModel): string { validateEfaModel(model); return JSON.stringify(model); }
export function deserializeEfaModel(serialized: string): EfaModel {
  const value: unknown = JSON.parse(serialized); validateEfaModel(value); return value;
}

export interface RotationOptions { method?: EfaRotation; seed?: number; starts?: number }
export interface RotatedLoadings {
  pattern: number[][]; phi: number[][]; structure: number[][]; starts: number; convergence: EfaConvergence;
}
/** Rotate item-by-factor loadings. Promax uses power four and its normalized Varimax initialization. */
export function rotateLoadings(loadings: readonly (readonly number[])[], options: RotationOptions = {}): RotatedLoadings {
  if (!object(options as unknown) || Object.keys(options).some(key => !['method', 'seed', 'starts'].includes(key)))
    throw new EfaError('options', 'Rotation accepts method, seed, and starts.');
  const method = options.method ?? 'promax', seed = options.seed ?? 73021, starts = options.starts ?? 4;
  const p = loadings?.length, k = loadings?.[0]?.length;
  if (!Number.isInteger(p) || !Number.isInteger(k) || !p || !k || k > p || !matrix(loadings, p, k))
    throw new EfaError('loadings', 'Loadings must be a finite rectangular item-by-factor matrix with 1–p factors.');
  if (!['promax', 'oblimin', 'varimax'].includes(method) || !Number.isSafeInteger(seed) || !Number.isSafeInteger(starts) || starts < 1 || starts > 100)
    throw new EfaError('rotation-settings', 'Choose Promax, Oblimin, or Varimax, an integer seed, and 1–100 starts.');
  const result = rotateKernel(loadings.map(row => [...row]), method, seed, starts);
  return { ...result, structure: result.pattern.map(row => Array.from({ length: k }, (_, j) => row.reduce((sum, value, i) => sum + value * result.phi[i][j], 0))) };
}

export interface ParallelOptions {
  items: readonly EfaItem[]; rows?: readonly number[];
  correlation?: 'auto' | 'pearson' | 'polychoric';
  missing?: Exclude<EfaMissing, 'fiml'>; replicates?: number; seed?: number;
}
export type ParallelAnalysisResult = ReturnType<typeof parallelKernel> & { rows: number[]; fittingRows: number[] };
/** One-factor MINRES reduced-matrix parallel analysis, using fixed-mask within-item permutations. */
export async function parallelAnalysis(input: InputTable, options: ParallelOptions, execution: EfaExecutionOptions = {}): Promise<ParallelAnalysisResult> {
  checkAbort(execution.signal);
  if (!object(options as unknown) || Object.keys(options).some(key => !['items', 'rows', 'correlation', 'missing', 'replicates', 'seed'].includes(key)))
    throw new EfaError('options', 'Parallel analysis accepts items, rows, correlation, missing, replicates, and seed.');
  const replicates = options.replicates ?? 100;
  const spec = resolvedSpec({ items: options.items, factors: 1, rows: options.rows, correlation: options.correlation, missing: options.missing, seed: options.seed });
  const selected = materializeSelection(input, { columns: spec.items.map(item => item.column), rows: options.rows });
  const data = prepareEfa(selected.table, spec, Array.from({ length: selected.rows.length }, (_, i) => i));
  data.fingerprint = await fingerprint(input, selected.columns, selected.rows);
  checkAbort(execution.signal);
  const result = parallelKernel(data, spec.seed, replicates, value => {
    checkAbort(execution.signal); execution.onProgress?.(value); checkAbort(execution.signal);
  });
  checkAbort(execution.signal);
  return { ...result, rows: selected.rows, fittingRows: data.rows.map(row => selected.rows[row]) };
}

export interface EfaBootstrapOptions {
  replicates?: number; seed?: number; confidence?: number; crossLoadingThreshold?: number;
  /** Cluster labels aligned with every row of the original input table. */
  groups?: readonly string[];
}
export interface EfaBootstrapResult extends Omit<StabilityResult, 'options' | 'samples'> {
  options: Required<Omit<EfaBootstrapOptions, 'groups'>> & { groups?: string[] };
  /** Original input indices, including bootstrap repetitions, for each replicate. */
  sampleRows: number[][];
  fittingRows: number[];
}
/** Refits original training respondents; supports row or cluster resampling and reports failed replicates. */
export async function bootstrapEfa(model: EfaModel, input: InputTable, options: EfaBootstrapOptions = {}, execution: EfaExecutionOptions = {}): Promise<EfaBootstrapResult> {
  validateEfaModel(model); checkAbort(execution.signal);
  if (model.status !== 'converged') throw new EfaError('unconverged-model', 'Bootstrap stability requires a converged reference model.');
  if (!object(options as unknown) || Object.keys(options).some(key => !['replicates', 'seed', 'confidence', 'crossLoadingThreshold', 'groups'].includes(key)))
    throw new EfaError('options', 'Bootstrap accepts replicates, seed, confidence, crossLoadingThreshold, and original-row group labels.');
  model = structuredClone(model);
  const snapshot = materializeTable(input), columns = model.configuration.items.map(item => item.column), training = model.training;
  if (options.groups !== undefined && !Array.isArray(options.groups)) throw new EfaError('resampling-groups', 'Group labels must be an array aligned with the original input rows.');
  const settings = { replicates: options.replicates ?? 200, seed: options.seed ?? 71021, confidence: options.confidence ?? 0.95,
    crossLoadingThreshold: options.crossLoadingThreshold ?? 0.3, ...(options.groups === undefined ? {} : { groups: [...options.groups] }) };
  if (settings.groups && (!Array.isArray(options.groups) || settings.groups.length !== snapshot.nRows || settings.groups.some(value => typeof value !== 'string' || !value.length)))
    throw new EfaError('resampling-groups', 'Group labels must be nonempty strings aligned with every original input row.');
  if (!finite(settings.confidence) || !finite(settings.crossLoadingThreshold)) throw new EfaError('stability-settings', 'Confidence and cross-loading threshold must be finite.');
  if (snapshot.nRows !== training.sourceRowCount || await fingerprint(snapshot, columns, training.rows) !== training.inputFingerprint)
    throw new EfaError('resampling-data', 'Bootstrap requires the original selected input values, missing mask, and row membership.');
  checkAbort(execution.signal);
  const c = model.configuration, spec = resolvedSpec({ ...c, rows: training.rows, ...(model.parameters.likelihood ? { likelihood: model.parameters.likelihood.settings } : {}) });
  const selected = materializeSelection(snapshot, { columns, rows: training.rows });
  const data = prepareEfa(selected.table, spec, Array.from({ length: selected.rows.length }, (_, i) => i));
  const fittingRows = data.rows.map(row => selected.rows[row]);
  if (JSON.stringify(fittingRows) !== JSON.stringify(training.fittingRows)) throw new EfaError('resampling-data', 'Prepared rows disagree with the saved fitting membership.');
  data.fingerprint = training.inputFingerprint;
  const result = bootstrapKernel(data, spec, { rotation: { pattern: model.parameters.pattern, phi: model.parameters.phi, starts: 1, convergence: model.convergence.rotation } },
    { ...settings, ...(settings.groups ? { groups: fittingRows.map(row => settings.groups![row]) } : {}) }, value => {
      checkAbort(execution.signal); execution.onProgress?.(value); checkAbort(execution.signal);
    });
  checkAbort(execution.signal);
  const { samples, ...summary } = result;
  return { ...summary, options: settings, fittingRows, sampleRows: samples.map(sample => sample.map(row => fittingRows[row])) };
}
