import { EigenvalueDecomposition, Matrix, inverse, solve } from "ml-matrix";
export { Matrix, inverse, solve };
export const dot = (a: number[], b: number[]) =>
  a.reduce((s, v, i) => s + v * b[i], 0);
export const clamp = (x: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, x));
export function eigen(a: Matrix) {
  const e = new EigenvalueDecomposition(a, { assumeSymmetric: true });
  const order = e.realEigenvalues
    .map((_, i) => i)
    .sort((i, j) => e.realEigenvalues[j] - e.realEigenvalues[i]);
  return {
    values: order.map((i) => e.realEigenvalues[i]),
    vectors: e.eigenvectorMatrix.subMatrixColumn(order),
  };
}

/** Accurate normal CDF using a convergent integral series; saturation only in <1e-16 tails. */
export function normalCDF(x: number): number {
  if (x <= -8.3) return 0;
  if (x >= 8.3) return 1;
  let sum = x,
    term = x;
  for (let i = 1; i < 200; i++) {
    term *= (x * x) / (2 * i + 1);
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * 1e-16) break;
  }
  return 0.5 + (sum * Math.exp((-x * x) / 2)) / Math.sqrt(2 * Math.PI);
}
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  let lo = -8.3,
    hi = 8.3;
  for (let i = 0; i < 55; i++) {
    const m = (lo + hi) / 2;
    if (normalCDF(m) < p) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

function gaussLegendre(n: number) {
  const x: number[] = [],
    w: number[] = [];
  for (let i = 0; i < n; i++) {
    let z = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5)),
      derivative = 0;
    for (let it = 0; it < 30; it++) {
      let p = 1,
        prev = 0;
      for (let j = 1; j <= n; j++) {
        const next = ((2 * j - 1) * z * p - (j - 1) * prev) / j;
        prev = p;
        p = next;
      }
      derivative = (n * (z * p - prev)) / (z * z - 1);
      const step = p / derivative;
      z -= step;
      if (Math.abs(step) < 1e-15) break;
    }
    x.push(z);
    w.push(2 / ((1 - z * z) * derivative * derivative));
  }
  return { x, w };
}
const quadrature = gaussLegendre(24);
/** A pair likelihood shares rho across every cell. Reuse the quadrature
 * geometry, margins and squared thresholds rather than repeating trigonometry. */
export function bivariateGrid(
  xs: number[],
  ys: number[],
  rho: number,
  px: number[],
  py: number[],
) {
  const end = Math.asin(rho),
    segments = Math.abs(rho) > 0.98 ? 8 : Math.abs(rho) > 0.9 ? 3 : 1;
  const nodes: { sin: number; denominator: number; weight: number }[] = [];
  for (let s = 0; s < segments; s++) {
    const half = end / (2 * segments),
      mid = ((s + 0.5) * end) / segments;
    for (let q = 0; q < quadrature.x.length; q++) {
      const angle = mid + half * quadrature.x[q],
        cos = Math.cos(angle);
      nodes.push({
        sin: Math.sin(angle),
        denominator: 1 / (2 * cos * cos),
        weight: (half * quadrature.w[q]) / (2 * Math.PI),
      });
    }
  }
  return xs.map((h, i) =>
    ys.map((k, j) => {
      if (h === -Infinity || k === -Infinity) return 0;
      if (h === Infinity) return py[j];
      if (k === Infinity) return px[i];
      const sumSquares = h * h + k * k,
        twiceProduct = 2 * h * k;
      let probability = px[i] * py[j];
      for (const node of nodes)
        probability +=
          node.weight *
          Math.exp(-(sumSquares - twiceProduct * node.sin) * node.denominator);
      return clamp(probability, 0, 1);
    }),
  );
}
/** Plackett's identity, rho=sin(theta). Integrates the bivariate normal density. */
export function bivariateCDF(h: number, k: number, rho: number): number {
  if (h === -Infinity || k === -Infinity) return 0;
  if (h === Infinity) return normalCDF(k);
  if (k === Infinity) return normalCDF(h);
  const end = Math.asin(rho),
    segments = Math.abs(rho) > 0.98 ? 8 : Math.abs(rho) > 0.9 ? 3 : 1;
  let integral = 0;
  for (let s = 0; s < segments; s++) {
    const half = end / (2 * segments),
      mid = ((s + 0.5) * end) / segments;
    for (let q = 0; q < quadrature.x.length; q++) {
      const angle = mid + half * quadrature.x[q],
        sin = Math.sin(angle),
        cos = Math.cos(angle);
      integral +=
        half *
        quadrature.w[q] *
        Math.exp(-(h * h + k * k - 2 * h * k * sin) / (2 * cos * cos));
    }
  }
  return clamp(normalCDF(h) * normalCDF(k) + integral / (2 * Math.PI), 0, 1);
}

/** Bounded Brent minimization. Default tolerance matches R optimize(). */
export function brent(
  f: (x: number) => number,
  lower: number,
  upper: number,
  tolerance = Math.pow(Number.EPSILON, 0.25),
) {
  const golden = (3 - Math.sqrt(5)) / 2;
  let a = lower,
    b = upper,
    x = a + golden * (b - a),
    w = x,
    v = x,
    fx = f(x),
    fw = fx,
    fv = fx,
    d = 0,
    e = 0;
  for (let iteration = 0; iteration < 200; iteration++) {
    const mid = (a + b) / 2,
      tol = Math.sqrt(Number.EPSILON) * Math.abs(x) + tolerance / 3;
    if (Math.abs(x - mid) <= 2 * tol - (b - a) / 2)
      return { x, value: fx, iterations: iteration };
    let p = 0,
      q = 0,
      r = 0;
    if (Math.abs(e) > tol) {
      r = (x - w) * (fx - fv);
      q = (x - v) * (fx - fw);
      p = (x - v) * q - (x - w) * r;
      q = 2 * (q - r);
      if (q > 0) p = -p;
      else q = -q;
      r = e;
      e = d;
      if (
        Math.abs(p) < Math.abs((q * r) / 2) &&
        p > q * (a - x) &&
        p < q * (b - x)
      ) {
        d = p / q;
        const u = x + d;
        if (u - a < 2 * tol || b - u < 2 * tol) d = x < mid ? tol : -tol;
      } else {
        e = x < mid ? b - x : a - x;
        d = golden * e;
      }
    } else {
      e = x < mid ? b - x : a - x;
      d = golden * e;
    }
    const u = x + (Math.abs(d) >= tol ? d : d > 0 ? tol : -tol),
      fu = f(u);
    if (fu <= fx) {
      if (u < x) b = x;
      else a = x;
      v = w;
      fv = fw;
      w = x;
      fw = fx;
      x = u;
      fx = fu;
    } else {
      if (u < x) a = u;
      else b = u;
      if (fu <= fw || w === x) {
        v = w;
        fv = fw;
        w = u;
        fw = fu;
      } else if (fu <= fv || v === x || v === w) {
        v = u;
        fv = fu;
      }
    }
  }
  throw new Error("Correlation likelihood did not converge.");
}
