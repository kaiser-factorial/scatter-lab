import { asNumber, type DataTable } from './table';
import type { AnalysisProfile, TestKind, TestPlan } from './analysisPlan';

// The five statistical tests behind the run_test tool and the Analyze panel.
// Pure functions over numeric arrays; the callers (page.tsx) extract and
// group the columns AFTER the plan has passed validators.ts, so nothing here
// re-checks shapes — it computes.
//
// Reporting conventions, decided with the owner:
// - exact p-values with a 95% CI and an effect size, never significance stars;
//   the UI bolds p when it is below 0.05, nothing else changes.
// - sample sd (n-1) wherever an sd is reported, matching compareGroups (A6).
// Citations for every method live in methods.ts (topic: statistical_tests).

// ---------------------------------------------------------------------------
// Numeric core: log-gamma, incomplete beta/gamma, normal CDF
// ---------------------------------------------------------------------------

// Lanczos approximation (g = 7, n = 9), |error| < 1e-13 over the reals we use.
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];
export const logGamma = (x: number): number => {
  if (x < 0.5) {
    // Reflection keeps the approximation on its accurate side.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  x -= 1;
  let a = LANCZOS[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
};

// Regularized incomplete beta I_x(a, b), by Lentz's continued fraction
// (Numerical Recipes §6.4). Drives the Student-t CDF.
const betacf = (a: number, b: number, x: number): number => {
  const EPS = 3e-14, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
};

export const regIncBeta = (a: number, b: number, x: number): number => {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const ln = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const front = Math.exp(ln);
  // The continued fraction converges fast on one side of the mean; use the
  // symmetry I_x(a,b) = 1 - I_{1-x}(b,a) for the other.
  return x < (a + 1) / (a + b + 2)
    ? (front * betacf(a, b, x)) / a
    : 1 - (front * betacf(b, a, 1 - x)) / b;
};

/** Two-sided p for a Student-t statistic with df degrees of freedom. */
export const tTwoSidedP = (t: number, df: number): number =>
  regIncBeta(df / 2, 0.5, df / (df + t * t));

/** Upper-tail critical value t*(df) with P(|T| <= t*) = level, by bisection. */
export const tCritical = (df: number, level = 0.95): number => {
  let lo = 0, hi = 150;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (1 - tTwoSidedP(mid, df) < level) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
};

// Regularized LOWER incomplete gamma P(s, x): series for x < s+1, continued
// fraction for the rest (Numerical Recipes §6.2). chiSquareSf = 1 - P(df/2, x/2).
const lowerGammaP = (s: number, x: number): number => {
  if (x <= 0) return 0;
  if (x < s + 1) {
    let sum = 1 / s, term = sum, a = s;
    for (let i = 0; i < 500; i++) {
      a += 1;
      term *= x / a;
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
    }
    return sum * Math.exp(-x + s * Math.log(x) - logGamma(s));
  }
  const FPMIN = 1e-300;
  let b = x + 1 - s, c = 1 / FPMIN, d = 1 / b, h = d;
  for (let i = 1; i <= 500; i++) {
    const an = -i * (i - s);
    b += 2;
    d = an * d + b; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return 1 - Math.exp(-x + s * Math.log(x) - logGamma(s)) * h;
};

/** Survival function of the chi-square distribution. */
export const chiSquareSf = (x: number, df: number): number =>
  Math.min(1, Math.max(0, 1 - lowerGammaP(df / 2, x / 2)));

// Standard normal CDF via Abramowitz & Stegun 26.2.17 (|error| < 7.5e-8) —
// plenty for a p-value quoted to three figures.
export const normalCdf = (z: number): number => {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
/** Sample variance (n-1). */
const sampleVar = (v: number[]) => {
  const m = mean(v);
  return v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1);
};

// Midranks over a pooled array, with the tie-correction term Σ(t³ - t).
const midranksWithTies = (vals: number[]): { ranks: number[]; tieTerm: number } => {
  const idx = vals.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array<number>(vals.length);
  let tieTerm = 0, i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const t = j - i + 1;
    if (t > 1) tieTerm += t ** 3 - t;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = rank;
    i = j + 1;
  }
  return { ranks, tieTerm };
};

const ecdfAt = (sorted: number[], x: number): number => {
  // # of values <= x, by binary search
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= x) lo = mid + 1; else hi = mid;
  }
  return lo / sorted.length;
};

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

