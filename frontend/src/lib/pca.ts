import { DataTable, asNumber, median, numericValues } from './table';
import { columnReplacement, type MeasurementChoice, type ReplacementRule } from './measurement';

// In-browser PCA: missing-value handling → (optional) standardization → covariance/
// correlation matrix → Jacobi eigendecomposition → scores + loadings.
// Equivalent to sklearn's PCA on standardized data, up to component sign;
// signs are fixed so each component's largest-|loading| variable is positive.

export type PCAResult = {
  table: DataTable;                       // input table + score columns (see `columns`)
  columns: string[];                      // names of the score columns this run added
  replaced: string[];                     // columns of a previous same-label run this one replaced
  label: string;                          // sanitized run label ('' = the unnamed run)
  loadings: Record<string, { var: string; loading: number }[]>; // per score column, sorted by |loading|
  varianceExplained: number[];            // fraction per KEPT component
  /** Variance fraction for every component, kept or not — the full scree (B4). */
  spectrum: number[];
  /** Eigenvalues for every component, for the Kaiser > 1 rule (B4). */
  eigenvalues: number[];
  cumulative: number[];
  variables: string[];
  k: number;
  /**
   * What happened to the incomplete rows. Reported because both strategies
   * change the answer: median imputation shrinks variance and attenuates
   * correlations in proportion to how much was filled in, while complete-case
   * changes n and can bias the sample if missingness is not random.
   * "we impute" is a disclaimer; "we imputed 47 of 1,800 cells" is a disclosure
   * the reader can act on.
   */
  missing: MissingReport;
};

export type MissingStrategy = 'mean' | 'median' | 'complete' | 'pairwise' | 'iterative' | 'mice';

export type PCAOptions = {
  k?: number;
  standardize?: boolean;
  label?: string;
  missing?: MissingStrategy;
  /** Caller-controlled aggregate floor; pairwise PCA always needs at least 2. */
  minimumPairN?: number;
  measurements?: Record<string, MeasurementChoice>;
};

export type MissingReport = {
  strategy: MissingStrategy;
  /** Cells filled in by imputation. Always 0 under complete-case or pairwise deletion. */
  imputedCells: number;
  totalCells: number;
  /** Rows missing at least one value, per variable, worst first. */
  byVariable: { var: string; n: number }[];
  /** Rows the decomposition actually used. */
  rowsUsed: number;
  /** Rows without fitting information: incomplete rows for complete-case, wholly missing rows for pairwise. */
  rowsDropped: number;
  /** Iterative imputation only: how long it ran and whether it settled. */
  iterations?: number;
  converged?: boolean;
  /** Pairwise support varies by covariance/correlation entry; no cells are filled. */
  pairCounts?: number[][];
  /** Pairwise fits only score respondents complete on the selected items. */
  rowsScored?: number;
  /** A selected fit from an explicitly separate MICE batch, one-based. */
  imputation?: number;
  imputations?: number;
  seed?: number;
  fillRules?: { variable: string; measurement: 'ordinal' | 'continuous'; rule: ReplacementRule; value: number }[];
};

/**
 * Is this column a PCA score column?
 *
 * One predicate, because there were three and they disagreed: case-sensitive
 * `/^PC\d+(_|$)/` in the PCA panel, case-INsensitive in `suggestStandardize`,
 * and an exact `['PC1','PC2','PC3']` membership test in `pickDefaultAxes`. A
 * file with lowercase `pc1`/`pc2` was therefore treated as PC scores by the
 * clustering heuristic (standardize off) while simultaneously being offered as
 * raw PCA input by the panel (finding E2).
 *
 * Case-insensitive is the right resolution: a components file written by R or
 * SPSS may use either case, and nothing downstream cares which.
 */
export const isPCColumn = (name: string): boolean => /^PC\d+(_|$)/i.test(name);

/** The bare PC1..PC3 a components-file projection creates, in order. */
export const BASE_PC_COLUMNS = ['PC1', 'PC2', 'PC3'];

