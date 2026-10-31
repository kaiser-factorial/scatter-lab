import { dot } from "./math";
import { EfaError, type Progress } from "./types";
export type Objective = (parameters: number[]) => {
  value: number;
  gradient: number[];
};
const infinityNorm = (values: number[]) =>
  values.reduce((norm, value) => Math.max(norm, Math.abs(value)), 0);

/** Unconstrained analytic-gradient L-BFGS with Armijo backtracking. */
export function minimize(
  objective: Objective,
  initial: number[],
  maxIterations = 500,
  tolerance = 1e-8,
  context?: { code: string; label: string; progress?: Progress },
) {
  let parameters = initial.slice(),
    state = objective(parameters),
    iteration = 0;
  const history: { s: number[]; y: number[]; rho: number }[] = [];
  for (; iteration < maxIterations; iteration++) {
    const norm = infinityNorm(state.gradient);
    context?.progress?.({
      stage: `${context.label} · gradient ${norm.toExponential(3)}`,
      completed: iteration,
      total: maxIterations,
    });
    if (Number.isFinite(state.value) && norm < tolerance)
      return {
        parameters,
        ...state,
        iterations: iteration,
        gradientNorm: norm,
      };
    let direction = state.gradient.slice();
    const alpha: number[] = [];
    for (let h = history.length - 1; h >= 0; h--) {
      const v = history[h];
      alpha[h] = v.rho * dot(v.s, direction);
      direction = direction.map((x, i) => x - alpha[h] * v.y[i]);
    }
    const last = history.at(-1),
      scale = last ? dot(last.s, last.y) / dot(last.y, last.y) : 1;
    direction = direction.map((x) => x * scale);
    for (let h = 0; h < history.length; h++) {
      const v = history[h],
        beta = v.rho * dot(v.y, direction);
      direction = direction.map((x, i) => x + v.s[i] * (alpha[h] - beta));
    }
    direction = direction.map((x) => -x);
    if (dot(direction, state.gradient) >= 0)
      direction = state.gradient.map((x) => -x);
    let step = 1,
      next = state,
      candidate = parameters,
      accepted = false;
    const slope = dot(direction, state.gradient);
    for (let line = 0; line < 45; line++) {
      candidate = parameters.map((x, i) => x + step * direction[i]);
      next = objective(candidate);
      const nextNorm = infinityNorm(next.gradient);
      if (
        Number.isFinite(next.value) &&
        (next.value <= state.value + 1e-4 * step * slope ||
          (next.value <=
            state.value +
              64 * Number.EPSILON * Math.max(1, Math.abs(state.value)) &&
            nextNorm < norm * 0.99))
      ) {
        accepted = true;
        break;
      }
      step *= 0.5;
    }
    if (!accepted) break;
    if (candidate.every((v, i) => v === parameters[i])) break;
    const s = candidate.map((x, i) => x - parameters[i]),
      y = next.gradient.map((x, i) => x - state.gradient[i]),
      sy = dot(s, y);
    if (sy > 1e-20) {
      history.push({ s, y, rho: 1 / sy });
      if (history.length > 12) history.shift();
    }
    parameters = candidate;
    state = next;
  }
  const finalNorm = infinityNorm(state.gradient);
  if (Number.isFinite(state.value) && finalNorm < tolerance)
    return {
      parameters,
      ...state,
      iterations: iteration,
      gradientNorm: finalNorm,
    };
  throw new EfaError(
    context?.code ?? "regression-nonconvergence",
    `${context?.label ?? "Conditional regression"} did not converge after ${iteration} iterations (gradient ${finalNorm}). No alternative model was substituted.`,
  );
}
