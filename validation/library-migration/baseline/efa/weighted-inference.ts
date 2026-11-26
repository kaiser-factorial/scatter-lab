import { isTraceEstimate, type TraceEstimate, type TraceEstimateTask, type TraceEstimator } from "./trace-estimation";
import { CholeskyDecomposition } from "ml-matrix";
import { projectCases, normalizeCaseProjections } from "./weighted-linalg";
import { Matrix } from "./math";
import { EfaError, type EfaPreparedData, type Progress } from "./types";
import { influenceAt, type WeightedMoments } from "./weighted-moments";
import { chiSquareSf } from "../statTests";
import { cpuTraceBlock, type RobustTraceBlock, type TraceKernel } from "./trace-kernel";

export interface IdentifiedLoadings {
  loadings: number[][];
  anchors: number[];
  free: [number, number][];
  index: number[][];
}
export interface WeightedTest {
  traceEstimation?: TraceEstimate;
  rawStatistic: number;
  df: number;
  trace: number;
  traceSquared: number;
  scalingFactor: number | null;
  shift: number | null;
  statistic: number | null;
  denominator: number;
  pValue: number | null;
}
export interface InferencePlan {
  space: "moments" | "cases";
  parameters: number;
  pairs: number;
  rows: number;
  blockSize: number;
  estimatedBytes: number;
  budgetBytes: number;
  approximateMultiplyAdds: number;
}

/** Choose anchor rows by residual norm. Their triangular orientation removes
 * only the k(k-1)/2 orthogonal indeterminacies, not substantive cross-loadings. */
export function identifyLoadings(loadings: number[][]): IdentifiedLoadings {
  const p = loadings.length,
    k = loadings[0].length,
    residual = loadings.map((row) => row.slice()),
    basis: number[][] = [],
    anchors: number[] = [];
  for (let f = 0; f < k; f++) {
    let best = -1,
      norm = 0;
    for (let i = 0; i < p; i++) {
      const s = residual[i].reduce((sum, v) => sum + v * v, 0);
      if (s > norm) {
        best = i;
        norm = s;
      }
    }
    if (best < 0 || norm < 1e-12)
      throw new EfaError(
        "weighted-rank",
        "The fitted loadings do not have enough independent directions for uncertainty estimation.",
      );
    const v = residual[best].map((x) => x / Math.sqrt(norm));
    basis.push(v);
    anchors.push(best);
    for (let i = 0; i < p; i++) {
      const projection = residual[i].reduce((sum, x, j) => sum + x * v[j], 0);
      for (let j = 0; j < k; j++) residual[i][j] -= projection * v[j];
    }
  }
  const canonical = loadings.map((row) =>
      basis.map((v) => row.reduce((sum, x, j) => sum + x * v[j], 0)),
    ),
    index = Array.from({ length: p }, () => Array(k).fill(-1)),
    free: [number, number][] = [];
  for (let i = 0; i < p; i++)
    for (let f = 0; f < k; f++) {
      const anchor = anchors.indexOf(i);
      if (anchor >= 0 && f > anchor) {
        canonical[i][f] = 0;
        continue;
      }
      index[i][f] = free.length;
      free.push([i, f]);
    }
  return { loadings: canonical, anchors, free, index };
}

/** Every dense allocation is bounded before work starts. Small problems use
 * moment space; large batteries use symmetric case blocks, never dense Gamma. */
