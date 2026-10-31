import { Matrix, eigen, inverse, clamp, dot } from "./math";
import { EfaError, type EfaExtraction, type Progress } from "./types";
export const MINRES_METHOD =
  "MINRES compensated lower-triangle objective; analytic spectral gradient; projected BFGS; lower-objective SMC/unit-uniqueness initialization; uniqueness [.005,1]; gradient tolerance 1e-8";

export function checkCorrelation(r: number[][]) {
  const p = r.length;
  if (
    p < 3 ||
    r.some(
      (row, i) =>
        row.length !== p ||
        row.some(
          (v, j) =>
            !Number.isFinite(v) ||
            Math.abs(v) > 1 + 1e-10 ||
            Math.abs(v - r[j]?.[i]) > 1e-10,
        ) ||
        Math.abs(row[i] - 1) > 1e-10,
    )
  )
    throw new EfaError(
      "matrix",
      "Expected a finite, symmetric correlation matrix with unit diagonal.",
    );
  const e = eigen(new Matrix(r)),
    last = e.values[p - 1];
  if (last <= 1e-8)
    throw new EfaError(
      "inadmissible-matrix",
      `Correlation matrix is ${last < 0 ? "indefinite" : "singular"} (minimum eigenvalue ${last.toPrecision(5)}). Review missingness, redundant items, and sparse categories. No smoothing was applied.`,
    );
  return { eigenvalues: e.values, conditionNumber: e.values[0] / last };
}

/** Spectral MINRES objective: sum of squared lower-triangle residuals.
 * The gradient differentiates the truncated eigensystem, including its
 * eigenvectors. No finite differences, diagonal substitution, or PAF fallback.
 */
export function minresObjective(r: Matrix, k: number, psi: number[]) {
  const p = r.rows,
    b = r.clone();
  for (let i = 0; i < p; i++) b.set(i, i, 1 - psi[i]);
  const { values, vectors: u } = eigen(b);
  if (values[k - 1] <= 0)
    throw new EfaError(
      "rank",
      "The requested factor count exceeds the positive common-factor rank.",
    );
  const loadings = u.subMatrix(0, p - 1, 0, k - 1);
  for (let a = 0; a < k; a++) loadings.mulColumn(a, Math.sqrt(values[a]));
  const model = loadings.mmul(loadings.transpose()),
    d = Array.from({ length: p }, (_, i) => 1 - psi[i] - model.get(i, i));
  let objective = 0,
    compensation = 0;
  for (let i = 0; i < p; i++)
    for (let j = 0; j < i; j++) {
      // A 500-item null fit sums 124,750 small residuals. Compensated summation
      // keeps roundoff from hiding the last genuine optimization steps.
      const term = (model.get(i, j) - r.get(i, j)) ** 2 - compensation,
        next = objective + term;
      compensation = next - objective - term;
      objective = next;
    }
  const gradient = Array(p).fill(0);
  for (let a = 0; a < k; a++)
    for (let c = a; c < p; c++) {
      let eh = 0;
      for (let i = 0; i < p; i++) eh += u.get(i, a) * d[i] * u.get(i, c);
      const divided = c < k ? 1 : values[a] / (values[a] - values[c]);
      for (let i = 0; i < p; i++)
        gradient[i] -=
          (a === c ? 1 : 2) * divided * eh * u.get(i, a) * u.get(i, c);
    }
  return { objective, gradient, loadings: loadings.to2DArray(), values };
}