export type TestResult = {
  test: TestKind;
  /** e.g. "t" / "U" / "H" / "D" / "chi²" — for the results card. */
  statLabel: string;
  statistic: number;
  df: number | null;
  p: number;
  effect: { label: string; value: number };
  /** 95% CI on the mean difference — Welch only. */
  ci95?: [number, number];
  groups: { group: string; n: number }[];
  /** Non-fatal warnings the card must show (low expected counts, heavy ties). */
  caveats: string[];
};

/** Welch's unequal-variances t-test (Welch 1947). */
export const welchT = (a: number[], b: number[], labels: [string, string]): TestResult => {
  const na = a.length, nb = b.length;
  const va = sampleVar(a) / na, vb = sampleVar(b) / nb;
  const se = Math.sqrt(va + vb);
  const t = (mean(a) - mean(b)) / se;
  // Welch–Satterthwaite df
  const df = (va + vb) ** 2 / (va ** 2 / (na - 1) + vb ** 2 / (nb - 1));
  const p = tTwoSidedP(t, df);
  const tc = tCritical(df);
  const diff = mean(a) - mean(b);
  // Cohen's d with the pooled sample sd — the version readers expect next to
  // a two-group comparison, even though the test itself does not pool.
  const pooled = Math.sqrt(((na - 1) * sampleVar(a) + (nb - 1) * sampleVar(b)) / (na + nb - 2));
  return {
    test: 't', statLabel: 't', statistic: t, df, p,
    effect: { label: "Cohen's d", value: diff / pooled },
    ci95: [diff - tc * se, diff + tc * se],
    groups: [{ group: labels[0], n: na }, { group: labels[1], n: nb }],
    caveats: [],
  };
};

/**
 * Mann–Whitney U (Mann & Whitney 1947), tie-corrected normal approximation,
 * no continuity correction. Effect size: rank-biserial r = 1 - 2U/(n1·n2).
 */
export const mannWhitneyU = (a: number[], b: number[], labels: [string, string]): TestResult => {
  const na = a.length, nb = b.length, n = na + nb;
  const { ranks, tieTerm } = midranksWithTies([...a, ...b]);
  const ra = ranks.slice(0, na).reduce((s, r) => s + r, 0);
  const u = ra - (na * (na + 1)) / 2;
  const mu = (na * nb) / 2;
  const sigma = Math.sqrt((na * nb / 12) * (n + 1 - tieTerm / (n * (n - 1))));
  const z = sigma > 0 ? (u - mu) / sigma : 0;
  const p = sigma > 0 ? 2 * (1 - normalCdf(Math.abs(z))) : 1;
  const caveats: string[] = [];
  if (tieTerm > 0) caveats.push('Ties present; tie-corrected normal approximation used.');
  if (Math.min(na, nb) < 8) caveats.push('Small groups: the normal approximation is rough below n≈8 per group.');
  return {
    test: 'mann_whitney', statLabel: 'U', statistic: u, df: null, p: Math.min(1, p),
    effect: { label: 'rank-biserial r', value: 1 - (2 * u) / (na * nb) },
    groups: [{ group: labels[0], n: na }, { group: labels[1], n: nb }],
    caveats,
  };
};