// Run labels become column-name fragments — keep them word-shaped
export const sanitizeLabel = (s: string): string =>
  s.trim().replace(/\s+/g, '_').replace(/[^\w-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');

// Suggest a run label from the selected variable names: the shared prefix or
// suffix once counters are stripped (openness_1..openness_5 → "openness",
// Q1_Need..Q5_Need → "Need"). Returns null when nothing at least two
// characters long is shared — mixed subsets (O1..O5 + N1..N5) on purpose
// yield null so the user (or the assistant) names the run deliberately.
export const deriveRunLabel = (names: string[]): string | null => {
  if (names.length < 2) return null;
  const shared = (get: (s: string, i: number) => string, len: (s: string) => number) => {
    const n = Math.min(...names.map(len));
    let out = '';
    for (let i = 0; i < n; i++) {
      const ch = get(names[0], i);
      if (!names.every(nm => get(nm, i) === ch)) break;
      out += ch;
    }
    return out;
  };
  const prefix = shared((s, i) => s[i], s => s.length).replace(/[\d_\-\s]+$/g, '');
  const suffix = shared((s, i) => s[s.length - 1 - i], s => s.length)
    .split('').reverse().join('').replace(/^[\d_\-\s]+/g, '');
  const best = (suffix.length > prefix.length ? suffix : prefix);
  const clean = sanitizeLabel(best);
  return clean.length >= 2 ? clean : null;
};

// The column names a run owns: COMP_<label> for a single kept component (a
// composite score), PC1_<label>.. for a labeled set, bare PC1.. when unnamed.
export const pcaColumnNames = (label: string, k: number): string[] => {
  if (label && k === 1) return [`COMP_${label}`];
  return Array.from({ length: k }, (_, c) => (label ? `PC${c + 1}_${label}` : `PC${c + 1}`));
};

// Which existing columns a (re-)run of `label` replaces. Covers both shapes
// (COMP_x and PCn_x) so relabeling k between runs never strands columns.
const ownedByLabel = (label: string) => {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return label
    ? new RegExp(`^(PC\\d+_${esc}|COMP_${esc})$`)
    : /^PC\d+$/;
};

// Jacobi eigenvalue iteration for symmetric matrices. Rock-solid for the
// p×p (p ≤ ~200) matrices survey data produces.
const jacobiEigen = (A: number[][]): { values: number[]; vectors: number[][] } => {
  const n = A.length;
  const a = A.map(row => row.slice());
  // V starts as identity; columns accumulate the eigenvectors
  const V: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));

  // Convergence is measured RELATIVE to the matrix's own scale. The absolute
  // `sqrt(off) < 1e-12` this replaces is unreachable for a covariance PCA on
  // large-magnitude columns — income in dollars, reaction times in
  // milliseconds — so those runs burned all 100 sweeps every time, which at
  // p ≈ 200 is on the order of 10⁹ operations on the main thread for a result
  // that had converged in a handful (finding A13). Results were correct, just
  // paid for many times over.
  let scale = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) scale += a[i][j] * a[i][j];
  const tolerance = Math.max(Math.sqrt(scale) * 1e-14, Number.MIN_VALUE);

  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
    if (Math.sqrt(off) <= tolerance) break;

    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-15) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }

  // sort by eigenvalue descending
  const order = Array.from({ length: n }, (_, i) => i)
    .sort((i, j) => a[j][j] - a[i][i]);
  return {
    values: order.map(i => a[i][i]),
    vectors: order.map(i => V.map(row => row[i])), // vectors[c] = c-th eigenvector
  };
};

