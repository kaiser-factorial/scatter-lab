import { asNumber, type DataTable } from './table';
import { isIdentifierColumn } from './identifiers';
import type { Category, MeasurementChoice } from './measurement';
import type { MissingStrategy } from './pca';

export const DECOMPOSITION_ADVICE_VERSION = 'decomposition-advice/1';
export type AdviceClassification = 'identifier' | 'empty' | 'constant' | 'invalid' | 'ordinal' | 'ordinal-candidate' | 'continuous' | 'continuous-candidate' | 'nominal';
export type AdvicePatch = { correlation?: 'pearson' | 'polychoric'; extraction?: 'minres' | 'ml' | 'wlsmv'; missing?: MissingStrategy | 'fiml' };
export type AdviceDistribution = {
  assessed: boolean; skewness: number | null; excessKurtosis: number | null;
  skewed: boolean; heavyTailed: boolean; outlierCount: number; outlierRate: number;
};
export type AdviceItem = {
  column: string; classification: AdviceClassification; confirmed: boolean; basis: string;
  observed: number; missing: number; invalid: number; numericStrings: number; unique: number;
  distribution?: AdviceDistribution;
};
export type AdviceIssue = { code: string; severity: 'blocker' | 'review' | 'info'; columns: string[]; message: string };
export type AdviceRecommendation = {
  id: string; title: string; priority: 'primary' | 'alternative' | 'conditional';
  patch: AdvicePatch; assumptions: string[]; reasons: string[];
};
export type DecompositionAdvice = {
  version: typeof DECOMPOSITION_ADVICE_VERSION; method: 'pca' | 'efa'; itemCount: number;
  sample: {
    rows: number; completeRows: number; incompleteRows: number; allMissingRows: number;
    missingCells: number; totalCells: number; missingRate: number;
    minimumObservedPairN: number | null; pairSupportChecked: boolean;
    missingnessPatternCount: number; missingnessPatternsTruncated: boolean;
    missingnessHistogram: { missingItems: number; rows: number }[];
  };
  items: AdviceItem[]; issues: AdviceIssue[]; recommendations: AdviceRecommendation[];
  diagnosticBasis: string[];
};
export type DecompositionAdviceOptions = {
  method?: 'pca' | 'efa'; measurements?: Record<string, MeasurementChoice>;
  orders?: Record<string, Category[]>; missing?: MissingStrategy | 'fiml'; minimumPairN?: number;
};

