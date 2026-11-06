import { asNumber, type DataTable } from './table';
import { runPCA, type PCAOptions, type PCAResult } from './pca';
import { imputeMice, validateMiceOptions, type MiceOptions, type MiceTrace } from './efa/mice';
import { MAX_CONDITIONAL_LEVELS } from './efa/ordinal-regression';
import { preparedSample } from './efa/prepared-sample';
import type { EfaPreparedData, Progress } from './efa/types';
import { inferMeasurement, type MeasurementChoice } from './measurement';

export type PcaMiceSettings = MiceOptions & Pick<PCAOptions, 'k' | 'standardize' | 'label' | 'measurements'>;
export type PcaMiceFailure = { imputation: number; stage: 'imputation' | 'pca'; error: string };
export type PcaMiceChain = { imputation: number; result?: PCAResult; failure?: PcaMiceFailure; trace: MiceTrace[] };

/** Numeric ordered categories retain their actual spacing in the subsequent PCA. */
export function preparePcaMice(table: DataTable, variables: string[], measurements: Record<string, MeasurementChoice> = {}): EfaPreparedData {
  if (variables.length < 2 || new Set(variables).size !== variables.length)
    throw new Error('Select at least two unique numeric items for MICE + PCA.');
  const n = table.nRows, p = variables.length;
  if (!Number.isSafeInteger(n) || n < 3) throw new Error('MICE + PCA needs at least three fitting rows.');
  const codes = new Uint16Array(n * p), observed = new Uint8Array(n * p);
  const items = variables.map((column, j) => {
    if (!table.columns.includes(column)) throw new Error(`Item "${column}" does not exist.`);
    const values = Array.from({ length: n }, (_, i) => {
      const raw = table.data[column]?.[i];
      if (raw == null || raw === '') return null;
      const value = asNumber(raw);
      if (value === null) throw new Error(`"${column}" contains a nonnumeric value. PCA requires numeric ordered categories.`);
      return value;
    });
    const inferred = inferMeasurement(values, { measurement: measurements[column] ?? 'auto' });
    if (inferred.kind !== 'ordinal')
      throw new Error(`Ordinal MICE requires ordered categorical items; "${column}" is ${inferred.kind}. Review its item type or use a numeric imputation method.`);
    const categories = inferred.categories as number[];
    if (categories.length < 2 || categories.length > MAX_CONDITIONAL_LEVELS)
      throw new Error(`Ordinal MICE requires 2–${MAX_CONDITIONAL_LEVELS} observed categories in "${column}". Use a numeric imputation method for continuous items.`);
    const ranks = new Map(categories.map((value, i) => [value, i]));
    values.forEach((value, i) => {
      if (value === null) return;
      codes[j * n + i] = ranks.get(value)!;
      observed[j * n + i] = 1;
    });
    return { column, categories, reverse: false, measurement: 'ordinal' as const };
  });
  const source: EfaPreparedData = { items, nRows: n, originalRowCount: n,
    rows: Array.from({ length: n }, (_, i) => i), codes, observed,
    means: [], sds: [], counts: [], diagnostics: [] };
  return preparedSample(source, codes, observed);
}

export function runPcaMiceChain(table: DataTable, source: EfaPreparedData, settings: PcaMiceSettings, index: number, progress?: Progress): PcaMiceChain {
  validateMiceOptions(settings, source.items.length);
  const chain = imputeMice(source, settings, progress, undefined, [index]);
  if (!chain.completed.length) return { imputation: index + 1, trace: chain.trace,
    failure: { imputation: index + 1, stage: 'imputation', error: chain.failures[0]?.error ?? 'The imputation did not complete.' } };
  const completed = chain.completed[0].data, data = { ...table.data };
  source.items.forEach((item, j) => {
    data[item.column] = Array.from({ length: source.nRows }, (_, i) => source.observed[j * source.nRows + i]
      ? table.data[item.column][i]
      : item.categories[completed.codes[j * source.nRows + i]]);
  });
  try {
    const result = runPCA({ ...table, data }, source.items.map(item => item.column), { ...settings, missing: 'complete' });
    // Store source inputs, not an apparently observed completed data table.
    result.table = { columns: result.table.columns, nRows: table.nRows,
      data: { ...Object.fromEntries(Object.entries(table.data).filter(([c]) => !result.replaced.includes(c))),
        ...Object.fromEntries(result.columns.map(c => [c, result.table.data[c]])) } };
    result.missing = { strategy: 'mice', imputation: index + 1, imputations: settings.imputations, seed: settings.seed,
      imputedCells: chain.missingPositions.length, totalCells: source.nRows * source.items.length,
      byVariable: source.items.map((item, j) => ({ var: item.column,
        n: source.nRows - source.observed.slice(j * source.nRows, (j + 1) * source.nRows).reduce((sum, v) => sum + v, 0),
      })).filter(v => v.n > 0).sort((a, b) => b.n - a.n), rowsUsed: source.nRows, rowsDropped: 0,
      iterations: settings.iterations };
    return { imputation: index + 1, result, trace: chain.trace };
  } catch (error) {
    return { imputation: index + 1, trace: chain.trace, failure: { imputation: index + 1, stage: 'pca', error: error instanceof Error ? error.message : String(error) } };
  }
}
