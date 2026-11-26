import { materializeSelection, type InputTable } from './data';
import { asNumber } from './internal/table';
import { fitPcaCore, type MissingReport, type PCAOptions } from './internal/pca';
import { iterativePcaSettings, type ConvergenceIssue, type IterativePcaSettings } from './internal/convergence';
import type { MeasurementChoice } from './internal/measurement';

export type PcaMissingStrategy = 'mean' | 'median' | 'complete' | 'pairwise' | 'iterative';
/** This describes iterative imputation, not an independent eigensolver convergence claim. */
export type PcaConvergence = { stage: 'iterative-imputation' | 'not-applicable'; converged: boolean; issue?: ConvergenceIssue };
export interface PcaOptions {
  columns?: readonly string[];
  rows?: readonly number[];
  k?: number;
  standardize?: boolean;
  missing?: PcaMissingStrategy;
  measurements?: Readonly<Record<string, MeasurementChoice>>;
  minimumPairN?: number;
  iterative?: IterativePcaSettings;
}
export interface PcaModel {
  schema: 'scatterlab.pca/1';
  engine: 'scatter-pca/1';
  variables: string[];
  k: number;
  standardize: boolean;
  /** Component-major unit eigenvectors, in variables order; never rounded. */
  components: number[][];
  means: number[];
  /** Population SD when standardized, otherwise one. */
  scales: number[];
  eigenvalues: number[];
  spectrum: number[];
  varianceExplained: number[];
  missing: {
    strategy: PcaMissingStrategy;
    /** Training replacements for mean/median; null for every other method. */
    replacements: (number | null)[];
    iterative?: Required<IterativePcaSettings>;
  };
  convergence: PcaConvergence;
  training: {
    sourceRowCount: number;
    selectedRows: number[];
    fittingRows: number[];
    scoredRows: number[];
  };
}
export interface PcaFit {
  model: PcaModel;
  /** Original input row indices in score order. Includes unscored rows. */
  rows: number[];
  /** Row-major scores; every component is null for an unscored row. */
  scores: (number | null)[][];
  fittingRows: number[];
  scoredRows: number[];
  missing: MissingReport;
  convergence: PcaConvergence;
}
export interface PcaTransformOptions {
  rows?: readonly number[];
  /** Explicit consent to use an iterative fit that stopped without convergence. */
  allowUnconverged?: boolean;
}
export interface PcaScores {
  rows: number[];
  scores: (number | null)[][];
  scoredRows: number[];
  unscoredRows: number[];
  imputedCells: number;
}

const fail = (message: string): never => { throw new Error(`PCA: ${message}`); };
const methods: readonly string[] = ['mean', 'median', 'complete', 'pairwise', 'iterative'];
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: unknown, allowed: readonly string[], required = allowed): Record<string, unknown> => {
  if (!isRecord(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key)))
    return fail('Invalid model or settings fields.');
  return value;
};
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const finiteVector = (value: unknown, length: number): value is number[] =>
  Array.isArray(value) && value.length === length && Array.from(value).every(finite);
const rowsValid = (value: unknown, n: number): value is number[] => Array.isArray(value)
  && Array.from(value).every(row => integer(row, 0, n - 1)) && new Set(value).size === value.length;