// Regularized iterative PCA imputation (Josse & Husson 2012; the method behind
// R's missMDA::imputePCA). Where median imputation ignores the correlation
// structure entirely — it fills every gap in a variable with the same number —
// this reconstructs each missing cell from the low-rank structure of the other
// variables, iterating until the fill stops moving:
//
//   1. start from the column mean
//   2. PCA the completed matrix, keep `rank` components
//   3. rebuild the matrix from those components
//   4. overwrite ONLY the missing cells with the rebuilt values; observed data
//      is never altered
//   5. repeat from 2 until the imputed values stop changing
//
// The regularization matters and is not optional: plain iterative PCA fits the
// noise in the observed cells and drifts, especially with many components or
// heavy missingness. Each component's contribution is shrunk by
// (lambda_s - sigma^2)/lambda_s, where sigma^2 is the mean of the discarded
// eigenvalues — an estimate of residual noise. A component barely above the
// noise floor is therefore damped towards zero rather than trusted.
//
// Honest limits, restated for the user in disclosures.ts: `rank` is taken from
// the number of components being kept rather than chosen by cross-validation
// (missMDA's estim_ncpPCA), and this is single imputation, so downstream
// results ignore the uncertainty in the filled values and standard errors are
// optimistic. It is a better point estimate, not a substitute for a model of
// the missingness.
export const imputeIterativePCA = (
  cols: (number | null)[][],
  opts: { rank?: number; standardize?: boolean; maxIter?: number; tol?: number } = {},
): { columns: number[][]; iterations: number; converged: boolean; rank: number } => {
  const p = cols.length;
  const n = cols[0]?.length ?? 0;
  const standardize = opts.standardize ?? true;
  const maxIter = opts.maxIter ?? 200;
  const tol = opts.tol ?? 1e-8;
  // At least one discarded component is required, or sigma^2 has nothing to
  // estimate from and the fit is unregularized.
  const rank = Math.max(1, Math.min(opts.rank ?? 2, p - 1));

  const observed: boolean[][] = cols.map(c =>
    Array.from({ length: n }, (_, i) => typeof c[i] === 'number' && Number.isFinite(c[i] as number)));

  // Start from the column mean of the observed values.
  const X: number[][] = Array.from({ length: n }, () => new Array(p).fill(0));
  for (let j = 0; j < p; j++) {
    let sum = 0, cnt = 0;
    for (let i = 0; i < n; i++) if (observed[j][i]) { sum += cols[j][i] as number; cnt++; }
    const mean0 = cnt ? sum / cnt : 0;
    for (let i = 0; i < n; i++) X[i][j] = observed[j][i] ? (cols[j][i] as number) : mean0;
  }

  const anyMissing = observed.some(c => c.some(o => !o));
  if (!anyMissing || n < 3) return { columns: transpose(X, n, p), iterations: 0, converged: true, rank };

  let iterations = 0, converged = false;
  for (let it = 1; it <= maxIter; it++) {
    iterations = it;
    // Centre and (optionally) scale using the CURRENT completed matrix — the
    // moments move as the fill changes, which is why this is inside the loop.
    const mu = new Array(p).fill(0), sd = new Array(p).fill(1);
    for (let j = 0; j < p; j++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += X[i][j];
      mu[j] = sum / n;
      let sq = 0;
      for (let i = 0; i < n; i++) sq += (X[i][j] - mu[j]) ** 2;
      const s = Math.sqrt(sq / n);
      sd[j] = standardize ? (s || 1) : 1;
    }
    const Z: number[][] = Array.from({ length: n }, (_, i) =>
      Array.from({ length: p }, (_, j) => (X[i][j] - mu[j]) / sd[j]));

    const C: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let a = 0; a < p; a++) {
      for (let b = a; b < p; b++) {
        let acc = 0;
        for (let i = 0; i < n; i++) acc += Z[i][a] * Z[i][b];
        C[a][b] = C[b][a] = acc / n;
      }
    }
    const { values, vectors } = jacobiEigen(C);

    // sigma^2: mean of the eigenvalues we are throwing away = residual noise.
    let tail = 0;
    for (let s = rank; s < p; s++) tail += Math.max(values[s], 0);
    const sigma2 = tail / (p - rank);

    // Rank-`rank` reconstruction with each component shrunk toward zero in
    // proportion to how close its eigenvalue sits to the noise floor.
    const recon: number[][] = Array.from({ length: n }, () => new Array(p).fill(0));
    for (let s = 0; s < rank; s++) {
      const lam = Math.max(values[s], 0);
      const shrink = lam > 0 ? Math.max(0, (lam - sigma2) / lam) : 0;
      if (shrink === 0) continue;
      const v = vectors[s];
      for (let i = 0; i < n; i++) {
        let score = 0;
        for (let j = 0; j < p; j++) score += Z[i][j] * v[j];
        const f = score * shrink;
        for (let j = 0; j < p; j++) recon[i][j] += f * v[j];
      }
    }

    // Replace ONLY the missing cells; observed values are never touched.
    let delta = 0, scale = 0;
    for (let j = 0; j < p; j++) {
      for (let i = 0; i < n; i++) {
        if (observed[j][i]) continue;
        const next = recon[i][j] * sd[j] + mu[j];
        delta += (next - X[i][j]) ** 2;
        scale += next ** 2;
        X[i][j] = next;
      }
    }
    if (delta <= tol * Math.max(scale, 1e-12)) { converged = true; break; }
  }

  return { columns: transpose(X, n, p), iterations, converged, rank };
};

