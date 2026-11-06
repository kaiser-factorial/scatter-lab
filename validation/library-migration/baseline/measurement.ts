export type MeasurementChoice = 'auto' | 'ordinal' | 'continuous';
export type MeasurementKind = 'ordinal' | 'continuous' | 'nominal' | 'empty';
export type Category = string | number;
export type MeasurementOptions = { measurement?: MeasurementChoice; categories?: Category[] };
export type MeasurementInference = { kind: MeasurementKind; categories: Category[]; reason: string };

const present = (values: unknown[]) => values.filter(v => v !== null && v !== undefined && v !== '');

/** A conservative suggestion, not proof of a variable's measurement level. */
export function inferMeasurement(values: unknown[], options: MeasurementOptions = {}): MeasurementInference {
  const observed = present(values);
  if (!observed.length) return { kind: 'empty', categories: [], reason: 'No observed values in the fitting sample.' };
  const numeric = observed.every(v => typeof v === 'number' && Number.isFinite(v));
  const unique = [...new Set(observed)] as Category[];
  if (options.measurement === 'continuous') {
    if (!numeric) throw new Error('Continuous items require finite numeric values.');
    return { kind: 'continuous', categories: [], reason: 'Set to continuous by the user.' };
  }
  const ordered = options.categories?.length ? options.categories.slice() : numeric ? (unique as number[]).sort((a, b) => a - b) : [];
  if (options.measurement === 'ordinal' || (!numeric && ordered.length)) {
    if (!ordered.length || new Set(ordered).size !== ordered.length || observed.some(v => !ordered.includes(v as Category)))
      throw new Error('Ordered categorical items need a unique category order covering every observed value.');
    return { kind: 'ordinal', categories: ordered, reason: 'Uses the declared category order.' };
  }
  if (!numeric) return { kind: 'nominal', categories: [], reason: 'Text categories need an explicit order for ordinal analysis or imputation.' };
  if (unique.length >= 2 && unique.length <= 20 && observed.length >= 2 * unique.length && observed.every(v => Number.isInteger(v))) {
    if (new Set(ordered).size !== ordered.length || observed.some(v => !ordered.includes(v as Category)))
      throw new Error('The declared category order must cover every observed value without duplicates.');
    return { kind: 'ordinal', categories: ordered, reason: 'Suggested ordered categories: repeated integer values with at most 20 distinct levels. Override if these are continuous measurements.' };
  }
  return { kind: 'continuous', categories: [], reason: 'Suggested continuous: numeric values without a small, repeated integer scale.' };
}

export type ReplacementRule = 'numeric-mean' | 'numeric-median' | 'category-median' | 'nearest-category-mean' | 'nearest-category-mean-rank';
export type ColumnReplacement = MeasurementInference & { value: Category; rule: ReplacementRule };

/** Fit a single replacement to observed fitting values; never inspect held-out rows. */
export function columnReplacement(values: unknown[], method: 'mean' | 'median', options: MeasurementOptions = {}): ColumnReplacement {
  const observed = present(values) as Category[];
  const inferred = inferMeasurement(values, options);
  if (inferred.kind === 'empty') throw new Error('Cannot impute a column with no observed fitting values.');
  if (inferred.kind === 'nominal') throw new Error('Mean and median require numeric values or an explicit ordered category scale.');
  if (inferred.kind === 'ordinal') {
    const categories = inferred.categories;
    const ranks = observed.map(v => categories.indexOf(v)).sort((a, b) => a - b);
    if (method === 'median') return { ...inferred, value: categories[ranks[Math.floor((ranks.length - 1) / 2)]], rule: 'category-median' };
    const numeric = categories.every(v => typeof v === 'number');
    const numbers = numeric ? observed as number[] : ranks;
    const mean = numbers.reduce((sum, v) => sum + v / numbers.length, 0);
    const distance = (i: number) => Math.abs((numeric ? categories[i] as number : i) - mean);
    let best = 0;
    for (let i = 1; i < categories.length; i++) {
      const tolerance = 1e-12 * Math.max(1, Math.abs(mean), distance(best), distance(i));
      if (distance(i) < distance(best) - tolerance) best = i;
    }
    return { ...inferred, value: categories[best], rule: numeric ? 'nearest-category-mean' : 'nearest-category-mean-rank' };
  }
  const sorted = (observed as number[]).slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = method === 'mean' ? sorted.reduce((sum, v) => sum + v / sorted.length, 0)
    : sorted.length % 2 ? sorted[mid] : sorted[mid - 1] / 2 + sorted[mid] / 2;
  return { ...inferred, value, rule: method === 'mean' ? 'numeric-mean' : 'numeric-median' };
}
