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

/** Only the small rotation specification crosses worker boundaries. The
 * respondent data and parameter covariance remain in the fitting worker. */
export interface RotationDerivativeContext {
  identified: Pick<IdentifiedLoadings, "loadings" | "free">;
  referencePattern: number[][];
  method: Rotation;
  seed: number;
}
export interface RotationDerivativeBatch {
  start: number;
  count: number;
  values: Float64Array; // parameter-major, transferable, bounded batch
  maxChange: number;
}
export function rotationDerivativeContext(
  identified: Pick<IdentifiedLoadings, "loadings" | "free">, reference: Pick<EfaRotation, "pattern">, method: Rotation, seed: number,
): RotationDerivativeContext {
  return { identified: { loadings: identified.loadings, free: identified.free }, referencePattern: reference.pattern, method, seed };
}
function dimensions(context: RotationDerivativeContext) {
  const p = context.identified.loadings.length, k = context.identified.loadings[0].length,
    q = context.identified.free.length, outputs = 2 * p * k + k * k + p;
  if (8 * outputs * q + 24 * q * q > 1024 ** 3)
    throw new EfaError("weighted-budget", "Rotated uncertainty exceeds the worker memory budget. Reduce the item/factor set.");
  return { p, k, q, outputs };
}
/** All four perturbations, seeded starts, alignment and step checks are the
 * same in the sequential and parallel paths. No reduction crosses parameters. */
export function rotationDerivativeBatch(
  context: RotationDerivativeContext, start: number, count: number, progress?: Progress,
): RotationDerivativeBatch {
  const { identified, referencePattern, method, seed } = context;
  const { q, outputs } = dimensions(context);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count < 1 || count > 16 || start + count > q)
    throw new EfaError("weighted-rotation-batch", "Invalid rotation derivative range.");
  const values = new Float64Array(count * outputs);
  const evaluate = (parameter: number, change: number) => {
    const loading = identified.loadings.map((row) => row.slice()),
      [i, f] = identified.free[parameter];
    loading[i][f] += change;
    const rotation = rotate(loading, method, seed, 4, true),
      match = matchFactors(referencePattern, rotation.pattern);
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
  for (let a = start; a < start + count; a++) {
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
      values[(a - start) * outputs + o] = (4 * half - full) / 3;
    }
    progress?.({
      stage: "Rotated standard errors",
      completed: a + 1,
      total: q,
    });
  }
  return { start, count, values, maxChange };
}

/** Accept out-of-order batches once, then propagate in original parameter
 * order. Incomplete/duplicate/malformed work can never publish uncertainty. */
export class RotationDerivativeAccumulator {
  private readonly derivatives: Float64Array[];
  private readonly received: Uint8Array;
  private maxChange = 0;
  completed = 0;
  constructor(readonly context: RotationDerivativeContext) {
    const { q, outputs } = dimensions(context);
    this.derivatives = Array.from({ length: outputs }, () => new Float64Array(q));
    this.received = new Uint8Array(q);
  }
  add(batch: RotationDerivativeBatch) {
    const { start, count, values, maxChange } = batch, { q, outputs } = dimensions(this.context);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count < 1 || count > 16 || start + count > q ||
        !(values instanceof Float64Array) || values.length !== count * outputs || values.some(v => !Number.isFinite(v)) ||
        !Number.isFinite(maxChange) || maxChange < 0 || maxChange > .005 || this.received.subarray(start, start + count).some(Boolean))
      throw new EfaError("weighted-rotation-batch", "Malformed or duplicate rotation derivative batch.");
    for (let a = 0; a < count; a++) {
      for (let o = 0; o < outputs; o++) this.derivatives[o][start + a] = values[a * outputs + o];
      this.received[start + a] = 1;
    }
    this.maxChange = Math.max(this.maxChange, maxChange);
    this.completed += count;
  }
  finish(covariance: Matrix, progress?: Progress): RotatedUncertainty {
    const { p, k, q, outputs } = dimensions(this.context);
    if (this.completed !== q) throw new EfaError("weighted-rotation-batch", "Rotation derivatives are incomplete.");
    progress?.({ stage: "Rotated covariance propagation", completed: 0, total: outputs });
    const variances = covarianceQuadraticForms(covariance, this.derivatives, progress);
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
      derivativeMaxRelativeChange: this.maxChange,
      method:
        "Robust delta standard errors; full seeded rotation map with varimax convergence 1e-14 for derivatives; central differences h=.001*(1+abs(parameter)), half-step check and Richardson extrapolation; sign/permutation alignment only; denominator N-1",
    };
  }
}

/** Full numerical delta map. Signs/permutation only; never another rotation. */
export function rotatedUncertainty(
  identified: Pick<IdentifiedLoadings, "loadings" | "free">, covariance: Matrix, reference: Pick<EfaRotation, "pattern">,
  method: Rotation, seed: number, progress?: Progress,
): RotatedUncertainty {
  const context = rotationDerivativeContext(identified, reference, method, seed), accumulator = new RotationDerivativeAccumulator(context), q = identified.free.length;
  progress?.({ stage: "Rotated standard errors", completed: 0, total: q });
  for (let start = 0; start < q; start += 8)
    accumulator.add(rotationDerivativeBatch(context, start, Math.min(8, q - start), progress));
  return accumulator.finish(covariance, progress);
}

export type RotationBatchExecutor = (context: RotationDerivativeContext, start: number, count: number, slot: number) => Promise<RotationDerivativeBatch>;
export async function rotatedUncertaintyParallel(
  identified: Pick<IdentifiedLoadings, "loadings" | "free">, covariance: Matrix, reference: Pick<EfaRotation, "pattern">, method: Rotation, seed: number,
  execute: RotationBatchExecutor, concurrency: number, progress?: Progress,
): Promise<RotatedUncertainty> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4)
    throw new EfaError("weighted-rotation-batch", "Rotation concurrency must be between one and four.");
  const context = rotationDerivativeContext(identified, reference, method, seed), accumulator = new RotationDerivativeAccumulator(context), q = identified.free.length;
  let next = 0;
  progress?.({ stage: "Rotated standard errors", completed: 0, total: q });
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.ceil(q / 8)) }, async (_, slot) => {
    while (next < q) {
      const start = next, count = Math.min(8, q - start); next += count;
      const batch = await execute(context, start, count, slot);
      if (batch.start !== start || batch.count !== count) throw new EfaError("weighted-rotation-batch", "Rotation worker returned the wrong range.");
      accumulator.add(batch);
      progress?.({ stage: "Rotated standard errors", completed: accumulator.completed, total: q });
    }
  }));
  return accumulator.finish(covariance, progress);
}
