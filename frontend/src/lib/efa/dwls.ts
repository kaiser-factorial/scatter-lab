import { Matrix, eigen } from "./math";
import { checkCorrelation } from "./extraction";
import { minimize } from "./optimize";
import { EfaError, type EfaExtraction, type Progress } from "./types";
import type { WeightedMoments } from "./weighted-moments";

export const DWLS_METHOD =
  "DWLS pair correlations; reciprocal diagonal two-step sampling variances; analytic loading gradient; L-BFGS tolerance 1e-8; spectral start; unconstrained uniquenesses; no estimator substitution";

export function dwlsObjective(
  correlation: number[][],
  moments: WeightedMoments,
  k: number,
  parameters: number[],
) {
  let value = 0,
    correction = 0;
  const gradient = Array(parameters.length).fill(0);
  for (let a = 0; a < moments.pairs.length; a++) {
    const { i, j } = moments.pairs[a],
      weight = moments.weights[a];
    let predicted = 0;
    for (let f = 0; f < k; f++)
      predicted += parameters[i * k + f] * parameters[j * k + f];
    const residual = predicted - correlation[i][j],
      term = weight * residual * residual - correction,
      next = value + term;
    correction = next - value - term;
    value = next;
    for (let f = 0; f < k; f++) {
      gradient[i * k + f] += 2 * weight * residual * parameters[j * k + f];
      gradient[j * k + f] += 2 * weight * residual * parameters[i * k + f];
    }
  }
  return { value, gradient };
}

export function extractDwls(
  correlation: number[][],
  moments: WeightedMoments,
  k: number,
  progress?: Progress,
  maxIterations = 2000,
): EfaExtraction {
  const p = correlation.length;
  if (!Number.isInteger(k) || k < 1 || (p - k) ** 2 - p - k < 0)
    throw new EfaError("identification", "Underidentified factor count.");
  checkCorrelation(correlation);
  if (
    moments.pairs.length !== (p * (p - 1)) / 2 ||
    moments.weights.length !== moments.pairs.length ||
    Array.from(moments.weights).some((w) => !(w > 0) || !Number.isFinite(w))
  )
    throw new EfaError(
      "weighted-moments",
      "DWLS requires one finite, positive variance weight for every item pair.",
    );
  const { values, vectors } = eigen(new Matrix(correlation)),
    initial = Array.from(
      { length: p * k },
      (_, a) =>
        vectors.get(Math.floor(a / k), a % k) *
        Math.sqrt(Math.max(0.01, values[a % k] - 0.5)),
    ),
    optimized = minimize(
      (x) => dwlsObjective(correlation, moments, k, x),
      initial,
      maxIterations,
      1e-8,
      { code: "dwls-nonconvergence", label: "DWLS", progress },
    ),
    loadings = Array.from({ length: p }, (_, i) =>
      optimized.parameters.slice(i * k, (i + 1) * k),
    );
  return {
    method: DWLS_METHOD,
    loadings,
    uniquenessParameters: loadings.map(
      (row) => 1 - row.reduce((s, v) => s + v * v, 0),
    ),
    eigenvalues: values,
    boundaryItems: [],
    convergence: {
      converged: true,
      iterations: optimized.iterations,
      objective: optimized.value,
      gradient: optimized.gradientNorm,
      maxIterations,
    },
  };
}
