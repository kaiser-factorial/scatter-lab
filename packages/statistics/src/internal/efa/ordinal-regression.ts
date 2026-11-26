import { CholeskyDecomposition } from "ml-matrix";
import { Matrix, inverse, dot } from "./math";
import { minimize, type Objective } from "./optimize";
import { EfaError } from "./types";

export const MAX_CONDITIONAL_LEVELS = 50;

const logistic = (x: number) =>
  x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
const softplus = (x: number) =>
  Math.max(x, 0) + Math.log1p(Math.exp(-Math.abs(x)));
const logLogistic = (x: number) => -softplus(-x);
export interface ConditionalData {
  x: number[][];
  y: number[];
  weights: number[];
  augmented: number;
}
export interface OrdinalFit {
  coefficients: number[];
  thresholds: number[];
  objective: number;
  iterations: number;
  gradient: number;
  augmented: number;
}

/** White-Daniel-Royston augmentation, using the pinned mice 3.18 convention.
 * Predictor means/SDs use all supplied rows; only observed outcomes enter fitting.
 * No automatic predictor/category removal or multinomial fallback.
 */
export function augmentConditional(
  x: number[][],
  y: (number | null)[],
  levels: number,
): ConditionalData {
  const n = x.length,
    d = x[0]?.length ?? 0;
  if (
    !n ||
    y.length !== n ||
    levels < 2 ||
    !Number.isInteger(levels) ||
    levels > MAX_CONDITIONAL_LEVELS ||
    x.some((row) => row.length !== d || row.some((v) => !Number.isFinite(v))) ||
    y.some((v) => v !== null && (!Number.isInteger(v) || v < 0 || v >= levels))
  )
    throw new EfaError(
      "conditional-data",
      "Invalid conditional regression inputs.",
    );
  const observed = y.flatMap((v, i) => (v === null ? [] : [i]));
  if (new Set(observed.map((i) => y[i])).size !== levels)
    throw new EfaError(
      "empty-imputation-category",
      "Every declared outcome category needs observed responses in the fitting sample.",
    );
  const train: ConditionalData = {
    x: observed.map((i) => x[i]),
    y: observed.map((i) => y[i]!),
    weights: observed.map(() => 1),
    augmented: 0,
  };
  if (!d || n - observed.length === 1) return train;
  const means = Array(d).fill(0),
    sds = Array(d).fill(0),
    lo = Array(d).fill(Infinity),
    hi = Array(d).fill(-Infinity);
  for (const row of x)
    for (let j = 0; j < d; j++) {
      means[j] += row[j] / n;
      lo[j] = Math.min(lo[j], row[j]);
      hi[j] = Math.max(hi[j], row[j]);
    }
  for (const row of x)
    for (let j = 0; j < d; j++) sds[j] += (row[j] - means[j]) ** 2 / (n - 1);
  for (let j = 0; j < d; j++) {
    if (sds[j] <= 1e-14)
      throw new EfaError(
        "constant-predictor",
        `Imputation predictor ${j + 1} is constant. Revise the predictor specification.`,
      );
    for (let c = 0; c < levels; c++)
      for (const sign of [1, -1]) {
        const row = means.slice();
        row[j] = Math.max(
          lo[j],
          Math.min(hi[j], means[j] + sign * 0.5 * Math.sqrt(sds[j])),
        );
        train.x.push(row);
        train.y.push(c);
        train.weights.push((d + 1) / (2 * d * levels));
        train.augmented++;
      }
  }
  return train;
}
export function ordinalObjective(
  data: ConditionalData,
  levels: number,
): Objective {
  const d = data.x[0]?.length ?? 0,
    total = data.weights.reduce((a, b) => a + b, 0);
  return (parameters) => {
    const thresholds = [parameters[d]];
    for (let c = 1; c < levels - 1; c++)
      thresholds.push(thresholds[c - 1] + Math.exp(parameters[d + c]));
    const gradient = Array(parameters.length).fill(0),
      cuts = Array(levels - 1).fill(0);
    let value = 0,
      compensation = 0;
    for (let i = 0; i < data.x.length; i++) {
      const row = data.x[i],
        c = data.y[i],
        w = data.weights[i] / total;
      let eta = 0;
      for (let j = 0; j < d; j++) eta += row[j] * parameters[j];
      const upper = c === levels - 1 ? Infinity : thresholds[c] - eta,
        lower = c === 0 ? -Infinity : thresholds[c - 1] - eta,
        delta = upper - lower;
      const logProbability =
        c === 0
          ? logLogistic(upper)
          : c === levels - 1
            ? logLogistic(-lower)
            : lower +
              (delta > 50 ? delta : Math.log(Math.expm1(delta))) -
              softplus(upper) -
              softplus(lower);
      if (!Number.isFinite(logProbability))
        return { value: Infinity, gradient };
      const term = -w * logProbability - compensation,
        nextValue = value + term;
      compensation = nextValue - value - term;
      value = nextValue;
      const fu =
          c === levels - 1
            ? 0
            : Math.exp(
                logLogistic(upper) + logLogistic(-upper) - logProbability,
              ),
        fl =
          c === 0
            ? 0
            : Math.exp(
                logLogistic(lower) + logLogistic(-lower) - logProbability,
              ),
        slope = w * (fu - fl);
      for (let j = 0; j < d; j++) gradient[j] += row[j] * slope;
      if (c < levels - 1) cuts[c] -= w * fu;
      if (c > 0) cuts[c - 1] += w * fl;
    }
    let tail = 0;
    for (let c = levels - 2; c >= 0; c--) {
      tail += cuts[c];
      gradient[d + c] = tail * (c === 0 ? 1 : Math.exp(parameters[d + c]));
    }
    return { value, gradient };
  };
}
export function fitOrdinal(
  x: number[][],
  y: (number | null)[],
  levels: number,
): OrdinalFit {
  const data = augmentConditional(x, y, levels),
    d = x[0].length,
    counts = Array(levels).fill(0);
  const means = Array.from(
      { length: d },
      (_, j) => x.reduce((s, row) => s + row[j], 0) / x.length,
    ),
    sds = means.map((mean, j) =>
      Math.sqrt(
        x.reduce((s, row) => s + (row[j] - mean) ** 2, 0) / (x.length - 1),
      ),
    );
  if (sds.some((sd) => !(sd > 0)))
    throw new EfaError(
      "constant-predictor",
      "An imputation predictor is constant. Revise the predictor specification.",
    );
  // Conditioning only: return coefficients on the original predictor scale.
  // Augmentation and the likelihood are unchanged by this affine transform.
  const scaled = {
    ...data,
    x: data.x.map((row) => row.map((v, j) => (v - means[j]) / sds[j])),
  };
  data.y.forEach((c, i) => (counts[c] += data.weights[i]));
  const total = counts.reduce((a, b) => a + b, 0),
    cuts: number[] = [];
  let sum = 0;
  for (let c = 0; c < levels - 1; c++) {
    sum += counts[c];
    cuts.push(Math.log(sum / (total - sum)));
  }
  const initial = [
      ...Array(d).fill(0),
      cuts[0],
      ...cuts.slice(1).map((v, i) => Math.log(v - cuts[i])),
    ],
    fit = minimize(ordinalObjective(scaled, levels), initial);
  const thresholds = [fit.parameters[d]];
  for (let c = 1; c < levels - 1; c++)
    thresholds.push(thresholds[c - 1] + Math.exp(fit.parameters[d + c]));
  const coefficients = fit.parameters.slice(0, d).map((v, j) => v / sds[j]),
    offset = dot(coefficients, means);
  return {
    coefficients,
    thresholds: thresholds.map((t) => t + offset),
    objective: fit.value * total,
    iterations: fit.iterations,
    gradient: fit.gradientNorm,
    augmented: data.augmented,
  };
}
export function ordinalProbabilities(
  fit: Pick<OrdinalFit, "coefficients" | "thresholds">,
  x: number[][],
) {
  return x.map((row) => {
    const eta = dot(row, fit.coefficients),
      cdf = [0, ...fit.thresholds.map((t) => logistic(t - eta)), 1];
    return cdf.slice(1).map((v, i) => v - cdf[i]);
  });
}
export function drawOrdinal(probabilities: number[][], uniforms: number[]) {
  if (
    probabilities.length !== uniforms.length ||
    uniforms.some((u) => !Number.isFinite(u) || u < 0 || u >= 1) ||
    probabilities.some(
      (row) =>
        !row.length ||
        row.some((p) => !Number.isFinite(p) || p < 0) ||
        Math.abs(row.reduce((a, b) => a + b, 0) - 1) > 1e-10,
    )
  )
    throw new EfaError("draws", "Invalid saved imputation draws.");
  return probabilities.map((row, i) => {
    let cumulative = 0;
    for (let c = 0; c < row.length; c++) {
      cumulative += row[c];
      if (uniforms[i] < cumulative) return c;
    }
    return row.length - 1;
  });
}
/** Binary mice logreg uses a normal coefficient draw, unlike mice polr. */
export function binaryConditionalDraw(
  x: number[][],
  y: (number | null)[],
  normals: number[],
  uniforms: number[],
) {
  const fit = fitOrdinal(x, y, 2),
    data = augmentConditional(x, y, 2),
    d = x[0].length + 1;
  if (normals.length !== d || normals.some((v) => !Number.isFinite(v)))
    throw new EfaError(
      "draws",
      "Binary regression needs one normal draw per coefficient.",
    );
  const beta = [-fit.thresholds[0], ...fit.coefficients],
    information = Matrix.zeros(d, d);
  for (let i = 0; i < data.x.length; i++) {
    const row = [1, ...data.x[i]],
      p = logistic(dot(row, beta)),
      w = data.weights[i] * p * (1 - p);
    for (let j = 0; j < d; j++)
      for (let k = 0; k < d; k++)
        information.set(j, k, information.get(j, k) + w * row[j] * row[k]);
  }
  let covariance: Matrix, lower: Matrix;
  try {
    covariance = inverse(information);
    // The inverse is mathematically symmetric. Match R's sym() before Cholesky
    // to remove floating-point asymmetry, without clipping eigenvalues or adding a ridge.
    for (let j = 0; j < d; j++)
      for (let k = 0; k < j; k++) {
        const v = (covariance.get(j, k) + covariance.get(k, j)) / 2;
        covariance.set(j, k, v);
        covariance.set(k, j, v);
      }
    lower = new CholeskyDecomposition(covariance).lowerTriangularMatrix;
  } catch {
    throw new EfaError(
      "singular-imputation-model",
      "The binary imputation information matrix is singular. Revise predictors.",
    );
  }
  const sampled = beta.map(
    (b, j) => b + normals.reduce((s, z, k) => s + lower.get(j, k) * z, 0),
  );
  const missing = y.flatMap((v, i) => (v === null ? [i] : []));
  if (
    uniforms.length !== missing.length ||
    uniforms.some((u) => u < 0 || u >= 1)
  )
    throw new EfaError("draws", "Invalid binary imputation draws.");
  return {
    fit,
    beta,
    covariance: covariance.to2DArray(),
    sampled,
    probabilities: missing.map((i) => logistic(dot([1, ...x[i]], sampled))),
    draws: missing.map((i, j) =>
      uniforms[j] <= logistic(dot([1, ...x[i]], sampled)) ? 1 : 0,
    ),
  };
}
