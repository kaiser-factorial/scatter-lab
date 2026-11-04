import { Matrix } from "./math";
import { covarianceQuadraticForms } from "./weighted-linalg";
import { rotate } from "./rotation";
import { matchFactors } from "./compare";
import {
  EfaError,
  type EfaRotation,
  type Progress,
  type Rotation,
} from "./types";
import type { IdentifiedLoadings } from "./weighted-inference";

export interface RotatedUncertainty {
  pattern: number[][];
  structure: number[][];
  phi: number[][];
  communalities: number[];
  uniquenesses: number[];
  method: string;
  derivativeMaxRelativeChange: number;
}

/** Full numerical delta map, including re-estimation of the rotation. Nothing
 * is aligned by a further continuous rotation: only signs and permutation. */
export function rotatedUncertainty(
  identified: IdentifiedLoadings,
  covariance: Matrix,
  reference: EfaRotation,
  method: Rotation,
  seed: number,
  progress?: Progress,
): RotatedUncertainty {
  const p = identified.loadings.length,
    k = identified.loadings[0].length,
    q = identified.free.length,
    outputs = 2 * p * k + k * k + p,
    bytes = 8 * outputs * q + 24 * q * q;
  if (bytes > 1024 ** 3)
    throw new EfaError(
      "weighted-budget",
      "Rotated uncertainty exceeds the worker memory budget. Reduce the item/factor set.",
    );
  const derivatives = Array.from(
    { length: outputs },
    () => new Float64Array(q),
  );
  const evaluate = (parameter: number, change: number) => {
    const loading = identified.loadings.map((row) => row.slice()),
      [i, f] = identified.free[parameter];
    loading[i][f] += change;
    const rotation = rotate(loading, method, seed, 4, true),
      match = matchFactors(reference.pattern, rotation.pattern);
    if (
      match.mapping.some((v) => v === null) ||
      match.congruence.some((v) => v === null || v < 0.99)
    )
      throw new EfaError(
        "weighted-rotation",
        "Rotation is not locally stable enough for standard errors. Inspect resampling stability; no fixed-rotation covariance was substituted.",
      );
    const pattern = rotation.pattern.map((row) =>
        match.mapping.map((j, a) => row[j!] * match.signs[a]),
      ),
      phi = match.mapping.map((i, a) =>
        match.mapping.map(
          (j, b) => rotation.phi[i!][j!] * match.signs[a] * match.signs[b],
        ),
      ),
      structure = new Matrix(pattern).mmul(new Matrix(phi)).to2DArray(),
      communalities = loading.map((row) => row.reduce((s, v) => s + v * v, 0));
    return [
      ...pattern.flat(),
      ...structure.flat(),
      ...phi.flat(),
      ...communalities,
    ];
  };
  let maxChange = 0;
  progress?.({ stage: "Rotated standard errors", completed: 0, total: q });
  for (let a = 0; a < q; a++) {
    const [i, f] = identified.free[a],
      h = 0.001 * (1 + Math.abs(identified.loadings[i][f])),
      hi = evaluate(a, h),
      lo = evaluate(a, -h),
      halfHi = evaluate(a, h / 2),
      halfLo = evaluate(a, -h / 2);
    for (let o = 0; o < outputs; o++) {
      const full = (hi[o] - lo[o]) / (2 * h),
        half = (halfHi[o] - halfLo[o]) / h,
        change = Math.abs(full - half) / Math.max(1, Math.abs(half));
      if (!Number.isFinite(change) || change > 0.005)
        throw new EfaError(
          "weighted-rotation",
          "Rotated standard errors failed the derivative step-stability check. No uncertainty estimate was published.",
        );
      maxChange = Math.max(maxChange, change);
      derivatives[o][a] = (4 * half - full) / 3;
    }
    progress?.({
      stage: "Rotated standard errors",
      completed: a + 1,
      total: q,
    });
  }
  progress?.({ stage: "Rotated covariance propagation", completed: 0, total: outputs });
  const variances = covarianceQuadraticForms(covariance, derivatives, progress);
  const se = Array.from(variances, (variance) => {
    if (!Number.isFinite(variance) || variance < -1e-12)
      throw new EfaError(
        "weighted-covariance",
        "Rotated uncertainty produced an inadmissible variance.",
      );
    const value = Math.sqrt(Math.max(0, variance));
    return value;
  });
  let offset = 0;
  const matrix = (rows: number, cols: number) =>
    Array.from({ length: rows }, () => {
      const row = se.slice(offset, offset + cols);
      offset += cols;
      return row;
    });
  const pattern = matrix(p, k),
    structure = matrix(p, k),
    phi = matrix(k, k),
    communalities = se.slice(offset);
  return {
    pattern,
    structure,
    phi,
    communalities,
    uniquenesses: communalities.slice(),
    derivativeMaxRelativeChange: maxChange,
    method:
      "Robust delta standard errors; full seeded rotation map with varimax convergence 1e-14 for derivatives; central differences h=.001*(1+abs(parameter)), half-step check and Richardson extrapolation; sign/permutation alignment only; denominator N-1",
  };
}
