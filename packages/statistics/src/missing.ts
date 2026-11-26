import { materializeSelection, materializeTable, selectionRows, type InputTable, type Selection, type Cell } from './data';
import { columnReplacement, inferMeasurement, type ColumnReplacement, type MeasurementChoice, type Category } from './internal/measurement';
import { imputeMice, type MiceOptions } from './internal/efa/mice';
import { preparedSample } from './internal/efa/prepared-sample';
import { MAX_CONDITIONAL_LEVELS } from './internal/efa/ordinal-regression';
import type { EfaPreparedData } from './internal/efa/types';

export { inferMeasurement } from './internal/measurement';
export type { MeasurementChoice, MeasurementKind, MeasurementOptions, MeasurementInference, ReplacementRule, ColumnReplacement } from './internal/measurement';

export interface ColumnImputer {
  format: 'scatterlab-column-imputer/1';
  method: 'mean' | 'median';
  columns: string[];
  replacements: ColumnReplacement[];
  fittedRows: number;
}
export interface ImputerOptions extends Selection {
  method: 'mean' | 'median';
  measurements?: Record<string, MeasurementChoice>;
  orders?: Record<string, Category[]>;
}

function measurementOptions(column: string, options: Pick<ImputerOptions, 'measurements' | 'orders'>) {
  for (const declaration of [options.measurements, options.orders]) if (declaration !== undefined &&
      (!declaration || typeof declaration !== 'object' || Array.isArray(declaration))) throw new TypeError('Measurement and category-order declarations must be records keyed by column name.');
  const choice = options.measurements?.[column], categories = options.orders?.[column];
  if (choice !== undefined && !['auto', 'ordinal', 'continuous'].includes(choice)) throw new TypeError(`Invalid measurement choice for "${column}".`);
  if (categories !== undefined) {
    if (!Array.isArray(categories) || !categories.length || new Set(categories).size !== categories.length ||
        categories.some(value => !(typeof value === 'string' && value !== '' || typeof value === 'number' && Number.isFinite(value))))
      throw new TypeError(`"${column}" needs a nonempty category order of distinct finite numbers or nonempty strings.`);
    if (choice === 'continuous') throw new TypeError(`"${column}" cannot declare both continuous measurement and an ordered category scale.`);
  }
  return { measurement: categories === undefined ? choice : 'ordinal' as const, categories };
}

/** Learn replacements only from the selected training rows. Numeric strings are
 * not converted; declare a text category order or explicitly normalize inputs. */
export function fitColumnImputer(input: InputTable, options: ImputerOptions): ColumnImputer {
  if (!options || !['mean', 'median'].includes(options.method)) throw new TypeError('Choose mean or median imputation.');
  const selected = materializeSelection(input, { columns: options.columns, rows: options.rows });
  const replacements = selected.columns.map(column => columnReplacement(selected.table.data[column], options.method,
    measurementOptions(column, options)));
  const model: ColumnImputer = { format: 'scatterlab-column-imputer/1', method: options.method,
    columns: selected.columns, replacements, fittedRows: selected.rows.length };
  validateImputer(model);
  return model;
}

function validateImputer(model: ColumnImputer): void {
  if (!model || model.format !== 'scatterlab-column-imputer/1' || !['mean', 'median'].includes(model.method) ||
      !Array.isArray(model.columns) || !model.columns.length || new Set(model.columns).size !== model.columns.length ||
      model.columns.some(name => typeof name !== 'string' || !name) || !Array.isArray(model.replacements) ||
      model.replacements.length !== model.columns.length || !Number.isSafeInteger(model.fittedRows) || model.fittedRows < 1)
    throw new TypeError('Invalid fitted column imputer.');
  for (const replacement of model.replacements) {
    const validValue = typeof replacement?.value === 'string' || typeof replacement?.value === 'number' && Number.isFinite(replacement.value);
    if (!replacement || !validValue || !Array.isArray(replacement.categories) ||
        !['continuous', 'ordinal'].includes(replacement.kind) || typeof replacement.reason !== 'string')
      throw new TypeError('Invalid fitted replacement.');
    if (replacement.kind === 'continuous' && (typeof replacement.value !== 'number' || replacement.categories.length ||
        replacement.rule !== (model.method === 'mean' ? 'numeric-mean' : 'numeric-median')))
      throw new TypeError('Invalid continuous replacement.');
    if (replacement.kind === 'ordinal' && (!replacement.categories.length || new Set(replacement.categories).size !== replacement.categories.length ||
        replacement.categories.some(value => !(typeof value === 'string' && value !== '' || typeof value === 'number' && Number.isFinite(value))) ||
        !replacement.categories.includes(replacement.value) ||
        (model.method === 'median' ? replacement.rule !== 'category-median' : !['nearest-category-mean', 'nearest-category-mean-rank'].includes(replacement.rule))))
      throw new TypeError('Invalid ordered-category replacement.');
  }
}

/** Fill only null/empty cells in a copied table. Returns an explicit column-major
 * mask for every source row. Observed values and unselected rows are unchanged. */