/** Kruskal–Wallis H (Kruskal & Wallis 1952), tie-corrected, chi-square p. */
export const kruskalWallis = (groups: { group: string; values: number[] }[]): TestResult => {
  const all = groups.flatMap(g => g.values);
  const n = all.length;
  const { ranks, tieTerm } = midranksWithTies(all);
  let offset = 0, h = 0;
  for (const g of groups) {
    const rsum = ranks.slice(offset, offset + g.values.length).reduce((s, r) => s + r, 0);
    h += (rsum * rsum) / g.values.length;
    offset += g.values.length;
  }
  h = (12 / (n * (n + 1))) * h - 3 * (n + 1);
  const correction = 1 - tieTerm / (n ** 3 - n);
  if (correction > 0) h /= correction;
  const df = groups.length - 1;
  const caveats: string[] = [];
  if (tieTerm > 0) caveats.push('Ties present; tie-corrected H used.');
  if (groups.some(g => g.values.length < 5)) caveats.push('Groups below n=5: the chi-square approximation of H is rough.');
  return {
    test: 'kruskal_wallis', statLabel: 'H', statistic: h, df, p: chiSquareSf(h, df),
    // Epsilon-squared: H normalized by its maximum (n²-1)/(n+1).
    effect: { label: 'epsilon²', value: (h * (n + 1)) / (n * n - 1) },
    groups: groups.map(g => ({ group: g.group, n: g.values.length })),
    caveats,
  };
};

/**
 * Two-sample Kolmogorov–Smirnov (Kolmogorov 1933; Smirnov 1948): D with the
 * asymptotic Kolmogorov-distribution p, and where the maximum ECDF gap sits.
 */
export const ksTwoSample = (a: number[], b: number[], labels: [string, string]): TestResult => {
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  let d = 0, at = sa[0];
  for (const x of [...sa, ...sb]) {
    const gap = Math.abs(ecdfAt(sa, x) - ecdfAt(sb, x));
    if (gap > d) { d = gap; at = x; }
  }
  const ne = (sa.length * sb.length) / (sa.length + sb.length);
  // Asymptotic Kolmogorov distribution with Stephens' small-sample adjustment.
  const lambda = (Math.sqrt(ne) + 0.12 + 0.11 / Math.sqrt(ne)) * d;
  // The alternating series only converges for a real gap; below this the
  // distributions are indistinguishable and p is 1 by construction.
  if (lambda < 0.3) {
    return {
      test: 'ks', statLabel: 'D', statistic: d, df: null, p: 1,
      effect: { label: `D (max ECDF gap, at ${Math.round(at * 1000) / 1000})`, value: d },
      groups: [{ group: labels[0], n: sa.length }, { group: labels[1], n: sb.length }],
      caveats: [],
    };
  }
  let p = 0;
  for (let j = 1; j <= 100; j++) {
    const term = 2 * (j % 2 === 1 ? 1 : -1) * Math.exp(-2 * j * j * lambda * lambda);
    p += term;
    if (Math.abs(term) < 1e-12) break;
  }
  p = Math.min(1, Math.max(0, p));
  const caveats: string[] = [];
  if (Math.min(sa.length, sb.length) < 20) caveats.push('Small groups: the asymptotic KS p-value is rough below n≈20 per group.');
  return {
    test: 'ks', statLabel: 'D', statistic: d, df: null, p,
    effect: { label: `D (max ECDF gap, at ${Math.round(at * 1000) / 1000})`, value: d },
    groups: [{ group: labels[0], n: sa.length }, { group: labels[1], n: sb.length }],
    caveats,
  };
};

/** Pearson chi-square on a contingency table (no Yates correction) + Cramér's V. */
export const chiSquareTest = (
  rows: string[], cols: string[], counts: number[][],
): TestResult => {
  const rowSums = counts.map(r => r.reduce((s, c) => s + c, 0));
  const colSums = counts[0].map((_, j) => counts.reduce((s, r) => s + r[j], 0));
  const total = rowSums.reduce((s, r) => s + r, 0);
  let chi2 = 0, lowCells = 0;
  for (let i = 0; i < rows.length; i++) {
    for (let j = 0; j < cols.length; j++) {
      const expected = (rowSums[i] * colSums[j]) / total;
      if (expected < 5) lowCells++;
      if (expected > 0) chi2 += (counts[i][j] - expected) ** 2 / expected;
    }
  }
  const df = (rows.length - 1) * (cols.length - 1);
  const minDim = Math.min(rows.length, cols.length) - 1;
  const caveats: string[] = [];
  if (lowCells > 0) {
    caveats.push(`${lowCells} cell(s) have expected counts below 5 — the chi-square approximation is unreliable there (consider merging sparse categories).`);
  }
  return {
    test: 'chi_square', statLabel: 'chi²', statistic: chi2, df, p: chiSquareSf(chi2, df),
    effect: { label: "Cramér's V", value: minDim > 0 && total > 0 ? Math.sqrt(chi2 / (total * minDim)) : 0 },
    groups: rows.map((r, i) => ({ group: r, n: rowSums[i] })),
    caveats,
  };
};