export function extractMinres(
  correlation: number[][],
  k: number,
  progress?: Progress,
  maxIterations = Math.max(500, 4 * correlation.length),
): EfaExtraction {
  const p = correlation.length;
  if (!Number.isInteger(k) || k < 1 || (p - k) ** 2 - p - k < 0)
    throw new EfaError("identification", "Underidentified factor count.");
  const { eigenvalues } = checkCorrelation(correlation),
    r = new Matrix(correlation),
    ri = inverse(r);
  let x = Array.from({ length: p }, (_, i) =>
      clamp(1 / ri.get(i, i), 0.005, 1),
    ),
    state = minresObjective(r, k, x);
  // Nearly independent null batteries can steer the SMC start toward a
  // coalescing retained/discarded eigenvalue pair. Evaluate a second fixed
  // starting point before optimization, retaining the lower same-objective
  // loss. This changes neither the estimator nor its convergence criterion.
  const initialization: NonNullable<EfaExtraction["initialization"]> = {
    selected: "smc",
    smcObjective: state.objective,
    unitUniquenessObjective: null,
  };
  // With uniqueness=1 the reduced eigenvalues are eigenvalues(R)-1. Skip an
  // unavailable starting rank; do not replace the requested factor count.
  if (eigenvalues[k - 1] > 1 + 1e-12) {
    const unitUniqueness = Array(p).fill(1),
      trial = minresObjective(r, k, unitUniqueness);
    initialization.unitUniquenessObjective = trial.objective;
    if (trial.objective < state.objective) {
      initialization.selected = "unit-uniqueness";
      x = unitUniqueness;
      state = trial;
    }
  }
  // At the supported maximum p=500, a dense inverse-Hessian costs 2 MB.
  // Retaining curvature across all item directions avoids the slow convergence
  // of short L-BFGS histories on nearly independent parallel-analysis nulls.
  const curvature = new Float64Array(p * p);
  for (let i = 0; i < p; i++) curvature[i * p + i] = 1;
  let converged = false,
    iteration = 0,
    pgNorm = Infinity;
  for (; iteration < maxIterations; iteration++) {
    const pg = state.gradient.map((g, i) =>
      (x[i] <= 0.005 + 1e-12 && g > 0) || (x[i] >= 1 - 1e-12 && g < 0) ? 0 : g,
    );
    pgNorm = Math.max(...pg.map(Math.abs));
    progress?.({
      stage: `MINRES · projected gradient ${pgNorm.toExponential(3)}`,
      completed: iteration,
      total: maxIterations,
    });
    // Below 1e-8 the 500-item spectral objective can be flat at floating-point
    // precision. This optimizer tolerance is separately checked against the
    // unchanged R parity tolerances, rather than accepting small steps alone.
    if (pgNorm < 1e-8) {
      converged = true;
      break;
    }
    let direction = Array.from({ length: p }, (_, i) => {
      let value = 0;
      for (let j = 0; j < p; j++) value -= curvature[i * p + j] * pg[j];
      return value;
    });
    direction = direction.map((v, i) =>
      pg[i] === 0 ||
      (x[i] <= 0.005 + 1e-12 && v < 0) ||
      (x[i] >= 1 - 1e-12 && v > 0)
        ? 0
        : v,
    );
    if (dot(direction, state.gradient) >= 0) direction = pg.map((v) => -v);
    let step = 1,
      accepted = false,
      next = state,
      nx = x;
    for (let ls = 0; ls < 40; ls++) {
      nx = x.map((v, i) => clamp(v + step * direction[i], 0.005, 1));
      next = minresObjective(r, k, nx);
      const nextNorm = Math.max(
        ...next.gradient.map((g, i) =>
          (nx[i] <= 0.005 + 1e-12 && g > 0) || (nx[i] >= 1 - 1e-12 && g < 0)
            ? 0
            : Math.abs(g),
        ),
      );
      const roundoff = 64 * Number.EPSILON * Math.max(1, state.objective);
      if (
        next.objective <=
          state.objective +
            1e-4 *
              dot(
                state.gradient,
                nx.map((v, i) => v - x[i]),
              ) ||
        (next.objective <= state.objective + roundoff &&
          nextNorm < pgNorm * 0.99)
      ) {
        accepted = true;
        break;
      }
      step *= 0.5;
    }
    if (!accepted) break;
    if (nx.every((v, i) => v === x[i])) break;
    const s = nx.map((v, i) => v - x[i]),
      y = next.gradient.map((v, i) => v - state.gradient[i]),
      sy = dot(s, y);
    if (sy > 1e-18) {
      if (iteration === 0) {
        const scale = sy / dot(y, y);
        curvature.fill(0);
        for (let i = 0; i < p; i++) curvature[i * p + i] = scale;
      }
      const hy = Array.from({ length: p }, (_, i) => {
        let value = 0;
        for (let j = 0; j < p; j++) value += curvature[i * p + j] * y[j];
        return value;
      });
      const coefficient = (sy + dot(y, hy)) / (sy * sy);
      for (let i = 0; i < p; i++)
        for (let j = 0; j <= i; j++) {
          const value =
            curvature[i * p + j] +
            coefficient * s[i] * s[j] -
            (hy[i] * s[j] + s[i] * hy[j]) / sy;
          curvature[i * p + j] = value;
          curvature[j * p + i] = value;
        }
    }
    x = nx;
    state = next;
  }
  if (!converged) {
    pgNorm = Math.max(
      ...state.gradient.map((g, i) =>
        (x[i] <= 0.005 + 1e-12 && g > 0) || (x[i] >= 1 - 1e-12 && g < 0)
          ? 0
          : Math.abs(g),
      ),
    );
    converged = pgNorm < 1e-8;
  }
  if (!converged)
    throw new EfaError(
      "minres-nonconvergence",
      `MINRES did not converge after ${iteration} iterations (objective ${state.objective}, projected gradient ${pgNorm}). No alternative extractor was used.`,
    );
  return {
    method: `${MINRES_METHOD}; selected ${initialization.selected}`,
    initialization,
    loadings: state.loadings,
    uniquenessParameters: x,
    eigenvalues,
    boundaryItems: x.flatMap((v, i) =>
      v < 0.005001 || v > 0.999999 ? [i] : [],
    ),
    convergence: {
      converged,
      iterations: iteration,
      objective: state.objective,
      gradient: pgNorm,
      maxIterations,
    },
  };
}