/** Fit selected rows once. No source columns are added, removed, rounded or changed. */
export function fitPca(input: InputTable, options: PcaOptions = {}): PcaFit {
  exactKeys(options, ['columns', 'rows', 'k', 'standardize', 'missing', 'measurements', 'minimumPairN', 'iterative'], []);
  const selected = materializeSelection(input, { columns: options.columns, rows: options.rows });
  const p = selected.columns.length, n = selected.rows.length;
  if (options.k !== undefined && !integer(options.k, 1, Math.min(p, n - 1))) fail('k must be a positive integer within the selected sample rank.');
  if (options.standardize !== undefined && typeof options.standardize !== 'boolean') fail('standardize must be a boolean.');
  if (options.missing !== undefined && !methods.includes(options.missing)) fail('Unknown missing-value method. MICE produces separate fits and is a separate operation.');
  if (options.minimumPairN !== undefined && !integer(options.minimumPairN, 2)) fail('minimumPairN must be an integer of at least two.');
  if (options.measurements !== undefined && (!isRecord(options.measurements)
      || Object.entries(options.measurements).some(([name, value]) => !selected.columns.includes(name) || !['auto', 'ordinal', 'continuous'].includes(value))))
    fail('Measurement choices must name selected variables and use auto, ordinal or continuous.');
  const completeRows = options.missing === 'complete'
    ? selected.rows.filter((_, row) => selected.columns.every(column => asNumber(selected.table.data[column][row]) !== null)).length
    : n;
  if (completeRows >= 3 && options.k !== undefined && options.k > Math.min(p, completeRows - 1))
    fail('k exceeds the rank available after complete-case deletion.');
  const defaultK = completeRows >= 3 ? Math.min(3, p, completeRows - 1) : undefined;
  const coreOptions: PCAOptions = { k: options.k ?? defaultK, standardize: options.standardize, missing: options.missing,
    measurements: options.measurements ? { ...options.measurements } : undefined,
    minimumPairN: options.minimumPairN, iterative: options.iterative };
  const fit = fitPcaCore(selected.table, selected.columns, coreOptions);
  const fittingRows = fit.fittingRows.map(row => selected.rows[row]), scoredRows = fit.scoredRows.map(row => selected.rows[row]);
  const convergence: PcaConvergence = { stage: fit.missing.strategy === 'iterative' ? 'iterative-imputation' : 'not-applicable', converged: fit.missing.converged !== false,
    ...(fit.missing.convergenceIssue ? { issue: structuredClone(fit.missing.convergenceIssue) } : {}) };
  const model: PcaModel = {
    schema: 'scatterlab.pca/1', engine: 'scatter-pca/1', variables: fit.variables, k: fit.k, standardize: fit.standardize,
    components: fit.components, means: fit.means, scales: fit.scales,
    eigenvalues: fit.eigenvalues, spectrum: fit.spectrum, varianceExplained: fit.varianceExplained,
    missing: { strategy: fit.missing.strategy as PcaMissingStrategy, replacements: fit.replacements,
      ...(fit.missing.iterativeSettings ? { iterative: { ...fit.missing.iterativeSettings } } : {}) },
    convergence, training: { sourceRowCount: selected.sourceRowCount, selectedRows: selected.rows.slice(), fittingRows, scoredRows },
  };
  const validatedModel = validatePcaModel(model);
  if (fit.scores.some(column => column.some(value => value !== null && !Number.isFinite(value))))
    fail('Scoring exceeds the supported numeric range. Rescale the data and refit explicitly.');
  return { model: validatedModel, rows: selected.rows, scores: selected.rows.map((_, row) => fit.scores.map(column => column[row])),
    fittingRows: fittingRows.slice(), scoredRows: scoredRows.slice(), missing: fit.missing, convergence: structuredClone(convergence) };
}

/** Apply saved components and preprocessing. This operation never estimates new parameters. */
export function transformPca(model: PcaModel, input: InputTable, options: PcaTransformOptions = {}): PcaScores {
  exactKeys(options, ['rows', 'allowUnconverged'], []);
  if (options.allowUnconverged !== undefined && typeof options.allowUnconverged !== 'boolean') fail('allowUnconverged must be a boolean.');
  const fit = validatePcaModel(model);
  if (!fit.convergence.converged && !options.allowUnconverged)
    fail('This iterative PCA fit did not converge. Inspect its diagnostics or explicitly allowUnconverged before scoring.');
  const selected = materializeSelection(input, { columns: fit.variables, rows: options.rows });
  const scoredRows: number[] = [], unscoredRows: number[] = [];
  let imputedCells = 0;
  const scores = selected.rows.map((originalRow, row) => {
    const values = fit.variables.map(variable => asNumber(selected.table.data[variable][row]));
    const missing = values.some(value => value === null);
    if (missing && fit.missing.strategy === 'iterative')
      return fail('An iterative PCA model cannot score incomplete new rows. Supply complete numeric values or explicitly prepare new data; transformPca never refits the imputer.');
    if (missing && (fit.missing.strategy === 'complete' || fit.missing.strategy === 'pairwise')) {
      unscoredRows.push(originalRow); return Array<number | null>(fit.k).fill(null);
    }
    const z = values.map((value, j) => {
      if (value === null) { imputedCells++; value = fit.missing.replacements[j]; }
      if (value === null) return fail('The model has no replacement for this missing value.');
      return (value - fit.means[j]) / fit.scales[j];
    });
    const result = fit.components.map(component => component.reduce((sum, loading, j) => sum + z[j] * loading, 0));
    if (!result.every(Number.isFinite)) return fail('Scoring exceeds the supported numeric range. Rescale the data and refit explicitly.');
    scoredRows.push(originalRow); return result;
  });
  return { rows: selected.rows, scores, scoredRows, unscoredRows, imputedCells };
}