// ---------------------------------------------------------------------------
// Column-level entry point (used by the bridge and the Analyze panel)
// ---------------------------------------------------------------------------

type Cell = number | string | null | undefined;

/** Numeric values of `numeric` per requested group of `groupBy`, plan-ordered. */
export const groupValues = (
  numeric: Cell[], groupBy: Cell[], groups: string[],
): { group: string; values: number[] }[] => {
  const wanted = new Map(groups.map(g => [g, [] as number[]]));
  const n = Math.min(numeric.length, groupBy.length);
  for (let i = 0; i < n; i++) {
    if (groupBy[i] == null) continue;
    const bucket = wanted.get(String(groupBy[i]));
    if (!bucket) continue;
    const v = asNumber(numeric[i]);
    if (v !== null) bucket.push(v);
  }
  return groups.map(g => ({ group: g, values: wanted.get(g)! }));
};

/** Contingency counts of two categorical columns over the given level sets. */
export const crossCounts = (
  colA: Cell[], colB: Cell[], levelsA: string[], levelsB: string[],
): number[][] => {
  const ia = new Map(levelsA.map((v, i) => [v, i]));
  const ib = new Map(levelsB.map((v, i) => [v, i]));
  const counts = levelsA.map(() => levelsB.map(() => 0));
  const n = Math.min(colA.length, colB.length);
  for (let i = 0; i < n; i++) {
    if (colA[i] == null || colB[i] == null) continue;
    const r = ia.get(String(colA[i])), c = ib.get(String(colB[i]));
    if (r !== undefined && c !== undefined) counts[r][c]++;
  }
  return counts;
};

/**
 * Dispatch a VALIDATED TestPlan against a table. Group sets come from the
 * profile's visible values (the same ones the validator checked), so a
 * withheld value can never re-enter through execution.
 */
export const runTestPlan = (plan: TestPlan, table: DataTable, profile: AnalysisProfile): TestResult => {
  const visibleOf = (name: string): string[] =>
    (profile.columns.find(c => c.name === name)?.groups ?? []).filter(g => !g.withheld).map(g => g.value);
  if (plan.test === 'chi_square') {
    const levelsA = visibleOf(plan.column);
    const levelsB = visibleOf(plan.groupBy);
    return chiSquareTest(levelsA, levelsB, crossCounts(table.data[plan.column], table.data[plan.groupBy], levelsA, levelsB));
  }
  const chosen = plan.groups ?? visibleOf(plan.groupBy);
  const gv = groupValues(table.data[plan.column], table.data[plan.groupBy], chosen);
  const pair: [string, string] = [gv[0].group, gv[1].group];
  switch (plan.test) {
    case 't': return welchT(gv[0].values, gv[1].values, pair);
    case 'mann_whitney': return mannWhitneyU(gv[0].values, gv[1].values, pair);
    case 'ks': return ksTwoSample(gv[0].values, gv[1].values, pair);
    case 'kruskal_wallis': return kruskalWallis(gv);
  }
};

const round = (v: number, places = 4) => Math.round(v * 10 ** places) / 10 ** places;

/** One-line plain rendering for the assistant's tool result. */
export const formatTestResult = (r: TestResult): string => {
  const df = r.df !== null ? `, df=${round(r.df, 2)}` : '';
  const ci = r.ci95 ? `, 95% CI [${round(r.ci95[0], 3)}, ${round(r.ci95[1], 3)}]` : '';
  const p = r.p < 0.001 ? r.p.toExponential(2) : String(round(r.p));
  return [
    `${r.test}: ${r.statLabel}=${round(r.statistic, 3)}${df}, p=${p}${ci}, ${r.effect.label}=${round(r.effect.value, 3)}.`,
    `Groups: ${r.groups.map(g => `${g.group} (n=${g.n})`).join(', ')}.`,
    ...r.caveats.map(c => `Caveat: ${c}`),
  ].join('\n');
};