export function applyColumnImputer(model: ColumnImputer, input: InputTable, options: { rows?: readonly number[] } = {}) {
  validateImputer(model);
  const table = materializeTable(input), rows = selectionRows(table.nRows, options.rows);
  const filled: Record<string, boolean[]> = Object.create(null);
  let filledCells = 0;
  model.columns.forEach((column, j) => {
    if (!table.columns.includes(column)) throw new RangeError(`The input is missing fitted column "${column}".`);
    const replacement = model.replacements[j];
    filled[column] = Array(table.nRows).fill(false);
    for (const row of rows) {
      const value = table.data[column][row] as Cell;
      if (value === null || value === '') {
        table.data[column][row] = replacement.value;
        filled[column][row] = true; filledCells++;
      } else if (replacement.kind === 'continuous' ? typeof value !== 'number' : !replacement.categories.includes(value)) {
        throw new TypeError(`Column "${column}" does not match the fitted measurement scale.`);
      }
    }
  });
  return { table: table as InputTable, filled, filledCells, rows };
}

export function serializeImputer(model: ColumnImputer): string {
  validateImputer(model); return JSON.stringify(model);
}
export function deserializeImputer(json: string): ColumnImputer {
  const model = JSON.parse(json) as ColumnImputer; validateImputer(model); return model;
}

export interface OrdinalMiceOptions extends Selection {
  orders?: Record<string, Category[]>;
  measurements?: Record<string, MeasurementChoice>;
  imputations: number;
  iterations: number;
  seed: number;
  /** Explicit column names for every target. No predictor pruning is performed. */
  predictors: Record<string, string[]>;
  predictorEncoding?: 'ordered-polynomial' | 'rank';
}

/** Separate completed datasets from ordered-category chained models. This is
 * transductive imputation on the selected sample, not a fitted holdout transformer.
 * A fixed number of sweeps does not establish chain convergence or pooled inference. */
export function imputeOrdinal(input: InputTable, options: OrdinalMiceOptions) {
  const selected = materializeSelection(input, { columns: options.columns, rows: options.rows });
  const { columns, table, rows } = selected, n = rows.length, p = columns.length;
  if (p < 2 || p > 500 || n < 3) throw new RangeError('Ordinal MICE needs 2–500 columns and at least three selected rows.');
  if (!options.predictors || Object.keys(options.predictors).some(name => !columns.includes(name)))
    throw new TypeError('Specify predictors for the selected columns only.');
  const codes = new Uint16Array(n * p), observed = new Uint8Array(n * p);
  const items = columns.map((column, j) => {
    const inferred = inferMeasurement(table.data[column], measurementOptions(column, options));
    if (inferred.kind !== 'ordinal' || inferred.categories.length < 2 || inferred.categories.length > MAX_CONDITIONAL_LEVELS)
      throw new TypeError(`"${column}" needs 2–${MAX_CONDITIONAL_LEVELS} ordered categories. Declare its measurement and order explicitly when needed.`);
    const lookup = new Map(inferred.categories.map((value, rank) => [value, rank]));
    table.data[column].forEach((value, i) => {
      if (value === null || value === '') return;
      const rank = lookup.get(value);
      if (rank === undefined) throw new TypeError('Observed category is outside the declared order.');
      codes[j * n + i] = rank; observed[j * n + i] = 1;
    });
    return { column, categories: inferred.categories, reverse: false, measurement: 'ordinal' as const };
  });
  const settings: MiceOptions = { imputations: options.imputations, iterations: options.iterations, seed: options.seed,
    predictorEncoding: options.predictorEncoding ?? 'ordered-polynomial', predictors: columns.map(column => {
      const names = options.predictors[column];
      if (!Array.isArray(names)) throw new TypeError('Specify a predictor array for every target column.');
      return names.map(name => columns.indexOf(name));
    }) };
  const initial: EfaPreparedData = { items, nRows: n, originalRowCount: n, rows: Array.from({ length: n }, (_, i) => i),
    codes, observed, means: [], sds: [], counts: [], diagnostics: [] };
  const source = preparedSample(initial, codes, observed), result = imputeMice(source, settings);
  const filled = Object.fromEntries(columns.map((column, j) => [column, Array.from({ length: n }, (_, i) => !observed[j * n + i])]));
  return {
    rows, sourceRowCount: selected.sourceRowCount, filled,
    completed: result.completed.map(chain => {
      const data: Record<string, Cell[]> = Object.create(null);
      columns.forEach((column, j) => { data[column] = Array.from({ length: n }, (_, i) => observed[j * n + i]
        ? table.data[column][i] as Cell : items[j].categories[chain.data.codes[j * n + i]]); });
      return { imputation: chain.imputation, table: { columns: columns.slice(), data, nRows: n } as InputTable };
    }),
    failures: result.failures, trace: result.trace, settings: { ...settings, predictors: Object.fromEntries(columns.map((column, j) => [column, settings.predictors[j].map(i => columns[i])])) },
    provenance: result.provenance, convergence: 'not-assessed' as const,
  };
}
