// Aggregate statistics for the assistant's analysis tools. Everything here
// returns summaries, never row-level data — that is the privacy contract.

import { sampleIndices } from './random';
import { asNumber } from './table';

export type Cell = number | null | undefined | string;

const numericPairs = (a: Cell[], b: Cell[]): [number, number][] => {
  const out: [number, number][] = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    // asNumber, so a text-formatted column correlates like any other (C6)
    const x = asNumber(a[i]), y = asNumber(b[i]);
    if (x !== null && y !== null) out.push([x, y]);
  }
  return out;
};

const pearsonOfPairs = (pairs: [number, number][]): number | null => {
  const n = pairs.length;
  if (n < 3) return null;
  let sa = 0, sb = 0;
  for (const [x, y] of pairs) { sa += x; sb += y; }
  const ma = sa / n, mb = sb / n;
  let cov = 0, va = 0, vb = 0;
  for (const [x, y] of pairs) {
    cov += (x - ma) * (y - mb);
    va += (x - ma) ** 2;
    vb += (y - mb) ** 2;
  }
  if (va === 0 || vb === 0) return null;
  return cov / Math.sqrt(va * vb);
};

// Average ranks with ties (midrank), for Spearman
const ranks = (vals: number[]): number[] => {
  const idx = vals.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(vals.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k][1]] = rank;
    i = j + 1;
  }
  return out;
};

// Pearson + Spearman over pairwise-complete numeric observations
export const correlation = (a: Cell[], b: Cell[]): { n: number; pearson: number | null; spearman: number | null } => {
  const pairs = numericPairs(a, b);
  const pearson = pearsonOfPairs(pairs);
  const ra = ranks(pairs.map(p => p[0]));
  const rb = ranks(pairs.map(p => p[1]));
  const spearman = pearsonOfPairs(ra.map((r, i) => [r, rb[i]] as [number, number]));
  return { n: pairs.length, pearson, spearman };
};

export type GroupStat = { group: string; n: number; mean: number; /** Sample sd (n-1); null when n = 1. */ sd: number | null };

export type GroupComparison = {
  groups: GroupStat[];
  overall: { n: number; mean: number; sd: number | null };
  etaSquared: number | null;
  /**
   * Omega-squared: eta² corrected for the upward bias that grows with the
   * number of groups. methods.ts (eta_squared) names it as the fix and the app
   * did not compute it, which mattered most in exactly the case eta² misleads —
   * many small groups. Can go slightly negative when group means differ less
   * than chance would predict; that is meaningful, so it is not clamped.
   */
  omegaSquared: number | null;
  nGroups: number;
  /** Size of the smallest group, for judging whether the numbers are stable. */
  minGroupN: number;
  /** Groups with a single observation — no sample sd exists for them. */
  singletonGroups: number;
};

// Per-group mean/sd of a numeric column plus eta²/omega² — the standard effect
// sizes for "does this differ by group". sd here is the SAMPLE sd (n-1); see
// the note on `stats` below for why this one differs from the rest of the app.
export const compareGroups = (
  numeric: Cell[], groups: Cell[],
): GroupComparison => {
  const byGroup = new Map<string, number[]>();
  const all: number[] = [];
  const n = Math.min(numeric.length, groups.length);
  for (let i = 0; i < n; i++) {
    const v = asNumber(numeric[i]);
    if (v === null || groups[i] == null) continue;
    const g = String(groups[i]);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(v);
    all.push(v);
  }
  // SAMPLE sd (÷ n-1), unlike the rest of the app.
  //
  // Everything else here uses the population form, matching sklearn, and that is
  // right for numbers feeding further computation — the PCA covariance matrix,
  // z-scoring. These numbers are different: they are a descriptive summary a
  // researcher copies into a manuscript, where n-1 is the reporting convention,
  // and they were labelled only "sd" so nobody could tell which they had
  // (finding A6). n = 1 has no sample sd, so it is null rather than a
  // conveniently zero-looking 0.
  const stats = (vals: number[]) => {
    const m = vals.reduce((s, v) => s + v, 0) / vals.length;
    const sd = vals.length > 1
      ? Math.sqrt(vals.reduce((s, v) => s + (v - m) ** 2, 0) / (vals.length - 1))
      : null;
    return { n: vals.length, mean: m, sd };
  };
  if (all.length === 0) {
    return { groups: [], overall: { n: 0, mean: NaN, sd: null }, etaSquared: null, omegaSquared: null, nGroups: 0, minGroupN: 0, singletonGroups: 0 };
  }
  const overall = stats(all);
  const groupStats: GroupStat[] = Array.from(byGroup.entries())
    .map(([group, vals]) => ({ group, ...stats(vals) }))
    .sort((a, b) => b.mean - a.mean);
  let ssBetween = 0, ssTotal = 0;
  for (const g of groupStats) ssBetween += g.n * (g.mean - overall.mean) ** 2;
  for (const v of all) ssTotal += (v - overall.mean) ** 2;

  const kGroups = groupStats.length;
  const dfWithin = all.length - kGroups;
  const msWithin = dfWithin > 0 ? (ssTotal - ssBetween) / dfWithin : null;
  // omega² = (SS_between - (k-1)·MS_within) / (SS_total + MS_within)
  const omegaSquared = msWithin != null && ssTotal + msWithin > 0
    ? (ssBetween - (kGroups - 1) * msWithin) / (ssTotal + msWithin)
    : null;

  return {
    groups: groupStats,
    overall,
    etaSquared: ssTotal > 0 ? ssBetween / ssTotal : null,
    omegaSquared,
    nGroups: kGroups,
    minGroupN: Math.min(...groupStats.map(g => g.n)),
    singletonGroups: groupStats.filter(g => g.n === 1).length,
  };
};

