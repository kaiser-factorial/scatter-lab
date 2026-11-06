import { bivariateGrid, brent, normalQuantile, normalCDF } from "./math";
import { fittingMask } from './correlation-method';
import {
  EfaError,
  type EfaPreparedData,
  type PairEstimate,
  type EfaCorrelations,
  type Progress,
} from "./types";

export function polychoric(
  data: EfaPreparedData,
  i: number,
  j: number,
): PairEstimate {
  const n = data.nRows,
    kx = data.items[i].categories.length,
    ky = data.items[j].categories.length;
  if (kx * ky > 4096)
    throw new EfaError(
      "category-budget",
      `Too many category combinations for ${data.items[i].column} × ${data.items[j].column}. This ordinal workflow supports at most 4,096 cells per pair; check category metadata and whether a continuous method is appropriate.`,
    );
  const tab = new Float64Array(kx * ky),
    mx = new Uint32Array(kx),
    my = new Uint32Array(ky);
  let total = 0, support = 0;
  const fitting = fittingMask(data);
  for (let row = 0; row < n; row++)
    if (fitting[i * n + row] && fitting[j * n + row]) {
      const x = data.codes[i * n + row],
        y = data.codes[j * n + row];
      tab[x * ky + y]++;
      mx[x]++;
      my[y]++;
      total++;
      if (data.observed[i * n + row] && data.observed[j * n + row]) support++;
    }
  const cx = Array.from(mx.keys()).filter((q) => mx[q] > 0),
    cy = Array.from(my.keys()).filter((q) => my[q] > 0);
  if (cx.length < 2 || cy.length < 2 || total < 3)
    throw new EfaError(
      "unestimable-pair",
      `Cannot estimate ${data.items[i].column} × ${data.items[j].column}: ${total} jointly observed rows and ${cx.length} × ${cy.length} observed categories.`,
      [
        {
          code: "unestimable-pair",
          message: "Review category coverage and missingness.",
          items: [data.items[i].column, data.items[j].column],
          count: total,
        },
      ],
    );
  const cuts = (categories: number[], m: Uint32Array) => {
    let acc = 0;
    return categories.slice(0, -1).map((c) => {
      acc += m[c];
      return normalQuantile(acc / total);
    });
  };
  const tx = cuts(cx, mx),
    ty = cuts(cy, my),
    xs = [-Infinity, ...tx, Infinity],
    ys = [-Infinity, ...ty, Infinity];
  const px = xs.map(normalCDF),
    py = ys.map(normalCDF);
  const objective = (rho: number) => {
    const cdf = bivariateGrid(xs, ys, rho, px, py);
    let loss = 0;
    for (let a = 0; a < cx.length; a++)
      for (let b = 0; b < cy.length; b++) {
        const count = tab[cx[a] * ky + cy[b]];
        if (!count) continue;
        const probability =
          cdf[a + 1][b + 1] - cdf[a][b + 1] - cdf[a + 1][b] + cdf[a][b];
        if (probability <= 0) return Infinity;
        loss -= count * Math.log(probability);
      }
    return loss;
  };
  const fit = brent(objective, -0.9999, 0.9999);
  if (!Number.isFinite(fit.value))
    throw new EfaError("likelihood", "Polychoric likelihood is not finite.");
  return {
    i,
    j,
    n: support,
    ...(data.fittingObserved ? { fittingN: total } : {}),
    rho: fit.x,
    thresholdsX: tx,
    thresholdsY: ty,
    observedCategoriesX: cx,
    observedCategoriesY: cy,
    sparseCells: cx.reduce(
      (s, a) => s + cy.filter((b) => tab[a * ky + b] < 5).length,
      0,
    ),
    boundary: Math.abs(fit.x) > 0.995,
  };
}
/** Original observed-pair support is retained separately from the completed fitting n. */
export function pearson(data: EfaPreparedData, i: number, j: number): PairEstimate {
  if (!data.numeric) throw new EfaError("numeric-item", "Numeric responses are required for Pearson correlations.");
  const n = data.nRows;
  let product = 0, xx = 0, yy = 0, observed = 0, used = 0, mx = 0, my = 0;
  for (let row = 0; row < n; row++) {
    const complete = !!(data.observed[i * n + row] && data.observed[j * n + row]);
    if (complete) observed++;
    if (!data.imputation && !complete) continue;
    const x = data.numeric[i * n + row], y = data.numeric[j * n + row], dx = x - mx, dy = y - my;
    used++; mx += dx / used; my += dy / used;
    xx += dx * (x - mx); yy += dy * (y - my); product += dx * (y - my);
  }
  if (used < 3) throw new EfaError('unestimable-pair', `Cannot estimate ${data.items[i].column} × ${data.items[j].column}: fewer than three usable rows.`);
  const rho = product / Math.sqrt(xx) / Math.sqrt(yy);
  if (!Number.isFinite(rho)) throw new EfaError("correlation", "Cannot estimate a finite Pearson correlation.");
  return { i, j, n: observed, ...(data.imputation ? { fittingN: used } : {}), rho: Math.max(-1, Math.min(1, rho)),
    thresholdsX: [], thresholdsY: [], observedCategoriesX: [], observedCategoriesY: [], sparseCells: 0,
    boundary: Math.abs(rho) > .995 };
}
export const estimatePair = (data: EfaPreparedData, i: number, j: number): PairEstimate =>
  data.numeric ? pearson(data, i, j) : polychoric(data, i, j);
