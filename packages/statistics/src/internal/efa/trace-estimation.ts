import { EfaError } from "./types";
import type { OrdinalTraceSource } from "./trace-kernel";

/** Fixed-budget trace probes. Settings are validated before a fit starts.
 * Probe streams are independent of batch width, so saved prefixes reproduce. */
export function rademacherProbes(rows: number, count: number, seed: number, offset = 0) {
  if (![rows, count].every(n => Number.isSafeInteger(n) && n > 0) || !Number.isSafeInteger(seed) || !Number.isSafeInteger(offset) || offset < 0)
    throw new EfaError("trace-probes", "Invalid trace probe dimensions or seed.");
  const probes = new Float64Array(rows * count);
  for (let col = 0; col < count; col++) {
    let state = (seed ^ Math.imul(offset + col + 1, 0x9e3779b1)) >>> 0;
    for (let row = 0; row < rows; row++) {
      state = (state + 0x6d2b79f5) | 0;
      let t = state; t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      probes[row * count + col] = ((t ^ t >>> 14) >>> 0) < 0x80000000 ? -1 : 1;
    }
  }
  return probes;
}

/** Small-case Float64 oracle. Applies H V without allocating H or full A.
 * The browser experiment uses a separately checked GPU implementation. */
export function applyTraceOperatorCpu(source: OrdinalTraceSource, probes: Float64Array, count: number) {
  const n = source.nRows, q = source.projection[0].length;
  if (!Number.isSafeInteger(count) || count < 1 || probes.length !== n * count || probes.some(v => !Number.isFinite(v)))
    throw new EfaError("trace-probes", "Invalid trace probe matrix.");
  const output = new Float64Array(probes.length), coefficients = new Float64Array(count), values = new Float64Array(n);
  const applyColumn = (sign: number) => {
    coefficients.fill(0);
    for (let row = 0; row < n; row++) {
      const value = values[row], at = row * count;
      for (let col = 0; col < count; col++) coefficients[col] += value * probes[at + col];
    }
    for (let row = 0; row < n; row++) {
      const value = sign * values[row], at = row * count;
      for (let col = 0; col < count; col++) output[at + col] += value * coefficients[col];
    }
  };
  for (let a = 0; a < source.pairs.length; a++) {
    const pair = source.pairs[a], x = pair.i * n, y = pair.j * n, weight = source.rootWeights[a];
    for (let row = 0; row < n; row++) values[row] = source.observed[x + row] && source.observed[y + row]
      ? pair.values[source.codes[x + row] * pair.columns + source.codes[y + row]] * weight : 0;
    applyColumn(1);
  }
  for (let a = 0; a < q; a++) {
    for (let row = 0; row < n; row++) values[row] = source.projection[row][a];
    applyColumn(-1);
  }
  return output;
}

export function probeSquaredNorms(products: Float64Array, count: number) {
  if (!Number.isSafeInteger(count) || count < 1 || products.length % count || !products.length || products.some(v => !Number.isFinite(v)))
    throw new EfaError("trace-probes", "Invalid trace operator output.");
  const sums = new Float64Array(count), corrections = new Float64Array(count);
  for (let i = 0; i < products.length; i++) {
    const col = i % count, term = products[i] * products[i] - corrections[col], next = sums[col] + term;
    corrections[col] = next - sums[col] - term; sums[col] = next;
  }
  if (sums.some(v => !Number.isFinite(v))) throw new EfaError("trace-probes", "Trace probe norm overflowed.");
  return Array.from(sums);
}

export function summarizeTraceProbes(values: number[]) {
  if (values.length < 2 || values.some(v => !Number.isFinite(v) || v < 0))
    throw new EfaError("trace-probes", "At least two finite nonnegative probe norms are required.");
  let mean = 0, m2 = 0;
  values.forEach((value, i) => { const delta = value - mean; mean += delta / (i + 1); m2 += delta * (value - mean); });
  const monteCarloSE = Math.sqrt(Math.max(0, m2) / (values.length - 1) / values.length);
  return { method: "fixed-budget Rademacher estimate of tr(H²)" as const, approximate: true as const,
    probes: values.length, traceSquared: mean, monteCarloSE,
    normalInterval95: [Math.max(0, mean - 1.96 * monteCarloSE), mean + 1.96 * monteCarloSE],
    uncertainty: "Normal approximation for a prespecified probe budget; not a rigorous bound or an adaptive stopping guarantee. Separate from floating-point error." };
}

export type TraceProbeSummary = ReturnType<typeof summarizeTraceProbes>;
export interface TraceEstimate extends TraceProbeSummary {
  version: "rademacher-h2/1";
  seed: number;
  requestedProbes: number;
}
export interface TraceEstimateTask {
  kind: "estimate";
  source: OrdinalTraceSource;
  probes: number;
  seed: number;
}
export type TraceEstimator = (task: TraceEstimateTask) => Promise<TraceEstimate>;
export function traceEstimate(values: number[], seed: number, requestedProbes: number): TraceEstimate {
  return { ...summarizeTraceProbes(values), version: "rademacher-h2/1", seed, requestedProbes };
}

export function isTraceEstimate(value: unknown): value is TraceEstimate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as TraceEstimate;
  const template = traceEstimate([1, 1], 0, 16);
  return Object.keys(v).every(key => Object.hasOwn(template, key)) && v.version === template.version && v.method === template.method && v.uncertainty === template.uncertainty && v.approximate === true &&
    Number.isSafeInteger(v.seed) && v.seed >= 0 && v.seed <= 0xffffffff &&
    Number.isSafeInteger(v.requestedProbes) && v.requestedProbes >= 16 && v.requestedProbes <= 4096 &&
    Number.isSafeInteger(v.probes) && v.probes >= 2 && v.probes <= v.requestedProbes &&
    Number.isFinite(v.traceSquared) && v.traceSquared >= 0 && Number.isFinite(v.monteCarloSE) && v.monteCarloSE >= 0 &&
    Array.isArray(v.normalInterval95) && v.normalInterval95.length === 2 &&
    v.normalInterval95.every(Number.isFinite) &&
    Math.abs(v.normalInterval95[0] - Math.max(0, v.traceSquared - 1.96 * v.monteCarloSE)) <= 1e-10 * Math.max(1, v.traceSquared) &&
    Math.abs(v.normalInterval95[1] - (v.traceSquared + 1.96 * v.monteCarloSE)) <= 1e-10 * Math.max(1, v.traceSquared);
}