/** Validate a deserialized model and return an independent copy. */
export function validatePcaModel(value: unknown): PcaModel {
  const model = exactKeys(value, ['schema', 'engine', 'variables', 'k', 'standardize', 'components', 'means', 'scales',
    'eigenvalues', 'spectrum', 'varianceExplained', 'missing', 'convergence', 'training']);
  if (model.schema !== 'scatterlab.pca/1' || model.engine !== 'scatter-pca/1') fail('Unsupported model schema or engine.');
  const variables = model.variables;
  if (!Array.isArray(variables) || variables.length < 2 || Array.from(variables).some(v => typeof v !== 'string' || !v.length) || new Set(variables).size !== variables.length)
    fail('Model variables must be distinct nonempty names.');
  const p = (variables as string[]).length;
  if (!integer(model.k, 1, p) || typeof model.standardize !== 'boolean') fail('Invalid model dimension or standardization flag.');
  const k = model.k as number;
  for (const field of ['means', 'scales', 'eigenvalues', 'spectrum'] as const)
    if (!finiteVector(model[field], p)) fail(`Invalid model ${field}.`);
  const scales = model.scales as number[], eigenvalues = model.eigenvalues as number[], spectrum = model.spectrum as number[];
  if (scales.some(v => v <= 0 || (!model.standardize && v !== 1)) || eigenvalues.some((v, i) => v < 0 || (i > 0 && v > eigenvalues[i - 1] + 1e-10 * Math.max(1, v))))
    fail('Invalid model scales or eigenvalues.');
  const total = eigenvalues.reduce((sum, v) => sum + v, 0) || 1;
  if (!Number.isFinite(total) || spectrum.some((v, i) => Math.abs(v - eigenvalues[i] / total) > 1e-10)
    || !finiteVector(model.varianceExplained, k) || model.varianceExplained.some((v, i) => Math.abs(v - spectrum[i]) > 1e-10))
    fail('Model variance fractions do not match its eigenvalues.');
  if (!Array.isArray(model.components) || model.components.length !== k || Array.from(model.components).some(row => !finiteVector(row, p)))
    fail('Invalid model components.');
  const components = model.components as number[][];
  for (let i = 0; i < k; i++) for (let j = 0; j <= i; j++) {
    const dot = components[i].reduce((sum, v, column) => sum + v * components[j][column], 0);
    if (Math.abs(dot - (i === j ? 1 : 0)) > 1e-7) fail('Model components must be orthonormal.');
  }
  const missing = exactKeys(model.missing, ['strategy', 'replacements', 'iterative'], ['strategy', 'replacements']);
  if (typeof missing.strategy !== 'string' || !methods.includes(missing.strategy) || !Array.isArray(missing.replacements) || missing.replacements.length !== p)
    fail('Invalid model missing-value settings.');
  const columnFill = missing.strategy === 'mean' || missing.strategy === 'median';
  if (Array.from(missing.replacements as unknown[]).some(v => columnFill ? !finite(v) : v !== null)) fail('Invalid fitted replacements.');
  const training = exactKeys(model.training, ['sourceRowCount', 'selectedRows', 'fittingRows', 'scoredRows']);
  if (!integer(training.sourceRowCount, 3) || !rowsValid(training.selectedRows, training.sourceRowCount)
    || !rowsValid(training.fittingRows, training.sourceRowCount) || !rowsValid(training.scoredRows, training.sourceRowCount)) fail('Invalid training row mapping.');
  const selectedRows = training.selectedRows as number[], fittingRows = training.fittingRows as number[], scoredRows = training.scoredRows as number[];
  const selectedSet = new Set(selectedRows), fittingSet = new Set(fittingRows);
  if (selectedRows.length < 3 || k > selectedRows.length - 1 || fittingRows.length < 2
    || (missing.strategy === 'complete' && (fittingRows.length < 3 || k > fittingRows.length - 1)) || fittingRows.some(row => !selectedSet.has(row))
    || scoredRows.some(row => !fittingSet.has(row))) fail('Inconsistent training row membership.');
  const sameRows = (a: number[], b: number[]) => a.length === b.length && a.every((row, i) => row === b[i]);
  const scoredSet = new Set(scoredRows);
  if (!sameRows(selectedRows.filter(row => fittingSet.has(row)), fittingRows)
    || !sameRows(fittingRows.filter(row => scoredSet.has(row)), scoredRows)
    || (missing.strategy === 'complete' && !sameRows(fittingRows, scoredRows))
    || (['mean', 'median', 'iterative'].includes(missing.strategy as string) && (!sameRows(selectedRows, fittingRows) || !sameRows(selectedRows, scoredRows))))
    fail('Training row order or missing-value membership is inconsistent.');
  if (missing.strategy === 'iterative') {
    const settings = exactKeys(missing.iterative, ['maxIterations', 'tolerance', 'rank']);
    const resolved = iterativePcaSettings(settings as IterativePcaSettings, k);
    if (resolved.rank > Math.min(p - 1, selectedRows.length - 2)) fail('Invalid iterative training rank.');
  } else if (missing.iterative !== undefined) fail('Iterative settings require an iterative model.');
  const convergence = exactKeys(model.convergence, ['stage', 'converged', 'issue'], ['stage', 'converged']);
  if (convergence.stage !== (missing.strategy === 'iterative' ? 'iterative-imputation' : 'not-applicable')) fail('Convergence stage does not match the fitted method.');
  if (typeof convergence.converged !== 'boolean') fail('Invalid convergence flag.');
  if (convergence.converged) {
    if (convergence.issue !== undefined) fail('A converged model cannot carry a nonconvergence issue.');
  } else {
    if (missing.strategy !== 'iterative') fail('Only iterative imputation can return a partial PCA model.');
    const issue = exactKeys(convergence.issue, ['method', 'reason', 'settings', 'iterations', 'objective', 'criterion', 'partialAvailable'],
      ['method', 'reason', 'settings', 'iterations', 'objective', 'partialAvailable']);
    const settings = exactKeys(issue.settings, ['maxIterations', 'tolerance', 'rank']);
    if (issue.method !== 'iterative-pca' || !['iteration-limit', 'non-finite'].includes(issue.reason as string)
      || issue.partialAvailable !== true || !integer(issue.iterations, 1, (missing.iterative as Required<IterativePcaSettings>).maxIterations)
      || !(issue.objective === null || finite(issue.objective)) || !(issue.criterion === undefined || issue.criterion === null || finite(issue.criterion))
      || ['maxIterations', 'tolerance', 'rank'].some(key => settings[key] !== (missing.iterative as Record<string, unknown>)[key]))
      fail('Invalid iterative convergence diagnostics.');
  }
  return structuredClone(value) as PcaModel;
}

export function serializePcaModel(model: PcaModel): string {
  return JSON.stringify(validatePcaModel(model));
}

export function deserializePcaModel(json: string): PcaModel {
  if (typeof json !== 'string') fail('Serialized models must be JSON text.');
  let value: unknown;
  try { value = JSON.parse(json); } catch { return fail('Invalid model JSON.'); }
  return validatePcaModel(value);
}