export function assembleCorrelations(
  data: EfaPreparedData,
  pairs: PairEstimate[],
): EfaCorrelations {
  const p = data.items.length,
    matrix = Array.from({ length: p }, (_, i) =>
      Array.from({ length: p }, (_, j) => (i === j ? 1 : NaN)),
    );
  if (pairs.length !== (p * (p - 1)) / 2)
    throw new EfaError("pairs", "Correlation job is incomplete.");
  for (const pair of pairs)
    matrix[pair.i][pair.j] = matrix[pair.j][pair.i] = pair.rho;
  const sparse = pairs.filter((x) => x.sparseCells),
    boundary = pairs.filter((x) => x.boundary);
  const emptyMargins = data.numeric ? [] : pairs.filter(
    (x) =>
      x.observedCategoriesX.length < data.items[x.i].categories.length ||
      x.observedCategoriesY.length < data.items[x.j].categories.length,
  );
  return {
    matrix,
    pairs,
    counts: data.counts.map((f) => f.reduce((a, b) => a + b, 0)),
    diagnostics: [
      ...(sparse.length
        ? [
            {
              code: "sparse",
              message: `${sparse.length} item pairs contain cells with fewer than five responses. Inspect pair diagnostics.`,
              count: sparse.length,
            },
          ]
        : []),
      ...(boundary.length
        ? [
            {
              code: "boundary-correlation",
              message: `${boundary.length} estimated correlations are near ±1.`,
              count: boundary.length,
            },
          ]
        : []),
      ...(emptyMargins.length
        ? [
            {
              code: "empty-pair-margins",
              message: `${emptyMargins.length} pairs have unobserved category margins. Their likelihoods use the observed levels, matching polycor; the original category order and observed level indices are retained.`,
              count: emptyMargins.length,
            },
          ]
        : []),
    ],
  };
}
export function correlate(
  data: EfaPreparedData,
  progress?: Progress,
): EfaCorrelations {
  const pairs: PairEstimate[] = [],
    p = data.items.length,
    total = (p * (p - 1)) / 2;
  for (let i = 0; i < p - 1; i++)
    for (let j = i + 1; j < p; j++) {
      pairs.push(estimatePair(data, i, j));
      if (pairs.length % 32 === 0)
        progress?.({ stage: "Correlations", completed: pairs.length, total });
    }
  progress?.({ stage: "Correlations", completed: total, total });
  return assembleCorrelations(data, pairs);
}
