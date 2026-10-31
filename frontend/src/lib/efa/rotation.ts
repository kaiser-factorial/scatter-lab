import { SingularValueDecomposition } from "ml-matrix";
import { Matrix, inverse, solve } from "./math";
import { mulberry32 } from "../random";
import { EfaError, type EfaRotation, type Rotation } from "./types";

function polar(a: Matrix) {
  const s = new SingularValueDecomposition(a);
  return s.leftSingularVectors.mmul(s.rightSingularVectors.transpose());
}
function normalizeColumns(a: Matrix) {
  for (let j = 0; j < a.columns; j++) {
    const n = Math.hypot(...a.getColumn(j));
    if (n < 1e-12) throw new Error("Singular rotation");
    a.mulColumn(j, 1 / n);
  }
  return a;
}
function quartimin(l: Matrix) {
  const g = l.clone();
  let objective = 0,
    compensation = 0;
  for (let i = 0; i < l.rows; i++) {
    let sum = 0;
    for (let j = 0; j < l.columns; j++) sum += l.get(i, j) ** 2;
    for (let j = 0; j < l.columns; j++) {
      const v = l.get(i, j),
        other = sum - v * v;
      g.set(i, j, v * other);
      const term = (v * v * other) / 4 - compensation,
        next = objective + term;
      compensation = next - objective - term;
      objective = next;
    }
  }
  return { objective, g };
}
function projectedRotationGradient(
  t: Matrix,
  inv: Matrix,
  l: Matrix,
  gradient: Matrix,
) {
  const g = l.transpose().mmul(gradient).mmul(inv).transpose().neg(),
    pg = g.clone();
  for (let j = 0; j < t.columns; j++) {
    let projection = 0;
    for (let i = 0; i < t.rows; i++) projection += t.get(i, j) * g.get(i, j);
    for (let i = 0; i < t.rows; i++)
      pg.set(i, j, g.get(i, j) - t.get(i, j) * projection);
  }
  return pg;
}
function oblimin(a: Matrix, start: Matrix): EfaRotation {
  let t = start,
    inv = inverse(t),
    l = a.mmul(inv.transpose()),
    state = quartimin(l),
    step = 1,
    gn = Infinity,
    iteration = 0;
  for (; iteration < 4000; iteration++) {
    const pg = projectedRotationGradient(t, inv, l, state.g);
    gn = pg.norm();
    if (gn < 1e-8) break;
    step = Math.min(step * 2, 100);
    let accepted = false;
    for (let ls = 0; ls < 40; ls++) {
      try {
        const nt = normalizeColumns(Matrix.sub(t, Matrix.mul(pg, step))),
          ni = inverse(nt),
          nl = a.mmul(ni.transpose()),
          ns = quartimin(nl);
        if (
          ns.objective <= state.objective - 0.5 * step * gn * gn ||
          (ns.objective <=
            state.objective +
              64 * Number.EPSILON * Math.max(1, Math.abs(state.objective)) &&
            projectedRotationGradient(nt, ni, nl, ns.g).norm() < gn * 0.99)
        ) {
          t = nt;
          inv = ni;
          l = nl;
          state = ns;
          accepted = true;
          break;
        }
      } catch {
        /* A singular trial is rejected by the line search. */
      }
      step *= 0.5;
    }
    if (!accepted) break;
  }
  gn = projectedRotationGradient(t, inv, l, state.g).norm();
  return {
    pattern: l.to2DArray(),
    phi: t.transpose().mmul(t).to2DArray(),
    starts: 1,
    convergence: {
      converged: gn < 1e-8,
      iterations: iteration,
      objective: state.objective,
      gradient: gn,
      maxIterations: 4000,
    },
  };
}
function varimax(
  a: Matrix,
  initial = Matrix.eye(a.columns),
  tolerance = 1e-9,
): EfaRotation & { transform: Matrix } {
  const norm = a.to2DArray().map((row) => Math.hypot(...row)),
    x = a.clone();
  for (let i = 0; i < a.rows; i++) if (norm[i] > 0) x.mulRow(i, 1 / norm[i]);
  let t = initial,
    d = 0,
    iteration = 0,
    converged = false;
  for (; iteration < 2000; iteration++) {
    const l = x.mmul(t),
      target = l.clone(),
      ss = l
        .to2DArray()
        .reduce(
          (s, row) => s.map((v, j) => v + row[j] ** 2),
          Array(a.columns).fill(0),
        );
    for (let i = 0; i < l.rows; i++)
      for (let j = 0; j < l.columns; j++)
        target.set(i, j, l.get(i, j) ** 3 - (l.get(i, j) * ss[j]) / l.rows);
    const svd = new SingularValueDecomposition(x.transpose().mmul(target));
    t = svd.leftSingularVectors.mmul(svd.rightSingularVectors.transpose());
    const next = svd.diagonal.reduce((s, v) => s + v, 0);
    if (next < d * (1 + tolerance)) {
      converged = true;
      d = next;
      break;
    }
    d = next;
  }
  return {
    pattern: a.mmul(t).to2DArray(),
    phi: Matrix.eye(a.columns).to2DArray(),
    transform: t,
    starts: 1,
    convergence: {
      converged,
      iterations: iteration,
      objective: -d,
      gradient: 0,
    },
  };
}
export function rotate(
  loadings: number[][],
  method: Rotation,
  seed = 73021,
  starts = 4,
): EfaRotation {
  const a = new Matrix(loadings),
    k = a.columns;
  if (k === 1)
    return {
      pattern: loadings.map((row) => row.slice()),
      phi: [[1]],
      starts: 1,
      convergence: {
        converged: true,
        iterations: 0,
        objective: 0,
        gradient: 0,
      },
    };
  if (method === "promax") {
    // stats::promax uses normalized varimax's default eps=1e-5.
    const v = varimax(a, Matrix.eye(k), 1e-5);
    if (!v.convergence.converged)
      throw new EfaError(
        "rotation-nonconvergence",
        "Promax initial varimax failed to converge.",
      );
    const l = new Matrix(v.pattern),
      target = l.clone();
    for (let i = 0; i < l.rows; i++)
      for (let j = 0; j < k; j++)
        target.set(i, j, l.get(i, j) * Math.abs(l.get(i, j)) ** 3);
    const u = solve(l.transpose().mmul(l), l.transpose().mmul(target)),
      ui = inverse(u.transpose().mmul(u));
    for (let j = 0; j < k; j++) u.mulColumn(j, Math.sqrt(ui.get(j, j)));
    const transform = v.transform.mmul(u),
      ti = inverse(transform);
    return {
      pattern: a.mmul(transform).to2DArray(),
      phi: ti.mmul(ti.transpose()).to2DArray(),
      starts: 1,
      convergence: {
        ...v.convergence,
        objective: Matrix.sub(l.mmul(u), target).norm() ** 2,
      },
    };
  }
  const random = mulberry32(seed);
  let best: EfaRotation | undefined;
  const attempts: EfaRotation["convergence"][] = [];
  for (let s = 0; s < starts; s++) {
    const initial =
      s === 0
        ? Matrix.eye(k)
        : polar(
            new Matrix(
              Array.from({ length: k }, () =>
                Array.from({ length: k }, () => random() * 2 - 1),
              ),
            ),
          );
    const candidate =
      method === "oblimin" ? oblimin(a, initial) : varimax(a, initial);
    attempts.push(candidate.convergence);
    if (
      candidate.convergence.converged &&
      (!best || candidate.convergence.objective < best.convergence.objective)
    )
      best = candidate;
  }
  if (!best)
    throw new EfaError(
      "rotation-nonconvergence",
      `${method} did not converge in ${starts} deterministic starts.`,
      attempts.map((attempt, i) => ({
        code: "rotation-start",
        message: `Start ${i + 1}: ${attempt.iterations} iterations, objective ${attempt.objective}, gradient ${attempt.gradient}.`,
      })),
    );
  return {
    pattern: best.pattern,
    phi: best.phi,
    convergence: best.convergence,
    starts,
  };
}