// --- Clustering diagnostics -------------------------------------------------

// Rows from columnar axis data, dropping incomplete rows, then subsampled so
// the O(n²) work below stays fast on large tables.
//
// The sample is SEEDED RANDOM, not evenly strided. Striding is fine on shuffled
// data and wrong on ordered data — one row per participant per wave, blocks of
// trials, cases sorted by condition — where a stride landing on the period
// samples one stratum and calls it the dataset. Seeded so repeated runs still
// agree, which the app's determinism promise depends on.
const toMatrix = (cols: Cell[][], cap = 1200): number[][] => {
  const n = Math.min(...cols.map(c => c.length));
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = cols.map(c => asNumber(c[i]));
    if (row.every((v): v is number => v !== null)) rows.push(row);
  }
  if (rows.length <= cap) return rows;
  return sampleIndices(rows.length, cap).map(i => rows[i]);
};

const distMatrix = (X: number[][]): Float64Array => {
  const n = X.length, d = X[0]?.length ?? 0;
  const D = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let s = 0;
      for (let k = 0; k < d; k++) s += (X[i][k] - X[j][k]) ** 2;
      const dist = Math.sqrt(s);
      D[i * n + j] = dist;
      D[j * n + i] = dist;
    }
  }
  return D;
};

export const meanSilhouette = (D: Float64Array, labels: number[]): number => {
  const n = labels.length;
  const clusters = new Map<number, number[]>();
  labels.forEach((l, i) => {
    if (!clusters.has(l)) clusters.set(l, []);
    clusters.get(l)!.push(i);
  });
  if (clusters.size < 2) return 0;
  let total = 0, counted = 0;
  for (let i = 0; i < n; i++) {
    const own = clusters.get(labels[i])!;
    // Rousseeuw (1987) assigns a singleton s = 0, and that is not a technicality
    // here: skipping them instead RAISED the mean, most at high k and with
    // outliers — exactly where suggest_k should be discouraging the user rather
    // than rewarding them for splitting off one-point clusters (finding A5).
    if (own.length <= 1) { counted++; continue; }
    let a = 0;
    for (const j of own) if (j !== i) a += D[i * n + j];
    a /= own.length - 1;
    let b = Infinity;
    for (const [l, members] of clusters) {
      if (l === labels[i]) continue;
      let m = 0;
      for (const j of members) m += D[i * n + j];
      m /= members.length;
      if (m < b) b = m;
    }
    total += (b - a) / Math.max(a, b);
    counted++;
  }
  return counted ? total / counted : 0;
};

// Silhouette by k for K-Means on the given axis columns
export const silhouetteByK = (
  cols: Cell[][],
  kmeansFn: (cols: (number | null)[][], k: number) => string[],
  maxK: number,
): { k: number; silhouette: number }[] => {
  const X = toMatrix(cols);
  if (X.length < 10) return [];
  const D = distMatrix(X);
  // re-run kmeans on the sampled matrix's columns so labels align with X
  const sampledCols = X[0].map((_, c) => X.map(row => row[c]));
  const out: { k: number; silhouette: number }[] = [];
  for (let k = 2; k <= Math.min(maxK, Math.floor(X.length / 3)); k++) {
    const labels = kmeansFn(sampledCols, k).map(l => Number(l.replace('Cluster ', '')));
    out.push({ k, silhouette: meanSilhouette(D, labels) });
  }
  return out;
};

// k-distance curve for DBSCAN eps selection, summarized as percentiles: eps
// near the "knee" (between the 90th and 95th percentile) is a common starting
// point (Ester et al. 1996).
//
// The parameter is DBSCAN's `minSamples`, NOT the neighbor rank, because the
// two differ by one and getting it wrong makes every suggestion too generous.
// `dbscan` counts the point itself toward minSamples (matching sklearn), so a
// point becomes a core point once minSamples - 1 OTHER points lie within eps —
// which means the curve to read is the distance to the (minSamples - 1)-th
// nearest neighbor, excluding self. That is the convention the methods
// reference documents (`standardize_clustering` / `dbscan_interpretation`).
//
// minSamples <= 1 has no meaningful curve: every point is its own core point at
// any eps, so eps stops controlling anything. Returns null rather than guessing.
export const kDistancePercentiles = (
  cols: Cell[][], minSamples: number,
): { n: number; kthNeighbor: number; percentiles: Record<string, number> } | null => {
  const kth = Math.floor(minSamples) - 1;   // neighbor rank, excluding self
  if (kth < 1) return null;
  const X = toMatrix(cols, 2000);
  const n = X.length;
  if (n < kth + 1) return null;
  const D = distMatrix(X);
  const kd: number[] = [];
  const row = new Float64Array(n - 1);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = 0; j < n; j++) if (j !== i) row[m++] = D[i * n + j];
    const sorted = Array.from(row).sort((a, b) => a - b);
    kd.push(sorted[kth - 1]);
  }
  kd.sort((a, b) => a - b);
  const pct = (p: number) => kd[Math.min(n - 1, Math.floor((p / 100) * n))];
  return {
    n,
    kthNeighbor: kth,
    percentiles: { p50: pct(50), p75: pct(75), p90: pct(90), p95: pct(95), max: kd[n - 1] },
  };
};
