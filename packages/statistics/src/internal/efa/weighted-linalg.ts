import type { EfaPreparedData, Progress } from "./types";
import { EfaError } from "./types";
import type { WeightedMoments } from "./weighted-moments";
import type { IdentifiedLoadings } from "./weighted-inference";
import type { Matrix } from "./math";
import { WrapperMatrix2D } from "ml-matrix";

/** S W J in bounded respondent tiles. Each respondent retains the original
 * ascending pair/parameter accumulation order. The compact sparse Jacobian
 * trades O(p²k) bounded storage for avoiding repeated tuple allocation and
 * writes scattered throughout the full N-by-q projection matrix. */
export function projectCases(
  data: EfaPreparedData,
  moments: WeightedMoments,
  identified: IdentifiedLoadings,
  progress?: Progress,
  tileRows = 32,
): Float64Array[] {
  if (!Number.isSafeInteger(tileRows) || tileRows < 1 || tileRows > 256)
    throw new EfaError("weighted-budget", "Invalid case projection tile size.");
  const n = data.nRows, q = identified.free.length,
    k = identified.loadings[0].length, pairs = moments.pairs,
    starts = new Uint32Array(pairs.length + 1);
  let count = 0;
  for (let a = 0; a < pairs.length; a++) {
    starts[a] = count;
    const { i, j } = pairs[a];
    for (let f = 0; f < k; f++) {
      if (identified.index[i][f] >= 0) count++;
      if (identified.index[j][f] >= 0) count++;
    }
  }
  starts[pairs.length] = count;
  const indices = new Uint32Array(count), values = new Float64Array(count);
  let at = 0;
  for (const { i, j } of pairs) {
    for (let f = 0; f < k; f++) {
      if (identified.index[i][f] >= 0) {
        indices[at] = identified.index[i][f]; values[at++] = identified.loadings[j][f];
      }
      if (identified.index[j][f] >= 0) {
        indices[at] = identified.index[j][f]; values[at++] = identified.loadings[i][f];
      }
    }
  }
  const z = Array.from({ length: n }, () => new Float64Array(q));
  const { codes, observed } = data;
  progress?.({ stage: "Robust case projections", completed: 0, total: n });
  for (let start = 0; start < n; start += tileRows) {
    const end = Math.min(n, start + tileRows);
    for (let a = 0; a < pairs.length; a++) {
      const pair = pairs[a], xOffset = pair.i * n, yOffset = pair.j * n,
        columns = pair.columns, lookup = pair.values, w = moments.weights[a],
        first = starts[a], last = starts[a + 1];
      for (let row = start; row < end; row++) {
        if (!observed[xOffset + row] || !observed[yOffset + row]) continue;
        const s = lookup[codes[xOffset + row] * columns + codes[yOffset + row]] * w;
        if (s) {
          const target = z[row];
          for (let entry = first; entry < last; entry++) target[indices[entry]] += s * values[entry];
        }
      }
    }
    progress?.({ stage: "Robust case projections", completed: end, total: n });
  }
  return z;
}

/** Original ascending arithmetic with contiguous typed rows. The inverse
 * exploits the lower-triangular zeros; each remaining entry still subtracts
 * terms in the same ascending order. Wrappers share storage through the
 * public ml-matrix API instead of copying q-by-q arrays. */
export function normalizeCaseProjections(z: Float64Array[], lower: Matrix, progress?: Progress) {
  const q = lower.rows, n = z.length, rootN = Math.sqrt(n),
    rows = Array.from({ length: q }, (_, a) => Float64Array.from(lower.getRow(a))),
    meat = Array.from({ length: q }, () => new Float64Array(q));
  progress?.({ stage: "Robust parameter covariance", completed: 0, total: n });
  for (let row = 0; row < n; row++) {
    const v = z[row];
    for (let a = 0; a < q; a++) {
      const coefficients = rows[a];
      let x = v[a];
      for (let b = 0; b < a; b++) x -= coefficients[b] * v[b];
      v[a] = x / coefficients[a];
    }
    for (let a = 0; a < q; a++) v[a] /= rootN;
    for (let a = 0; a < q; a++) {
      const target = meat[a], va = v[a];
      for (let b = 0; b <= a; b++) target[b] += va * v[b];
    }
    if ((row + 1) % 32 === 0 || row + 1 === n)
      progress?.({ stage: "Robust parameter covariance", completed: row + 1, total: n });
  }
  for (let a = 0; a < q; a++)
    for (let b = 0; b < a; b++) meat[b][a] = meat[a][b];
  const inverse = Array.from({ length: q }, () => new Float64Array(q));
  progress?.({ stage: "Covariance inverse transform", completed: 0, total: q });
  for (let a = 0; a < q; a++) {
    const target = inverse[a], coefficients = rows[a];
    target[a] = 1;
    for (let b = 0; b < a; b++) {
      const coefficient = coefficients[b], previous = inverse[b];
      for (let c = 0; c <= b; c++) target[c] -= coefficient * previous[c];
    }
    for (let c = 0; c <= a; c++) target[c] /= coefficients[a];
    if ((a + 1) % 16 === 0 || a + 1 === q)
      progress?.({ stage: "Covariance inverse transform", completed: a + 1, total: q });
  }
  return { meat: new WrapperMatrix2D(meat), inverseLower: new WrapperMatrix2D(inverse) };
}

