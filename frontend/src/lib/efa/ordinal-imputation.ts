import { EfaError, type EfaPreparedData } from './types';
import { columnReplacement } from '../measurement';

/** Complete declared ordinal categories while retaining original support. */
export function completeOrdinalSample(source: EfaPreparedData): EfaPreparedData {
  if (!source.imputation || source.imputation.kind !== 'ordinal')
    throw new EfaError('imputation', 'An ordinal column-imputation policy is required.');
  const n = source.nRows, codes = source.codes.slice(), values: number[] = [], missingCounts: number[] = [],
    means: number[] = [], sds: number[] = [], rules: string[] = [];
  source.items.forEach((item, j) => {
    const original: number[] = [];
    for (let i = 0; i < n; i++) if (source.observed[j * n + i])
      original.push(item.reverse ? item.categories.length - 1 - codes[j * n + i] : codes[j * n + i]);
    if (original.length < 2 || new Set(original).size < 2)
      throw new EfaError('constant', `${item.column} needs at least two observed categories in this fitting sample.`);
    original.sort((a, b) => a - b);
    const missing = n - original.length;
    const filled = columnReplacement(original.map(c => item.categories[c]), source.imputation!.method,
      { measurement: 'ordinal', categories: item.categories });
    const replacement = item.categories.indexOf(filled.value);
    if (replacement < 0) throw new EfaError('ordinal-imputation', 'The replacement must belong to the declared categories.');
    rules.push(filled.rule);
    const code = item.reverse ? item.categories.length - 1 - replacement : replacement;
    values.push(code + 1); missingCounts.push(missing);
    for (let i = 0; i < n; i++) if (!source.observed[j * n + i]) codes[j * n + i] = code;
    let mean = 0, m2 = 0;
    for (let i = 0; i < n; i++) {
      const v = codes[j * n + i] + 1, delta = v - mean;
      mean += delta / (i + 1); m2 += delta * (v - mean);
    }
    means.push(mean); sds.push(Math.sqrt(m2 / (n - 1)));
  });
  return { ...source, codes, means, sds, fingerprint: undefined,
    fittingObserved: new Uint8Array(codes.length).fill(1),
    imputation: { ...source.imputation, values, missingCounts, reverseOffsets: source.items.map(() => null), rules,
      measurements: source.items.map(() => 'ordinal'), categoryValues: source.items.map(item => item.categories.slice()),
      ...(source.imputation.method === 'median' ? { medianRule: 'empirical-lower-category' as const } : {}) },
    diagnostics: [{ code: 'column-imputation', count: missingCounts.reduce((a, b) => a + b, 0),
      message: `Column ${source.imputation.method} imputation on fitting respondents within declared ordinal categories${source.imputation.method === 'median' ? '; empirical lower category median, without averaging categories' : '; mean mapped to the nearest declared category, with ties to the lower ordered category'}. Original observed support is retained.` }],
  };
}