export function planWeightedInference(
  p: number,
  k: number,
  n: number,
  lookupCells = (25 * p * (p - 1)) / 2,
  options: {
    space?: "moments" | "cases";
    budgetBytes?: number;
    blockSize?: number;
    correction?: "exact" | "estimated";
    probes?: number;
    probeSeed?: number;
  } = {},
): InferencePlan {
  const m = (p * (p - 1)) / 2,
    q = p * k - (k * (k - 1)) / 2,
    blockSize = options.blockSize ?? 32,
    budgetBytes = options.budgetBytes ?? 1024 ** 3;
  if (
    !Number.isInteger(p) ||
    p < 3 ||
    !Number.isInteger(k) ||
    k < 1 ||
    q > m ||
    !Number.isInteger(n) ||
    n < 3 ||
    !Number.isInteger(blockSize) ||
    blockSize < 1 ||
    blockSize > 256 ||
    !Number.isFinite(budgetBytes) ||
    budgetBytes <= 0
  )
    throw new EfaError(
      "weighted-budget",
      "Invalid dimensions or memory budget for weighted uncertainty.",
    );
  const common =
    6 * q * q * 8 +
    3 * p * n +
    8 * lookupCells +
    16 * p * k +
    16 * blockSize * m;
  const momentBytes = 1.2 * (common + 8 * (5 * m * m + 4 * m * q)),
    // One typed copy of L plus the compact <=2k-entry pair Jacobian.
    caseBytes = 1.2 * (common + 8 * n * q + 8 * q * q + 24 * m * k + 4 * (m + 1));
  const space =
      (options.correction === "estimated" ? "cases" : options.space) ??
      (m < n && momentBytes <= budgetBytes ? "moments" : "cases"),
    estimatedBytes = space === "moments" ? momentBytes : caseBytes;
  if (estimatedBytes > budgetBytes)
    throw new EfaError(
      "weighted-budget",
      `WLSMV uncertainty needs an estimated ${Math.ceil(estimatedBytes / 1024 ** 2)} MiB, above the ${Math.floor(budgetBytes / 1024 ** 2)} MiB worker budget. Reduce the item/factor set or run DWLS point fitting explicitly. No method was substituted.`,
    );
  return {
    space,
    parameters: q,
    pairs: m,
    rows: n,
    blockSize,
    estimatedBytes,
    budgetBytes,
    approximateMultiplyAdds:
      space === "moments"
        ? (n * m * m) / 2 + 2 * m * m * q + 2 * q * q * m
        : (options.correction === "estimated" ? 2 * n * (m + q) * (options.probes ?? 128) : (n * n * (m + q)) / 2) + n * q * q + 2 * q * q * q,
  };
}

function jacobian(identified: IdentifiedLoadings, i: number, j: number) {
  const entries: [number, number][] = [];
  for (let f = 0; f < identified.loadings[0].length; f++) {
    if (identified.index[i][f] >= 0)
      entries.push([identified.index[i][f], identified.loadings[j][f]]);
    if (identified.index[j][f] >= 0)
      entries.push([identified.index[j][f], identified.loadings[i][f]]);
  }
  return entries;
}

function testResult(
  objective: number,
  n: number,
  df: number,
  trace: number,
  traceSquared: number,
): WeightedTest {
  if (
    !Number.isFinite(trace) ||
    !Number.isFinite(traceSquared) ||
    trace < -1e-8 ||
    traceSquared < -1e-8 ||
    (df > 0 && !(traceSquared > 0))
  )
    throw new EfaError(
      "weighted-test",
      "The robust test correction is numerically inadmissible.",
    );
  const scalingFactor = df > 0 ? Math.sqrt(traceSquared / df) : null,
    shift = scalingFactor ? df - trace / scalingFactor : null,
    rawStatistic = (n - 1) * objective;
  return {
    rawStatistic,
    df,
    trace,
    traceSquared,
    scalingFactor,
    shift,
    statistic: scalingFactor ? rawStatistic / scalingFactor + shift! : null,
    denominator: n - 1,
    pValue: scalingFactor
      ? chiSquareSf(rawStatistic / scalingFactor + shift!, df)
      : null,
  };
}

/** Internal covariance uses the deterministic canonical loading orientation.
 * Public rotated SEs must differentiate the rotation, not hold it fixed. */