const transpose = (X: number[][], n: number, p: number): number[][] =>
  Array.from({ length: p }, (_, j) => Array.from({ length: n }, (_, i) => X[i][j]));

/** Each pair uses its own observed respondents, means and (for correlations)
 * standard deviations. The scoring scale uses each column's observed sample. */
export function pairwisePcaMatrix(
  columns: (number | null)[][],
  names: string[],
  standardize: boolean,
  minimumPairN = 2,
) {
  if (!Number.isSafeInteger(minimumPairN) || minimumPairN < 2)
    throw new Error('Pairwise PCA needs an observed-pair floor of at least two.');
  const p = columns.length, n = columns[0]?.length ?? 0;
  const matrix = Array.from({ length: p }, () => Array(p).fill(0) as number[]);
  const counts = Array.from({ length: p }, () => Array(p).fill(0) as number[]);
  const means = Array(p).fill(0) as number[], sds = Array(p).fill(0) as number[];
  for (let i = 0; i < p; i++) {
    for (let j = i; j < p; j++) {
      let count = 0, mx = 0, my = 0, xx = 0, yy = 0, xy = 0;
      for (let r = 0; r < n; r++) {
        const x = columns[i][r], y = columns[j][r];
        if (x === null || y === null) continue;
        count++;
        const dx = x - mx, dy = y - my;
        mx += dx / count; my += dy / count;
        xx += dx * (x - mx); yy += dy * (y - my); xy += dx * (y - my);
      }
      if (count < minimumPairN) throw new Error(`Too few observed responses for pair "${names[i]}" / "${names[j]}". Choose another missing-value method or revise the item selection.`);
      if (standardize && (xx <= 0 || yy <= 0)) throw new Error(`"${names[i]}" or "${names[j]}" is constant on their shared observed rows. Pairwise correlation is undefined.`);
      const value = standardize ? i === j ? 1 : Math.max(-1, Math.min(1, xy / Math.sqrt(xx) / Math.sqrt(yy))) : xy / count;
      if (!Number.isFinite(value)) throw new Error('Pairwise covariance/correlation exceeded the supported numeric range.');
      matrix[i][j] = matrix[j][i] = value;
      counts[i][j] = counts[j][i] = count;
      if (i === j) { means[i] = mx; sds[i] = Math.sqrt(xx / count); }
    }
  }
  return { matrix, counts, means, sds };
}