const shape = (values: number[]): AdviceDistribution => {
  const n = values.length;
  if (n < 20) return { assessed: false, skewness: null, excessKurtosis: null, skewed: false, heavyTailed: false, outlierCount: 0, outlierRate: 0 };
  // Scale before calculating central moments to avoid overflow on large units.
  let magnitude = 0;
  for (const value of values) magnitude = Math.max(magnitude, Math.abs(value));
  const scaled = values.map(value => value / (magnitude || 1));
  const mean = scaled.reduce((sum, value) => sum + value / n, 0);
  let m2 = 0, m3 = 0, m4 = 0;
  for (const value of scaled) { const d = value - mean; m2 += d * d / n; m3 += d ** 3 / n; m4 += d ** 4 / n; }
  const skewness = m2 > 0 ? m3 / m2 ** 1.5 : 0, excessKurtosis = m2 > 0 ? m4 / m2 ** 2 - 3 : 0;
  scaled.sort((a, b) => a - b);
  const quantile = (p: number) => { const at = (n - 1) * p, lo = Math.floor(at); return scaled[lo] + (scaled[Math.ceil(at)] - scaled[lo]) * (at - lo); };
  const q1 = quantile(.25), q3 = quantile(.75), iqr = q3 - q1;
  const outlierCount = scaled.filter(value => value < q1 - 1.5 * iqr || value > q3 + 1.5 * iqr).length;
  return { assessed: true, skewness, excessKurtosis, skewed: Math.abs(skewness) > 1, heavyTailed: excessKurtosis > 3, outlierCount, outlierRate: outlierCount / n };
};
const normalize = (value: unknown): Category | null => {
  if (value == null || (typeof value === 'string' && !value.trim())) return null;
  const numeric = asNumber(value);
  return numeric ?? (typeof value === 'string' ? value : null);
};
const popcount = (value: number) => {
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

/** Pure fitting-sample diagnostics. No fitting, mutation, rows, category values or missingness mechanisms are returned. */
export function analyzeDecompositionItems(table: DataTable, columns: string[], options: DecompositionAdviceOptions = {}): DecompositionAdvice {
  if (!Array.isArray(columns) || !columns.length || columns.length > 500 || new Set(columns).size !== columns.length
    || columns.some(column => typeof column !== 'string' || !table.columns.includes(column) || !Array.isArray(table.data[column]) || table.data[column].length !== table.nRows)
    || !Number.isSafeInteger(table.nRows) || table.nRows < 0)
    throw new Error('Choose 1–500 distinct columns from a valid fitting table.');
  const minimumPairN = options.minimumPairN ?? 0;
  if (!Number.isSafeInteger(minimumPairN) || minimumPairN < 0) throw new Error('The observed-pair support floor must be a nonnegative integer.');
  const method = options.method ?? 'efa', n = table.nRows, p = columns.length, words = Math.ceil(n / 32), rowWords = Math.ceil(p / 32);
  const masks = columns.map(() => new Uint32Array(words)), rowMissing = new Uint16Array(n), patternBits = new Uint32Array(n * rowWords);
  const issues: AdviceIssue[] = [];
  const numericItems = new Set<string>();
  const issue = (code: string, severity: AdviceIssue['severity'], affected: string[], message: string) => issues.push({ code, severity, columns: affected, message });
  if (p < (method === 'pca' ? 2 : 3)) issue('too-few-items', 'blocker', [], method === 'pca' ? 'Select at least two items before fitting PCA.' : 'Select at least three items before fitting EFA; the factor count must also be identified.');
  const items = columns.map((column, j): AdviceItem => {
    const values: Category[] = [], numbers: number[] = [];
    let missing = 0, invalid = 0, numericStrings = 0;
    for (let row = 0; row < n; row++) {
      const raw: unknown = table.data[column]?.[row], value = normalize(raw);
      if (value === null) {
        missing++; rowMissing[row]++; patternBits[row * rowWords + (j >>> 5)] |= 1 << (j & 31);
        if (raw != null && !(typeof raw === 'string' && !raw.trim())) invalid++;
      } else {
        values.push(value); masks[j][row >>> 5] |= 1 << (row & 31);
        if (typeof value === 'number') { numbers.push(value); if (typeof raw === 'string') numericStrings++; }
      }
    }
    const uniqueValues = new Set(values), unique = uniqueValues.size, observed = values.length;
    if (numbers.length === observed) numericItems.add(column);
    const choice = options.measurements?.[column] ?? 'auto', declared = options.orders?.[column];
    let classification: AdviceClassification, confirmed = false, basis: string;
    const ordered = declared?.map(normalize);
    const validOrder = !!ordered?.length && ordered.every(value => value !== null) && new Set(ordered).size === ordered.length && values.every(value => ordered.includes(value));
    if (isIdentifierColumn(column)) { classification = 'identifier'; basis = 'The column name matches the existing identifier convention.'; }
    else if (!observed) { classification = 'empty'; basis = 'No usable observed values in the fitting sample.'; }
    else if (invalid) { classification = 'invalid'; basis = 'Some cells are nonfinite or have an unsupported storage type.'; }
    else if (unique < 2) { classification = 'constant'; basis = 'Only one distinct observed value in the fitting sample.'; }
    else if (!['auto', 'ordinal', 'continuous'].includes(choice) || (declared?.length && !validOrder)) {
      classification = 'invalid'; basis = 'The declared measurement or category order is invalid or does not cover the fitting values.';
    } else if (choice === 'continuous') {
      classification = numbers.length === observed ? 'continuous' : 'invalid';
      confirmed = classification === 'continuous'; basis = confirmed ? 'Continuous treatment was explicitly selected.' : 'Continuous treatment requires numeric cells.';
    } else if (validOrder || choice === 'ordinal') {
      classification = validOrder || numbers.length === observed ? 'ordinal' : 'nominal';
      confirmed = classification === 'ordinal'; basis = confirmed ? 'Ordinal treatment or a covering category order was explicitly supplied.' : 'Text categories require an explicit covering order.';
    } else if (numbers.length !== observed) {
      classification = 'nominal'; basis = 'Unordered or mixed text categories; order and meaning cannot be inferred from their labels.';
    } else if (unique <= 20 && observed >= 2 * unique && numbers.every(Number.isInteger)) {
      classification = 'ordinal-candidate'; basis = 'A small repeated integer scale is a candidate only: it could instead represent counts, labels or rounded measurements. Confirm its meaning and order.';
    } else {
      classification = 'continuous-candidate'; basis = 'Numeric values support continuous treatment as a candidate; numeric appearance does not establish measurement meaning.';
    }
    if (['identifier', 'empty', 'constant', 'invalid', 'nominal'].includes(classification))
      issue(classification, 'blocker', [column], basis);
    if (classification.endsWith('-candidate')) issue('measurement-unconfirmed', 'review', [column], basis);
    if (numericStrings && method === 'efa') issue('numeric-text-storage', 'blocker', [column], 'Finite numeric text was normalized for these diagnostics. Convert the source column to numeric storage before EFA; this analysis did not change any cells.');
    if (method === 'pca' && numbers.length !== observed) issue('pca-nonnumeric', 'blocker', [column], 'PCA requires numeric item values. Declaring a text category order does not define interval spacing or convert the source values.');
    if (validOrder && ordered!.length > unique) issue('unobserved-declared-categories', 'review', [column], 'Some declared categories have no observations in this fitting sample. Ordinal conditional imputation requires observed support for every outcome category.');
    if (classification === 'ordinal' || classification === 'ordinal-candidate') {
      const frequencies = new Map<Category, number>();
      values.forEach(value => frequencies.set(value, (frequencies.get(value) ?? 0) + 1));
      if ([...frequencies.values()].some(count => count < 5)) issue('sparse-categories', 'review', [column], 'Some response categories have fewer than five fitting observations. Sparse marginal categories can destabilize threshold and association estimates; joint category support needs a fitting-time check.');
      if (unique > 50 || (ordered?.length ?? 0) > 50) issue('mice-category-limit', 'review', [column], 'This category count exceeds the implemented ordinal MICE conditional-model limit.');
    }
    return { column, classification, confirmed, basis, observed, missing, invalid, numericStrings, unique,
      ...(numbers.length === observed && observed > 1 ? { distribution: shape(numbers) } : {}) };
  });
  let completeRows = 0, allMissingRows = 0, missingCells = 0, patternsTruncated = false;
  const histogram = new Map<number, number>(), patterns = new Set<string>();
  for (let row = 0; row < n; row++) {
    const missing = rowMissing[row]; if (!missing) completeRows++; if (missing === p) allMissingRows++; missingCells += missing;
    histogram.set(missing, (histogram.get(missing) ?? 0) + 1);
    if (!patternsTruncated) {
      const key = patternBits.subarray(row * rowWords, (row + 1) * rowWords).join(',');
      if (!patterns.has(key) && patterns.size >= 4096) patternsTruncated = true; else patterns.add(key);
    }
  }
  // 500 items × 20,000 rows needs about 78 million inexpensive word operations,
  // rather than 2.5 billion row-pair checks. Larger jobs report unknown support.
  const pairSupportChecked = words * p * (p - 1) / 2 <= 100_000_000;
  let pairMinimum: number | null = pairSupportChecked ? Math.min(n, ...items.map(item => item.observed)) : null;
  if (pairSupportChecked) for (let j = 0; j < p; j++) for (let k = 0; k < j; k++) {
    let count = 0; for (let word = 0; word < words; word++) count += popcount(masks[j][word] & masks[k][word]);
    pairMinimum = Math.min(pairMinimum!, count);
  }
  if (pairMinimum !== null && pairMinimum < Math.max(3, minimumPairN)) issue('insufficient-observed-support', 'blocker', [], 'Some selected items or pairs have insufficient original observed support. Filling cells does not create observed evidence.');
  if (!pairSupportChecked) issue('pair-support-deferred', 'review', [], 'Pair support was not exhaustively checked at this size. The fitting engine must check it before accepting a fit.');
  if (allMissingRows) issue('all-items-missing', 'review', [], 'Some respondents have no observed selected items; they contribute no information to an observed-data likelihood.');
  const ordinal = items.filter(item => item.classification === 'ordinal' || item.classification === 'ordinal-candidate');
  const continuous = items.filter(item => item.classification === 'continuous' || item.classification === 'continuous-candidate');
  const mixed = ordinal.length > 0 && continuous.length > 0;
  if (mixed) issue('mixed-measurement', 'review', [], 'Selected items mix ordinal and continuous treatment. A mixed polychoric/polyserial correlation model is not implemented; treating all numeric items with Pearson requires an explicit spacing assumption.');
  if (mixed && numericItems.size !== p) issue('mixed-text-measurement', 'blocker', [], 'The mixed item set includes ordered text. Pearson requires numeric item values, and the app does not implement a mixed ordinal/continuous polyserial model. An order alone does not convert text to numeric spacing.');
  const recommendations: AdviceRecommendation[] = [];
  const add = (id: string, title: string, priority: AdviceRecommendation['priority'], patch: AdvicePatch, reasons: string[], assumptions: string[] = []) => {
    const compatible = { ...patch };
    if (patch.extraction && patch.extraction !== 'ml' && options.missing === 'fiml' && !patch.missing)
      compatible.missing = hasMissing ? 'pairwise' : 'complete';
    if (patch.extraction && options.missing === 'mice' && ordinal.length < p && !patch.missing)
      compatible.missing = hasMissing ? 'pairwise' : 'complete';
    recommendations.push({ id, title, priority, patch: compatible, reasons, assumptions });
  };
  const blockers = issues.some(item => item.severity === 'blocker');
  const distributionConcern = continuous.some(item => item.distribution?.skewed || item.distribution?.heavyTailed);
  const shapesAssessed = continuous.length > 0 && continuous.every(item => item.distribution?.assessed);
  const hasMissing = missingCells > 0;
  const miceSupported = ordinal.length === p && !issues.some(item => item.code === 'mice-category-limit' || item.code === 'unobserved-declared-categories');
  if (!blockers && method === 'pca') {
    add('pca-numeric', 'PCA of the numeric item values', 'primary', {}, ['PCA summarizes total numeric variance; there is no separate EFA extraction or rotation choice.'], ordinal.length ? ['Numeric category spacing must be meaningful for this PCA; an ordinal common-factor analysis is an alternative.'] : []);
    if (hasMissing) {
      add('pca-iterative', 'Iterative PCA completion', 'conditional', { missing: 'iterative' }, ['Uses relationships among items in a regularized low-rank reconstruction.'], ['A low-rank numeric model must be a reasonable completion model; this is a single completion without imputation-uncertainty propagation.']);
      if (miceSupported) add('pca-mice', 'Separate ordinal MICE fits', 'alternative', { missing: 'mice' }, ['Retains distinct completed fits instead of averaging their axes.'], ['Confirm all category meanings and their order; the current implementation does not pool inference.']);
    }
  } else if (!blockers && !mixed && ordinal.length === p) {
    const assumptions = ['Confirm that the categories are ordered responses, including direction and any special missing codes.', 'Polychoric correlations use a latent threshold model; adequate category and pair support still needs fitting-time review.'];
    add('ordinal-minres', 'Polychoric correlations + MINRES', 'primary', { correlation: 'polychoric', extraction: 'minres' }, ['An exploratory common-factor model that respects ordered response categories.'], assumptions);
    add('ordinal-wlsmv', 'Polychoric correlations + WLSMV', 'alternative', { correlation: 'polychoric', extraction: 'wlsmv' }, ['Adds the available weighted estimation, rotated standard errors and adjusted test.'], [...assumptions, 'Sparse category combinations and computational cost can limit weighted inference.']);
    if (hasMissing && miceSupported) add('ordinal-mice', 'Separate ordinal MICE fits', 'conditional', { correlation: 'polychoric', extraction: 'minres', missing: 'mice' }, ['Models missing ordinal responses using selected predictors.'], ['The conditional models and missing-at-random assumption require substantive justification; observed patterns cannot establish them.', 'Separate fits are provided without Rubin-pooled inference.']);
  } else if (!blockers && continuous.length === p) {
    const mlPatch: AdvicePatch = { correlation: 'pearson', extraction: 'ml', missing: hasMissing ? 'fiml' : 'complete' };
    const mlAssumptions = ['A joint Gaussian factor model is appropriate; univariate shape diagnostics cannot establish multivariate normality.', ...(hasMissing ? ['Ignorable missingness (including MAR given modeled information) must be justified separately; these diagnostics do not infer MAR or MCAR.', 'FIML estimates from observed cells and does not impute the dataset.'] : [])];
    if (distributionConcern || !shapesAssessed) {
      add('numeric-minres', 'Pearson correlations + MINRES', 'primary', { correlation: 'pearson', extraction: 'minres' }, [distributionConcern ? 'Some item distributions are strongly skewed or heavy-tailed on the stated descriptive rules.' : 'There is insufficient per-item information for the descriptive shape screen.'], ['Pearson/MINRES remains sensitive to outliers; this is not a robust-covariance estimator.']);
      add('numeric-ml', hasMissing ? 'Gaussian ML + FIML, conditional on assumptions' : 'Gaussian ML, conditional on assumptions', 'conditional', mlPatch, ['A supported likelihood-model alternative, rather than a normality conclusion from the profiles.'], mlAssumptions);
    } else {
      add('numeric-ml', hasMissing ? 'Gaussian ML + FIML candidate' : 'Pearson correlations + Gaussian ML candidate', 'primary', mlPatch, ['No strong univariate skew/tail flag was triggered; this leaves Gaussian ML as a candidate.'], mlAssumptions);
      add('numeric-minres', 'Pearson correlations + MINRES', 'alternative', { correlation: 'pearson', extraction: 'minres' }, ['Fits shared associations without choosing the Gaussian likelihood objective.'], ['MINRES is not an outlier-robust covariance procedure.']);
    }
  } else if (!blockers && mixed) {
    add('mixed-pearson', 'Pearson + MINRES with explicit numeric spacing', 'conditional', { correlation: 'pearson', extraction: 'minres' }, ['This is the available common numeric treatment for mixed selected items.'], ['Accept treating ordinal numeric codes as interval-like values; the app does not implement mixed polyserial correlations.', 'Item measurement settings are preserved, and this option does not relabel ordinal items as continuous.']);
  }
  if (!blockers && hasMissing) {
    if (completeRows >= Math.max(3, minimumPairN)) add('complete-cases', 'Complete cases as a sensitivity comparison', 'alternative', { missing: 'complete' }, ['The report shows how many fitting respondents would be retained and dropped.'], ['Deleting incomplete respondents can change the target population and introduce selection bias; a low missing rate does not establish unbiasedness.']);
    if (method === 'pca' || ordinal.length === p || continuous.length === p) add('median-preview', 'Column median for a quick exploratory completion', 'conditional', { missing: 'median' }, ['Uses an in-category median for ordered items and a numeric median for continuous items.'], ['Single-value fills can shrink variance and distort associations; they do not propagate completion uncertainty.']);
  }
  const groupedIssues = new Map<string, AdviceIssue>();
  for (const entry of issues) {
    const key = `${entry.code}\u0000${entry.severity}\u0000${entry.message}`, previous = groupedIssues.get(key);
    if (previous) previous.columns.push(...entry.columns); else groupedIssues.set(key, { ...entry, columns: entry.columns.slice() });
  }
  return { version: DECOMPOSITION_ADVICE_VERSION, method, itemCount: p, items, issues: [...groupedIssues.values()], recommendations,
    sample: { rows: n, completeRows, incompleteRows: n - completeRows, allMissingRows, missingCells, totalCells: n * p,
      missingRate: n ? missingCells / (n * p) : 0, minimumObservedPairN: pairMinimum, pairSupportChecked,
      missingnessPatternCount: patterns.size, missingnessPatternsTruncated: patternsTruncated,
      missingnessHistogram: [...histogram].sort(([a], [b]) => a - b).map(([missingItems, rows]) => ({ missingItems, rows })) },
    diagnosticBasis: [
      'Only the supplied fitting table and selected items are inspected. The host owns dataset, filter and partition identity.',
      'Numeric strings use the shared asNumber conversion for diagnostics; source data are never changed.',
      'Measurement meaning and order are confirmed only by explicit item settings or a declared covering order. Repeated integer values alone are not confirmation.',
      'Descriptive shape screen uses at least 20 observed values, moment skewness |g1| > 1, excess kurtosis g2 > 3, and Tukey 1.5-IQR fences with type-7 quartiles. These are heuristics, not normality tests.',
      'Univariate shape does not establish joint Gaussian assumptions. Observed missingness patterns cannot determine MCAR, MAR or MNAR.',
      'Missingness pattern counts are capped at 4096 distinct masks and marked as a lower bound when truncated. Pair support is exact when checked and explicitly unknown otherwise.',
      'Applying a proposal changes only its displayed method parameters. It never confirms item types, changes source values, or runs an analysis.',
    ] };
}

export type AdviceCount = number | 'withheld';
export type AdviceAssistantItem = Omit<AdviceItem, 'classification' | 'observed' | 'missing' | 'invalid' | 'numericStrings' | 'distribution'> & {
  classification: AdviceClassification | 'withheld'; observed: AdviceCount; missing: AdviceCount;
  invalid: AdviceCount; numericStrings: AdviceCount;
  distribution?: Omit<AdviceDistribution, 'outlierCount' | 'outlierRate'> & { outlierCount: AdviceCount; outlierRate: number | null };
};
export type AdviceAssistantReport = {
  version: typeof DECOMPOSITION_ADVICE_VERSION; method: 'pca' | 'efa'; withheld: boolean; itemCount: number;
  sample: {
    rows: AdviceCount; completeRows: AdviceCount; incompleteRows: AdviceCount; allMissingRows: AdviceCount;
    missingCells: AdviceCount; totalCells: AdviceCount; missingRate: number | null;
    minimumObservedPairN: AdviceCount | null; pairSupportChecked: boolean;
    missingnessPatternCount: AdviceCount; missingnessPatternsTruncated: boolean;
    missingnessHistogram: { missingItems: number; rows: number }[]; histogramWithheld: boolean;
  };
  items: AdviceAssistantItem[]; offset: number; nextOffset: number | null;
  issues: AdviceIssue[]; recommendations: AdviceRecommendation[]; diagnosticBasis: string[];
};

/** Bounded assistant projection. No values, category labels, masks, row indices or arbitrary source prose. */
export function adviceForAssistant(report: DecompositionAdvice, minimumCount = 5, offset = 0, limit = 20): AdviceAssistantReport {
  if (!Number.isSafeInteger(minimumCount) || minimumCount < 0 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20)
    throw new Error('Use a nonnegative disclosure floor and offset, and a page size from one to twenty.');
  const rare = (n: number) => n > 0 && n < minimumCount;
  const count = (n: number): AdviceCount => rare(n) ? 'withheld' : n;
  const s = report.sample, withheld = s.rows < minimumCount;
  const itemPartitionWithheld = report.items.some(item => rare(item.observed) || rare(item.missing));
  const rowPartitionWithheld = rare(s.completeRows) || rare(s.incompleteRows) || rare(s.allMissingRows);
  const histogramWithheld = withheld || itemPartitionWithheld || s.missingnessHistogram.some(bin => rare(bin.rows));
  const items: AdviceAssistantItem[] = withheld ? [] : report.items.slice(offset, offset + limit).map(item => {
    const insufficient = item.observed < minimumCount;
    const countsWithheld = insufficient || rare(item.observed) || rare(item.missing);
    const distribution = !insufficient && item.distribution ? {
      assessed: item.distribution.assessed, skewness: item.distribution.skewness, excessKurtosis: item.distribution.excessKurtosis,
      skewed: item.distribution.skewed, heavyTailed: item.distribution.heavyTailed,
      outlierCount: count(item.distribution.outlierCount), outlierRate: rare(item.distribution.outlierCount) ? null : item.distribution.outlierRate,
    } : undefined;
    return { column: item.column, classification: insufficient ? 'withheld' : item.classification,
      confirmed: !insufficient && item.confirmed, basis: insufficient ? 'Insufficient observed support for an assistant item profile.' : item.basis,
      observed: countsWithheld ? 'withheld' : item.observed, missing: countsWithheld ? 'withheld' : item.missing,
      invalid: insufficient ? 'withheld' : count(item.invalid), numericStrings: insufficient ? 'withheld' : count(item.numericStrings),
      unique: insufficient ? 0 : item.unique, ...(distribution ? { distribution } : {}) };
  });
  return { version: report.version, method: report.method, withheld, itemCount: report.itemCount,
    sample: { rows: withheld ? 'withheld' : s.rows,
      completeRows: withheld || rowPartitionWithheld ? 'withheld' : s.completeRows,
      incompleteRows: withheld || rowPartitionWithheld ? 'withheld' : s.incompleteRows,
      allMissingRows: withheld || rowPartitionWithheld ? 'withheld' : s.allMissingRows,
      missingCells: withheld || itemPartitionWithheld ? 'withheld' : count(s.missingCells), totalCells: withheld ? 'withheld' : s.totalCells,
      missingRate: withheld || itemPartitionWithheld || rare(s.missingCells) ? null : s.missingRate,
      minimumObservedPairN: withheld ? 'withheld' : s.minimumObservedPairN === null ? null : count(s.minimumObservedPairN),
      pairSupportChecked: !withheld && s.pairSupportChecked,
      missingnessPatternCount: withheld ? 'withheld' : count(s.missingnessPatternCount), missingnessPatternsTruncated: s.missingnessPatternsTruncated,
      missingnessHistogram: histogramWithheld ? [] : s.missingnessHistogram.map(bin => ({ ...bin })), histogramWithheld },
    items, offset, nextOffset: !withheld && offset + items.length < report.items.length ? offset + items.length : null,
    issues: withheld ? [{ code: 'privacy', severity: 'blocker', columns: [], message: 'The fitting sample is below the assistant aggregate floor.' }]
      : report.issues.slice(0, 40).map(issue => ({ ...issue, columns: issue.columns.slice(0, 20) })),
    recommendations: withheld ? [] : report.recommendations.map(rec => ({ ...rec, patch: { ...rec.patch }, reasons: rec.reasons.slice(), assumptions: rec.assumptions.slice() })),
    diagnosticBasis: report.diagnosticBasis.slice() };
}