/** Evaluate d' C d using the exact symmetric part (Cij + Cji), so covariance
 * roundoff asymmetry is retained rather than discarded. Four output vectors
 * share each packed covariance traversal. Sparse derivatives use their actual
 * nonzero indices, including identically zero orthogonal factor correlations.
 * Arithmetic order changes, so independent-reference parity is required. */
export function covarianceQuadraticForms(covariance: Matrix, derivatives: Float64Array[], progress?: Progress): Float64Array {
  const q = covariance.rows;
  if (covariance.columns !== q || derivatives.some(row => row.length !== q))
    throw new EfaError("weighted-covariance", "Covariance propagation dimensions differ.");
  const packed = new Float64Array(q * (q + 1) / 2), offsets = new Uint32Array(q);
  let at = 0;
  for (let a = 0; a < q; a++) {
    offsets[a] = at;
    for (let b = 0; b <= a; b++) {
      const value = a === b ? covariance.get(a, a) : covariance.get(a, b) + covariance.get(b, a);
      if (!Number.isFinite(value)) throw new EfaError("weighted-covariance", "Non-finite covariance propagation input.");
      packed[at++] = value;
    }
  }
  const results = new Float64Array(derivatives.length), dense: number[] = [];
  let completed = 0;
  const report = () => progress?.({ stage: "Rotated covariance propagation", completed, total: derivatives.length });
  report();
  derivatives.forEach((row, output) => {
    const nonzero: number[] = [];
    for (let i = 0; i < q; i++) {
      if (!Number.isFinite(row[i])) throw new EfaError("weighted-covariance", "Non-finite covariance derivative.");
      if (row[i] !== 0) nonzero.push(i);
    }
    if (nonzero.length > q / 4) { dense.push(output); return; }
    let variance = 0;
    for (let a = 0; a < nonzero.length; a++) {
      const i = nonzero[a], offset = offsets[i];
      let v = packed[offset + i] * row[i];
      for (let b = 0; b < a; b++) { const j = nonzero[b]; v += packed[offset + j] * row[j]; }
      variance += row[i] * v;
    }
    results[output] = variance;
    completed++;
  });
  report();
  const zero = new Float64Array(q);
  for (let output = 0; output < dense.length; output += 4) {
    const d0 = derivatives[dense[output]], d1 = derivatives[dense[output + 1]] ?? zero,
      d2 = derivatives[dense[output + 2]] ?? zero, d3 = derivatives[dense[output + 3]] ?? zero;
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
    for (let a = 0; a < q; a++) {
      const offset = offsets[a], diagonal = packed[offset + a];
      let v0 = diagonal * d0[a], v1 = diagonal * d1[a], v2 = diagonal * d2[a], v3 = diagonal * d3[a];
      for (let b = 0; b < a; b++) {
        const value = packed[offset + b];
        v0 += value * d0[b]; v1 += value * d1[b]; v2 += value * d2[b]; v3 += value * d3[b];
      }
      s0 += d0[a] * v0; s1 += d1[a] * v1; s2 += d2[a] * v2; s3 += d3[a] * v3;
    }
    results[dense[output]] = s0;
    if (output + 1 < dense.length) results[dense[output + 1]] = s1;
    if (output + 2 < dense.length) results[dense[output + 2]] = s2;
    if (output + 3 < dense.length) results[dense[output + 3]] = s3;
    completed += Math.min(4, dense.length - output);
    if (completed % 32 < 4 || completed === derivatives.length) report();
  }
  return results;
}
