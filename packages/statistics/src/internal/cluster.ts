import { asNumber, median, numericValues } from './table';
// Deterministic PRNG so repeated runs give identical clusters (random_state analog)
import { mulberry32 } from './random';
import { isPCColumn } from './pca';

// DBSCAN + KMeans over plot coordinates, replacing the sklearn endpoints.
// Sizes here are survey-scale (hundreds to low thousands of points), so the
// O(n²) DBSCAN neighbor search and plain kmeans++ are more than fast enough.

// Column-wise z-scaling, preserving nulls (imputation happens downstream in
// dbscan/kmeans/toMatrix). Applied at the CALL SITE — by the cluster runners
// and by the k/eps diagnostics — so suggestions are always computed in the same
// units the clustering will actually use. An sd-0 column becomes all zeros: a
// variable that does not vary contributes nothing to distance, which is the
// honest reading.
//
// Takes raw table cells and coerces on the way in. It must, because every call
// site passes them straight from the DataTable: if this only recognised typeof
// number, a text-formatted value would pass through UNSCALED and then be
// coerced downstream by imputeColumns, mixing raw units with z-scores in the
// same distance computation (C6).
export const zscoreCellColumns = (cols: (number | string | null)[][]): (number | null)[][] =>
  cols.map(col => {
    const vals = col.map(asNumber);
    let n = 0, sum = 0;
    for (const v of vals) if (v !== null) { n++; sum += v; }
    if (!n) return vals;
    const mean = sum / n;
    let ss = 0;
    for (const v of vals) if (v !== null) ss += (v - mean) ** 2;
    const sd = Math.sqrt(ss / n);
    return vals.map(v => (v !== null ? (sd ? (v - mean) / sd : 0) : null));
  });

// Smart default for the standardize toggle, by data regime:
// - PC scores → off: the variance ordering IS the information PCA produced;
//   z-scoring makes PC3's noise count as much as PC1's structure.
// - shared-scale columns (ranges within 3× of each other) → off: on a common
//   scale, variance differences are themselves signal, and z-scoring inflates
//   near-constant items by dividing by a tiny sd.
// - heterogeneous scales → on: otherwise Euclidean distance is effectively
//   just the widest column.
export const suggestStandardize = (cols: (number | string | null)[][], names: string[]): boolean => {
  // Bare or labeled component sets (PC1, PC2_openness) both count as PC scores.
  // COMP_ composites deliberately do NOT: each comes from a different
  // decomposition, so across-composite scale differences are back to the
  // ordinary range heuristic below.
  if (names.length > 0 && names.every(isPCColumn)) return false;
  const ranges: number[] = [];
  for (const col of cols) {
    let min = Infinity, max = -Infinity;
    for (const raw of col) {
      const v = asNumber(raw);
      if (v !== null) { if (v < min) min = v; if (v > max) max = v; }
    }
    if (max > min) ranges.push(max - min);
  }
  if (ranges.length < 2) return false;
  let lo = Infinity, hi = 0;
  for (const r of ranges) { if (r < lo) lo = r; if (r > hi) hi = r; }
  return hi / lo > 3;
};

// What imputeColumns below will have to fill in, per column and in total.
// Exported so the call sites can report it: clustering silently substitutes the
// median for every missing coordinate, which pulls those rows toward the centre
// of the cloud and can decide which cluster they land in.
export const countImputed = (
  // Deliberately wider than (number | null)[]: call sites pass raw DataTable
  // columns, whose cells are number | string | null. Anything not a finite
  // number is what imputeColumns will replace, so that is what gets counted.
  cols: (number | string | null)[][], names: string[],
): { cells: number; total: number; byVariable: { var: string; n: number }[] } => {
  const n = cols[0]?.length ?? 0;
  const byVariable: { var: string; n: number }[] = [];
  cols.forEach((col, j) => {
    let have = 0;
    for (const v of col) if (asNumber(v) !== null) have++;
    if (have < n) byVariable.push({ var: names[j] ?? `column ${j + 1}`, n: n - have });
  });
  return {
    cells: byVariable.reduce((s, m) => s + m.n, 0),
    total: n * cols.length,
    byVariable: byVariable.sort((a, b) => b.n - a.n),
  };
};

/**
 * Refuse to cluster on an axis that holds no numbers at all.
 *
 * `median([])` is 0, so `imputeColumns` filled such a column entirely with
 * zeros: it contributed nothing to any distance, and the run still reported
 * success with a full set of cluster sizes. A text axis produced six confident
 * labels and not one word of warning (finding A11). Returns the offending
 * column names, or [] when everything is usable.
 */
export const nonNumericAxes = (cols: (number | string | null)[][], names: string[]): string[] =>
  names.filter((_, j) => !(cols[j] ?? []).some(v => asNumber(v) !== null));