export function* weightedInferenceSteps(
  data: EfaPreparedData,
  moments: WeightedMoments,
  loadings: number[][],
  objective: number,
  progress?: Progress,
  options: Parameters<typeof planWeightedInference>[4] = {},
): Generator<RobustTraceBlock | TraceEstimateTask, { identified: IdentifiedLoadings; covariance: Matrix; test: WeightedTest; plan: InferencePlan }, Float64Array | TraceEstimate> {
  const p = loadings.length,
    k = loadings[0].length,
    n = data.nRows,
    m = moments.pairs.length,
    plan = planWeightedInference(
      p,
      k,
      n,
      moments.pairs.reduce((s, v) => s + v.values.length, 0),
      options,
    ),
    identified = identifyLoadings(loadings),
    q = identified.free.length,
    information = Matrix.zeros(q, q);
  if (m !== plan.pairs || moments.nRows !== n)
    throw new EfaError(
      "weighted-snapshot",
      "Uncertainty moments do not match the fitting snapshot.",
    );
  progress?.({ stage: "Weighted information matrix", completed: 0, total: m });
  for (let a = 0; a < m; a++) {
    const { i, j } = moments.pairs[a],
      entries = jacobian(identified, i, j),
      w = moments.weights[a];
    for (const [u, x] of entries)
      for (const [v, y] of entries)
        if (u >= v) information.set(u, v, information.get(u, v) + w * x * y);
  }
  progress?.({ stage: "Weighted information matrix", completed: m, total: m });
  progress?.({ stage: "Information factorization", completed: 0, total: 1 });
  for (let a = 0; a < q; a++)
    for (let b = 0; b < a; b++) information.set(b, a, information.get(a, b));
  const cholesky = new CholeskyDecomposition(information);
  if (!cholesky.isPositiveDefinite())
    throw new EfaError(
      "weighted-information",
      "The identified weighted information is singular. Review the factor count and weak or redundant factors.",
    );
  const lower = cholesky.lowerTriangularMatrix,
    diagonal = lower.diag();
  if (Math.min(...diagonal) / Math.max(...diagonal) < 1e-7)
    throw new EfaError(
      "weighted-information",
      "The identified weighted information is too ill-conditioned for stable uncertainty.",
    );
  progress?.({ stage: "Information factorization", completed: 1, total: 1 });
  let traceEstimation: TraceEstimate | undefined;
  let covariance: Matrix,
    trace = 0,
    traceSquared = 0;
  if (plan.space === "moments") {
    const gamma = Matrix.zeros(m, m),
      wj = Matrix.zeros(m, q);
    for (let row = 0; row < n; row++) {
      const scores = moments.pairs.map((pair) => influenceAt(data, pair, row));
      for (let a = 0; a < m; a++)
        for (let b = 0; b <= a; b++)
          gamma.set(a, b, gamma.get(a, b) + (scores[a] * scores[b]) / n);
      if (row % 128 === 0)
        progress?.({
          stage: "Robust moment covariance",
          completed: row,
          total: n,
        });
    }
    for (let a = 0; a < m; a++) {
      for (let b = 0; b < a; b++) gamma.set(b, a, gamma.get(a, b));
      for (const [v, x] of jacobian(
        identified,
        moments.pairs[a].i,
        moments.pairs[a].j,
      ))
        wj.set(a, v, moments.weights[a] * x);
    }
    const influence = cholesky.solve(wj.transpose()),
      u = wj.mmul(influence).neg();
    for (let a = 0; a < m; a++) u.set(a, a, u.get(a, a) + moments.weights[a]);
    covariance = influence
      .mmul(gamma)
      .mmul(influence.transpose())
      .div(n - 1);
    const product = u.mmul(gamma);
    for (let a = 0; a < m; a++) {
      trace += product.get(a, a);
      for (let b = 0; b < m; b++)
        traceSquared += product.get(a, b) * product.get(b, a);
    }
  } else {
    // Z = S W J L^-T / sqrt(N), with G = L L'. Store only N-by-q.
    const z = projectCases(data, moments, identified, progress);
    const { meat, inverseLower } = normalizeCaseProjections(z, lower, progress);
    progress?.({ stage: "Covariance matrix products", completed: 0, total: 2 });
    covariance = inverseLower.transpose().mmul(meat);
    progress?.({ stage: "Covariance matrix products", completed: 1, total: 2 });
    covariance = covariance.mmul(inverseLower).div(n - 1);
    progress?.({ stage: "Covariance matrix products", completed: 2, total: 2 });
    const rootWeights = Float64Array.from(moments.weights, weight => Math.sqrt(weight / n));
    // Each weighted influence column has unit squared norm by construction.
    // Z'Z was already accumulated for covariance, so this trace needs no Gram entries.
    let projectionNorm = 0, projectionCorrection = 0;
    for (const value of meat.diag()) {
      const term = value - projectionCorrection, next = projectionNorm + term;
      projectionCorrection = next - projectionNorm - term; projectionNorm = next;
    }
    trace = m - projectionNorm;
    const source = { nRows: n, codes: data.codes, observed: data.fittingObserved ?? data.observed, pairs: moments.pairs, rootWeights, projection: z };
    if (options.correction === "estimated") {
      const estimate = yield { kind: "estimate", source, probes: options.probes ?? 128, seed: options.probeSeed ?? 61001 };
      if (!isTraceEstimate(estimate) || estimate.probes !== (options.probes ?? 128) || estimate.requestedProbes !== estimate.probes || estimate.seed !== (options.probeSeed ?? 61001) || !(estimate.traceSquared >= 0) || !Number.isFinite(estimate.traceSquared))
        throw new EfaError("trace-estimate", "Incomplete or invalid MV trace estimate. No corrected result was published.");
      traceEstimation = estimate;
      traceSquared = estimate.traceSquared;
    } else {
    const block = (start: number) =>
        Array.from(
          { length: Math.min(plan.blockSize, n - start) },
          (_, offset) =>
            Float64Array.from(
              moments.pairs,
              (pair, a) =>
                influenceAt(data, pair, start + offset) *
                rootWeights[a],
            ),
        ),
      blocks = Math.ceil(n / plan.blockSize),
      total = (blocks * (blocks + 1)) / 2;
    let completed = 0;
    progress?.({ stage: "Exact robust trace blocks", completed, total });
    for (let start = 0; start < n; start += plan.blockSize) {
      const aLength = Math.min(plan.blockSize, n - start);
      let aBlock: Float64Array[] | undefined;
      for (let next = 0; next <= start; next += plan.blockSize) {
        const bLength = Math.min(plan.blockSize, n - next);
        let bBlock: Float64Array[] | undefined;
        const values = yield {
          get left() { return aBlock ??= block(start); },
          get right() { return next === start ? aBlock ??= block(start) : bBlock ??= block(next); },
          leftProjection: z.slice(start, start + aLength),
          rightProjection: z.slice(next, next + bLength),
          diagonal: next === start,
          ordinal: { source, leftStart: start, rightStart: next, leftRows: aLength, rightRows: bLength },
        };
        if (!(values instanceof Float64Array) || values.length !== aLength * bLength)
          throw new EfaError("weighted-kernel", "The trace kernel returned an incorrect block shape.");
        for (let a = 0; a < aLength; a++)
          for (let b = 0; b < bLength; b++) {
            if (next === start && b > a) continue;
            const h = values[a * bLength + b];
            if (!Number.isFinite(h)) throw new EfaError("weighted-kernel", "The trace kernel returned a non-finite value.");
            const diagonal = start + a === next + b;
            traceSquared += (diagonal ? 1 : 2) * h * h;
          }
        progress?.({
          stage: "Exact robust trace blocks",
          completed: ++completed,
          total,
        });
      }
    }
  }
  }
  if (covariance.diag().some((v) => !Number.isFinite(v) || v < 0))
    throw new EfaError(
      "weighted-covariance",
      "Robust parameter covariance is numerically inadmissible.",
    );
  return {
    identified,
    covariance,
    test: { ...testResult(objective, n, m - q, trace, traceSquared), ...(traceEstimation ? { traceEstimation } : {}) },
    plan,
  };
}