export const runPCA = (
  table: DataTable,
  variables: string[],
  opts: PCAOptions = {},
): PCAResult => {
  const standardize = opts.standardize ?? true;
  const strategy: MissingStrategy = opts.missing ?? 'median';
  if (strategy === 'mice') throw new Error('MICE produces separate PCA fits. Use the MICE batch workflow and choose a completed fit before adding scores.');
  if (!['mean', 'median', 'complete', 'pairwise', 'iterative'].includes(strategy)) throw new Error('Unsupported PCA missing-value method.');
  const label = sanitizeLabel(opts.label ?? '');
  const p = variables.length;
  if (p < 2) throw new Error('Pick at least two numeric variables for a PCA.');
  const n = table.nRows;
  if (n < 3) throw new Error('Too few rows for a PCA.');
  // k = 1 is legitimate: it keeps only the first component, the composite-score
  // workflow (run per item subset, keep the top PC of each as a named score).
  //
  // Clamped to the RANK, min(p, n-1), not just to p. With n = 3 and p = 5 the
  // covariance matrix has rank 2, so components 3 to 5 have numerically-zero
  // eigenvalues and their scores are floating-point noise — but they were
  // produced, plotted and reported with a variance-explained figure like any
  // other (finding A10).
  const maxRank = Math.max(1, Math.min(p, n - 1));
  const k = Math.max(1, Math.min(opts.k ?? 3, maxRank));

  // Coerce the fitting rows once: null marks "not observed as a number".
  // Cells outside the declared table membership cannot affect the fill values.
  const cols: (number | null)[][] = variables.map(v =>
    Array.from({ length: n }, (_, i) => asNumber(table.data[v]?.[i])));
  const missingByVar: { var: string; n: number }[] = [];
  cols.forEach((col, j) => {
    const have = numericValues(col).length;
    if (have === 0) throw new Error(`"${variables[j]}" has no numeric values.`);
    // Rows past the end of a short column count as missing too.
    if (have < n) missingByVar.push({ var: variables[j], n: n - have });
  });

  // Which rows the decomposition runs on. Complete-case keeps only rows with no
  // gap in ANY selected variable, so adding a poorly-covered variable can drop a
  // lot of rows at once — hence rowsDropped is reported, not just inferred.
  // Iterative imputation reconstructs the gaps from the low-rank structure
  // before any of the decomposition below runs; it fills every row, so the row
  // set is the same as median's.
  const iterative = strategy === 'iterative'
    ? imputeIterativePCA(cols, { rank: k, standardize })
    : null;

  const rows: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!['complete', 'pairwise'].includes(strategy) || cols.every(c => typeof c[i] === 'number')) rows.push(i);
  }
  if (strategy === 'complete' && rows.length < 3) {
    throw new Error(
      `Complete-case analysis leaves only ${rows.length} row${rows.length === 1 ? '' : 's'} with no missing values across these ${p} variables — too few for a PCA. Use median imputation, or drop the variables with the most missing data.`
    );
  }
  const m = rows.length;
  const pairwise = strategy === 'pairwise'
    ? pairwisePcaMatrix(cols, variables, standardize, opts.minimumPairN)
    : null;

  // centre, optionally scale (population sd, sklearn-style)
  const X: number[][] = Array.from({ length: m }, () => new Array(p));
  const fillRules: NonNullable<MissingReport['fillRules']> = [];
  for (let j = 0; j < p; j++) {
    const col = cols[j];
    // Column fills use only observed fitting values and never alter input cells.
    // Under complete-case the fill is never consulted.
    const observed = numericValues(col);
    const replacement = strategy === 'mean' || strategy === 'median'
      ? columnReplacement(observed, strategy, { measurement: opts.measurements?.[variables[j]] ?? 'auto' })
      : null;
    const fill = replacement ? replacement.value as number : median(observed);
    if (replacement) fillRules.push({ variable: variables[j], measurement: replacement.kind as 'ordinal' | 'continuous', rule: replacement.rule, value: fill });
    const filled = iterative?.columns[j];
    let sum = 0;
    for (let r = 0; r < m; r++) {
      const v = filled ? filled[rows[r]] : (col[rows[r]] ?? fill);
      X[r][j] = v;
      sum += v;
    }
    const mean = pairwise ? pairwise.means[j] : sum / m;
    let sq = 0;
    for (let r = 0; r < m; r++) sq += (X[r][j] - mean) ** 2;
    const sd = pairwise ? pairwise.sds[j] : Math.sqrt(sq / m);
    if (!Number.isFinite(mean) || !Number.isFinite(sd)) throw new Error(`"${variables[j]}" exceeds the supported numeric range for PCA. Rescale this item before fitting.`);
    if (standardize && sd === 0) throw new Error(`"${variables[j]}" is constant${strategy === 'complete' ? ' across the complete cases' : ''} — drop it or turn off standardization.`);
    const div = standardize ? sd : 1;
    for (let r = 0; r < m; r++) X[r][j] = (X[r][j] - mean) / div;
  }

  // covariance (= correlation when standardized) matrix
  const C: number[][] = pairwise?.matrix ?? Array.from({ length: p }, () => new Array(p).fill(0));
  for (let i = 0; !pairwise && i < p; i++) {
    for (let j = i; j < p; j++) {
      let s = 0;
      for (let r = 0; r < m; r++) s += X[r][i] * X[r][j];
      C[i][j] = C[j][i] = s / m;
    }
  }

  const { values, vectors } = jacobiEigen(C);
  if (pairwise && values.some(v => !Number.isFinite(v) || v < -1e-10 * Math.max(1, ...C.map((row, i) => Math.abs(row[i]))) * p))
    throw new Error('Pairwise deletion produced a covariance/correlation matrix that is not positive semidefinite. Use complete cases or an explicit imputation method; the matrix was not smoothed.');
  const total = values.reduce((s, v) => s + Math.max(v, 0), 0) || 1;

  // deterministic signs: largest-|loading| variable positive per component
  const comps = vectors.slice(0, k).map(vec => {
    let maxIdx = 0;
    for (let j = 1; j < p; j++) if (Math.abs(vec[j]) > Math.abs(vec[maxIdx])) maxIdx = j;
    return vec[maxIdx] < 0 ? vec.map(v => -v) : vec;
  });

  // scores: X̃ · component, written back at the ORIGINAL row positions so the
  // columnar table keeps its shape. Incomplete rows under complete-case/pairwise get null
  // rather than a fabricated score — they are genuinely unscored.
  const scoreCols: (number | null)[][] = comps.map(vec => {
    const col = new Array<number | null>(n).fill(null);
    for (let r = 0; r < m; r++) {
      let s = 0;
      for (let j = 0; j < p; j++) s += X[r][j] * vec[j];
      col[rows[r]] = s;
    }
    return col;
  });

  // Replacement is scoped to THIS run's identity: a re-run of "openness"
  // replaces only the openness columns; other labeled runs and the bare
  // PC1..PCk set coexist untouched. (Replacing everything matching ^PC\d+$
  // was the old behavior, and it silently ate earlier subset runs.)
  const owned = ownedByLabel(label);
  const pcNames = pcaColumnNames(label, k);
  const replaced = table.columns.filter(c => owned.test(c));
  const newTable: DataTable = {
    columns: [...table.columns.filter(c => !owned.test(c)), ...pcNames],
    data: {
      ...Object.fromEntries(Object.entries(table.data).filter(([c]) => !owned.test(c))),
      ...Object.fromEntries(pcNames.map((name, c) => [name, scoreCols[c]])),
    },
    nRows: n,
  };

  const loadings: PCAResult['loadings'] = {};
  comps.forEach((vec, c) => {
    loadings[pcNames[c]] = variables
      .map((v, j) => ({ var: v, loading: Math.round(vec[j] * 1000) / 1000 }))
      .sort((a, b) => Math.abs(b.loading) - Math.abs(a.loading));
  });

  const varianceExplained = values.slice(0, k).map(v => Math.max(v, 0) / total);
  // The FULL spectrum, not just the kept components (finding B4). The scree
  // chart plotted varianceExplained, whose length is k — so keeping 3
  // components drew 3 bars. But methods.ts teaches the Cattell scree test and
  // the Kaiser eigenvalue > 1 rule, and both need every eigenvalue: the elbow
  // is invisible if the plot stops at the elbow.
  const spectrum = values.map(v => Math.max(v, 0) / total);
  // Eigenvalues themselves, for the Kaiser criterion. On a correlation PCA each
  // variable contributes 1, so "> 1" is the meaningful line; on a covariance
  // PCA it is not, which is why the UI only draws it when standardized.
  const eigenvalues = values.map(v => Math.max(v, 0));
  const cumulative = varianceExplained.reduce<number[]>((acc, v) => {
    acc.push((acc[acc.length - 1] ?? 0) + v);
    return acc;
  }, []);

  const byVariable = missingByVar.sort((a, b) => b.n - a.n);
  const missing: MissingReport = {
    strategy,
    imputedCells: strategy === 'complete' || strategy === 'pairwise' ? 0 : byVariable.reduce((s, v) => s + v.n, 0),
    totalCells: n * p,
    byVariable,
    rowsUsed: pairwise ? Array.from({ length: n }, (_, i) => cols.some(c => c[i] !== null)).filter(Boolean).length : m,
    rowsDropped: pairwise ? Array.from({ length: n }, (_, i) => cols.every(c => c[i] === null)).filter(Boolean).length : n - m,
    ...(pairwise ? { pairCounts: pairwise.counts, rowsScored: m } : {}),
    ...(fillRules.length ? { fillRules } : {}),
    ...(iterative ? { iterations: iterative.iterations, converged: iterative.converged } : {}),
  };

  return { table: newTable, columns: pcNames, replaced, label, loadings, varianceExplained, spectrum, eigenvalues, cumulative, variables, k, missing };
};