// Column-wise median imputation so missing axis values don't break distance math.
//
// asNumber rather than a typeof check: this used to treat a text-formatted
// numeric column as entirely missing and replace every row with the median, so
// clustering ran on a constant and said nothing about that variable (C6).
const imputeColumns = (cols: (number | string | null)[][]): number[][] => {
  const numeric = cols.map(c => c.map(asNumber));
  const meds = numeric.map(c => median(numericValues(c)));
  const n = cols[0]?.length ?? 0;
  return Array.from({ length: n }, (_, i) => numeric.map((c, j) => c[i] ?? meds[j]));
};

export const dbscan = (colData: (number | string | null)[][], eps: number, minSamples: number): string[] => {
  const X = imputeColumns(colData);
  const n = X.length;
  const eps2 = eps * eps;
  const dist2 = (a: number[], b: number[]) => {
    let s = 0;
    for (let d = 0; d < a.length; d++) s += (a[d] - b[d]) ** 2;
    return s;
  };
  const neighbors = (i: number) => {
    const out: number[] = [];
    for (let j = 0; j < n; j++) if (dist2(X[i], X[j]) <= eps2) out.push(j);
    return out;
  };

  const labels = new Array<number>(n).fill(-2); // -2 unvisited, -1 noise
  let cluster = -1;
  for (let i = 0; i < n; i++) {
    if (labels[i] !== -2) continue;
    const nbrs = neighbors(i);
    if (nbrs.length < minSamples) { labels[i] = -1; continue; }
    cluster++;
    labels[i] = cluster;
    const queue = [...nbrs];
    for (let q = 0; q < queue.length; q++) {
      const j = queue[q];
      if (labels[j] === -1) labels[j] = cluster; // noise → border point
      if (labels[j] !== -2) continue;
      labels[j] = cluster;
      const jn = neighbors(j);
      if (jn.length >= minSamples) queue.push(...jn);
    }
  }
  return labels.map(l => (l === -1 ? 'Noise' : `Cluster ${l}`));
};

export const kmeans = (colData: (number | string | null)[][], k: number): string[] => {
  const X = imputeColumns(colData);
  const n = X.length;
  const dim = X[0]?.length ?? 0;
  if (n === 0 || k < 1) return [];
  k = Math.min(k, n);
  const dist2 = (a: number[], b: number[]) => {
    let s = 0;
    for (let d = 0; d < dim; d++) s += (a[d] - b[d]) ** 2;
    return s;
  };

  let bestLabels: number[] = [];
  let bestInertia = Infinity;
  const N_INIT = 10, MAX_ITER = 300;

  for (let init = 0; init < N_INIT; init++) {
    const rand = mulberry32(42 + init);
    // kmeans++ seeding
    const centers: number[][] = [X[Math.floor(rand() * n)].slice()];
    const minD = new Array<number>(n).fill(Infinity);
    while (centers.length < k) {
      let total = 0;
      for (let i = 0; i < n; i++) {
        minD[i] = Math.min(minD[i], dist2(X[i], centers[centers.length - 1]));
        total += minD[i];
      }
      let target = rand() * total;
      let pick = n - 1;
      for (let i = 0; i < n; i++) { target -= minD[i]; if (target <= 0) { pick = i; break; } }
      centers.push(X[pick].slice());
    }

    const labels = new Array<number>(n).fill(0);
    for (let iter = 0; iter < MAX_ITER; iter++) {
      let moved = false;
      for (let i = 0; i < n; i++) {
        let best = 0, bd = Infinity;
        for (let c = 0; c < k; c++) {
          const d = dist2(X[i], centers[c]);
          if (d < bd) { bd = d; best = c; }
        }
        if (labels[i] !== best) { labels[i] = best; moved = true; }
      }
      const sums = Array.from({ length: k }, () => new Array(dim).fill(0));
      const counts = new Array(k).fill(0);
      for (let i = 0; i < n; i++) {
        counts[labels[i]]++;
        for (let d = 0; d < dim; d++) sums[labels[i]][d] += X[i][d];
      }
      for (let c = 0; c < k; c++) {
        if (counts[c]) {
          for (let d = 0; d < dim; d++) centers[c][d] = sums[c][d] / counts[c];
          continue;
        }
        // Empty cluster: relocate to the point furthest from its own centre,
        // as sklearn does. Keeping the centre instead meant a k = 8 run could
        // return six labels with gaps in the numbering, and a size list quietly
        // shorter than k (finding A12). Relocating keeps the promise that k
        // clusters means k clusters.
        let worst = 0, worstD = -1;
        for (let i = 0; i < n; i++) {
          const d = dist2(X[i], centers[labels[i]]);
          if (d > worstD) { worstD = d; worst = i; }
        }
        centers[c] = X[worst].slice();
        labels[worst] = c;
        moved = true;   // the assignment changed, so another pass is owed
      }
      if (!moved) break;
    }

    let inertia = 0;
    for (let i = 0; i < n; i++) inertia += dist2(X[i], centers[labels[i]]);
    if (inertia < bestInertia) { bestInertia = inertia; bestLabels = labels; }
  }

  return bestLabels.map(l => `Cluster ${l}`);
};