/** Production synchronous path. The generator isolates a kernel boundary
 * without changing covariance, normalization, trace reduction, or inference. */
export function weightedInference(...args: Parameters<typeof weightedInferenceSteps>) {
  const steps = weightedInferenceSteps(...args);
  let state = steps.next();
  while (!state.done) {
    if ("kind" in state.value) throw new EfaError("trace-async", "Estimated MV correction requires the asynchronous EFA service.");
    state = steps.next(cpuTraceBlock(state.value));
  }
  return state.value;
}

/** Experimental benchmark entry point; no UI estimator substitution. */
export async function weightedInferenceWithKernel(kernel: TraceKernel, ...args: Parameters<typeof weightedInferenceSteps>) {
  const steps = weightedInferenceSteps(...args);
  try {
    let state = steps.next();
    while (!state.done) {
      if ("kind" in state.value) throw new EfaError("trace-async", "Use the matrix-product estimator for estimated MV correction.");
      state = steps.next(await kernel(state.value));
    }
    return state.value;
  } finally { steps.return(undefined as never); }
}

export async function weightedInferenceWithEstimator(estimate: TraceEstimator, ...args: Parameters<typeof weightedInferenceSteps>) {
  const steps = weightedInferenceSteps(...args);
  try {
    const state = steps.next();
    if (state.done || !("kind" in state.value)) throw new EfaError("trace-settings", "Estimated MV correction was not requested.");
    const result = steps.next(await estimate(state.value));
    if (!result.done) throw new EfaError("trace-estimate", "MV estimator did not finish.");
    return result.value;
  } finally { steps.return(undefined as never); }
}
