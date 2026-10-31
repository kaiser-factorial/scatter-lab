import { bivariateGrid, normalCDF } from "./math";
import {
  EfaError,
  type EfaPreparedData,
  type EfaCorrelations,
  type PairEstimate,
  type Progress,
} from "./types";

export const ORDINAL_UNCERTAINTY_METHOD =
  "Two-step pair-margin polychoric influence functions; empirical score-product sensitivity; estimated-threshold correction; common eligible-N scale; zero contribution for pair-missing rows; no cell correction";

/** Worker-only lookup. No N-by-pair or pair-by-pair covariance allocation. */
export interface PairInfluence {
  i: number;
  j: number;
  n: number;
  columns: number;
  values: Float64Array;
  variance: number;
}
export interface WeightedMoments {
  pairs: PairInfluence[];
  weights: Float64Array;
  nRows: number;
  method: string;
}
const density = (x: number) =>
  Number.isFinite(x) ? Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI) : 0;
const density2 = (x: number, y: number, rho: number) =>
  Number.isFinite(x) && Number.isFinite(y)
    ? Math.exp(-(x * x + y * y - 2 * rho * x * y) / (2 * (1 - rho * rho))) /
      (2 * Math.PI * Math.sqrt(1 - rho * rho))
    : 0;

export function pairInfluence(
  data: EfaPreparedData,
  pair: PairEstimate,
): PairInfluence {
  const {
      i,
      j,
      n,
      rho,
      observedCategoriesX: cx,
      observedCategoriesY: cy,
    } = pair,
    nx = cx.length,
    ny = cy.length,
    fullY = data.items[j].categories.length,
    counts = new Uint32Array(nx * ny),
    mapX = new Map(cx.map((v, a) => [v, a])),
    mapY = new Map(cy.map((v, a) => [v, a]));
  let observed = 0;
  for (let row = 0; row < data.nRows; row++) {
    if (
      !data.observed[i * data.nRows + row] ||
      !data.observed[j * data.nRows + row]
    )
      continue;
    const a = mapX.get(data.codes[i * data.nRows + row]),
      b = mapY.get(data.codes[j * data.nRows + row]);
    if (a === undefined || b === undefined)
      throw new EfaError(
        "weighted-snapshot",
        "Pair categories do not match the fitting snapshot.",
      );
    counts[a * ny + b]++;
    observed++;
  }
  if (observed !== n || n < 3)
    throw new EfaError(
      "weighted-snapshot",
      "Pair sample size does not match the fitting snapshot.",
    );
  if (pair.boundary)
    throw new EfaError(
      "weighted-boundary",
      "A near-boundary polychoric estimate cannot support reliable score-based uncertainty. Review the pair diagnostics.",
    );
  const xs = [-Infinity, ...pair.thresholdsX, Infinity],
    ys = [-Infinity, ...pair.thresholdsY, Infinity],
    px = xs.map(normalCDF),
    py = ys.map(normalCDF),
    grid = bivariateGrid(xs, ys, rho, px, py),
    root = Math.sqrt(1 - rho * rho),
    scores = new Float64Array(nx * ny),
    crossX = new Float64Array(nx - 1),
    crossY = new Float64Array(ny - 1);
  let information = 0;
  for (let a = 0; a < nx; a++)
    for (let b = 0; b < ny; b++) {
      const cell = a * ny + b,
        count = counts[cell];
      if (!count) continue;
      const probability =
        grid[a + 1][b + 1] - grid[a][b + 1] - grid[a + 1][b] + grid[a][b];
      // Match the reference score domain, but stop instead of silently replacing
      // a failed score by zero/NA or switching to a generalized inverse.
      if (!(probability > Math.sqrt(Number.EPSILON)))
        throw new EfaError(
          "weighted-probability",
          "An observed ordinal cell has a probability too small for stable uncertainty estimation. Review sparse categories and pair correlations.",
        );
      const score =
        (density2(xs[a + 1], ys[b + 1], rho) -
          density2(xs[a], ys[b + 1], rho) -
          density2(xs[a + 1], ys[b], rho) +
          density2(xs[a], ys[b], rho)) /
        probability;
      scores[cell] = score;
      information += count * score * score;
      const bx = (t: number) =>
        (density(t) *
          (normalCDF((ys[b + 1] - rho * t) / root) -
            normalCDF((ys[b] - rho * t) / root))) /
        probability;
      const by = (t: number) =>
        (density(t) *
          (normalCDF((xs[a + 1] - rho * t) / root) -
            normalCDF((xs[a] - rho * t) / root))) /
        probability;
      if (a < nx - 1) crossX[a] += count * score * bx(xs[a + 1]);
      if (a > 0) crossX[a - 1] -= count * score * bx(xs[a]);
      if (b < ny - 1) crossY[b] += count * score * by(ys[b + 1]);
      if (b > 0) crossY[b - 1] -= count * score * by(ys[b]);
    }
  if (!(information > 0) || !Number.isFinite(information))
    throw new EfaError(
      "weighted-information",
      "The pair has singular correlation sensitivity.",
    );
  const values = new Float64Array(data.items[i].categories.length * fullY);
  let variance = 0;
  for (let a = 0; a < nx; a++)
    for (let b = 0; b < ny; b++) {
      const cell = a * ny + b;
      if (!counts[cell]) continue;
      let corrected = scores[cell];
      // A11^-1 g_threshold = (I[Y <= t] - empirical CDF(t))/phi(t)
      // for saturated ordered margins. A21 uses summed pair score products.
      for (let t = 0; t < nx - 1; t++)
        corrected -=
          ((crossX[t] / n) * ((a <= t ? 1 : 0) - px[t + 1])) /
          density(xs[t + 1]);
      for (let t = 0; t < ny - 1; t++)
        corrected -=
          ((crossY[t] / n) * ((b <= t ? 1 : 0) - py[t + 1])) /
          density(ys[t + 1]);
      const value = (data.nRows * corrected) / information;
      values[cx[a] * fullY + cy[b]] = value;
      variance += (counts[cell] * value * value) / data.nRows;
    }
  if (!(variance > 0) || !Number.isFinite(variance))
    throw new EfaError(
      "weighted-variance",
      "The pair has invalid sampling variance.",
    );
  return { i, j, n, columns: fullY, values, variance };
}

export function weightedMoments(
  data: EfaPreparedData,
  correlation: EfaCorrelations,
  progress?: Progress,
): WeightedMoments {
  const pairs = correlation.pairs.map((pair, index) => {
    const value = pairInfluence(data, pair);
    if (index % 32 === 0 || index + 1 === correlation.pairs.length)
      progress?.({
        stage: "Ordinal uncertainty",
        completed: index + 1,
        total: correlation.pairs.length,
      });
    return value;
  });
  return {
    pairs,
    weights: Float64Array.from(pairs, (p) => 1 / p.variance),
    nRows: data.nRows,
    method: ORDINAL_UNCERTAINTY_METHOD,
  };
}

export function influenceAt(
  data: EfaPreparedData,
  pair: PairInfluence,
  row: number,
): number {
  const x = pair.i * data.nRows + row,
    y = pair.j * data.nRows + row;
  return data.observed[x] && data.observed[y]
    ? pair.values[data.codes[x] * pair.columns + data.codes[y]]
    : 0;
}
