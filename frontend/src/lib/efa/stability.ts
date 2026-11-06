import { mulberry32 } from "../random";
import { matchFactors } from "./compare";
import { correlate } from "./correlation";
import { fitEfa } from "./fit";
import { preparedSample } from "./prepared-sample";
import { completeNumericSample } from "./numeric-imputation";
import { completeOrdinalSample } from './ordinal-imputation';
import { MINRES_METHOD } from "./extraction";
import { DWLS_METHOD } from "./dwls";
import {
  EfaError,
  EFA_ENGINE,
  type EfaPreparedData,
  type EfaResult,
  type EfaSpec,
  type Progress,
  type EfaEstimator,
} from "./types";

export interface AlignedReplica {
  replicate: number;
  pattern: number[][];
  structure: number[][];
  phi: number[][];
  communalities: number[];
  uniquenesses: number[];
  congruence: (number | null)[];
  rmsr: number;
  diagnostics?: {
    boundaryItems: number[];
    improper: boolean;
    conditionNumber: number;
  };
}
export type FactorReference = Pick<EfaResult, "rotation">;
export interface StabilityOptions {
  replicates: number;
  seed: number;
  confidence: number;
  crossLoadingThreshold: number;
  groups?: string[];
}
export interface Interval {
  mean: number | null;
  sd: number | null;
  lower: number | null;
  upper: number | null;
}
export interface StabilityResult {
  provenance?: {
    inputSha256?: string;
    engine: string;
    extraction: string;
    alignment: string;
    generator: string;
  };
  options: StabilityOptions;
  requested: number;
  completed: number;
  replicas: AlignedReplica[];
  failures: { replicate: number; error: string }[];
  samples: number[][];
  pattern: Interval[][];
  structure: Interval[][];
  phi: Interval[][];
  communalities: Interval[];
  uniquenesses: Interval[];
  primaryAgreement: (number | null)[];
  crossLoadingFrequency: (number | null)[];
  provisional: boolean;
}
export function alignReplica(
  reference: FactorReference,
  result: EfaResult,
  replicate: number,
): AlignedReplica {
  const { mapping, signs, congruence } = matchFactors(
    reference.rotation.pattern,
    result.rotation.pattern,
  );
  if (mapping.some((i) => i === null))
    throw new EfaError(
      "factor-matching",
      "A resampled fit has unmatched factors.",
    );
  const aligned = (matrix: number[][]) =>
    matrix.map((row) => mapping.map((j, k) => row[j!] * signs[k]));
  return {
    replicate,
    pattern: aligned(result.rotation.pattern),
    structure: aligned(result.structure),
    phi: mapping.map((i, a) =>
      mapping.map((j, b) => result.rotation.phi[i!][j!] * signs[a] * signs[b]),
    ),
    communalities: result.communalities,
    uniquenesses: result.uniquenesses,
    congruence,
    rmsr: result.rmsr,
    diagnostics: {
      boundaryItems: result.extraction.boundaryItems.slice(),
      improper: result.uniquenesses.some((v) => v < 0),
      conditionNumber: result.conditionNumber,
    },
  };
}
export function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b),
    q = p * (sorted.length - 1),
    lo = Math.floor(q);
  return sorted[lo] + (sorted[Math.ceil(q)] - sorted[lo]) * (q - lo);
}
export function distribution(values: number[], confidence = 0.95): Interval {
  if (!values.length) return { mean: null, sd: null, lower: null, upper: null };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    mean,
    sd:
      values.length > 1
        ? Math.sqrt(
            values.reduce((s, v) => s + (v - mean) ** 2, 0) /
              (values.length - 1),
          )
        : null,
    lower: percentile(values, (1 - confidence) / 2),
    upper: percentile(values, (1 + confidence) / 2),
  };
}
const primary = (row: number[]) =>
  row.reduce((best, v, i) => (Math.abs(v) > Math.abs(row[best]) ? i : best), 0);
export function summarizeStability(
  reference: FactorReference,
  replicas: AlignedReplica[],
  failures: StabilityResult["failures"],
  samples: number[][],
  options: StabilityOptions,
  inputSha256?: string,
  estimator: EfaEstimator = "minres",
): StabilityResult {
  const p = reference.rotation.pattern.length,
    k = reference.rotation.phi.length;
  const matrix = (
    field: "pattern" | "structure" | "phi",
    rows: number,
    cols: number,
  ) =>
    Array.from({ length: rows }, (_, i) =>
      Array.from({ length: cols }, (_, j) =>
        distribution(
          replicas.map((r) => r[field][i][j]),
          options.confidence,
        ),
      ),
    );
  return {
    provenance: {
      inputSha256,
      engine: EFA_ENGINE,
      extraction:
        estimator === "minres"
          ? MINRES_METHOD
          : `${DWLS_METHOD}${estimator === "wlsmv" ? "; DWLS point refits of a WLSMV baseline; no per-replicate robust tests or delta standard errors" : ""}`,
      alignment: "Signs and permutation only, relative to the saved baseline",
      generator:
        "mulberry32; sample seed = batch seed + zero-based replicate index",
    },
    options: structuredClone(options),
    requested: options.replicates,
    completed: replicas.length,
    replicas,
    failures,
    samples,
    pattern: matrix("pattern", p, k),
    structure: matrix("structure", p, k),
    phi: matrix("phi", k, k),
    communalities: Array.from({ length: p }, (_, i) =>
      distribution(
        replicas.map((r) => r.communalities[i]),
        options.confidence,
      ),
    ),
    uniquenesses: Array.from({ length: p }, (_, i) =>
      distribution(
        replicas.map((r) => r.uniquenesses[i]),
        options.confidence,
      ),
    ),
    primaryAgreement: Array.from({ length: p }, (_, i) =>
      replicas.length
        ? replicas.filter(
            (r) =>
              primary(r.pattern[i]) === primary(reference.rotation.pattern[i]),
          ).length / replicas.length
        : null,
    ),
    crossLoadingFrequency: Array.from({ length: p }, (_, i) =>
      replicas.length
        ? replicas.filter(
            (r) =>
              r.pattern[i].filter(
                (v) => Math.abs(v) >= options.crossLoadingThreshold,
              ).length > 1,
          ).length / replicas.length
        : null,
    ),
    provisional: failures.length > 0 || replicas.length !== options.replicates,
  };
}
export function bootstrapIndices(n: number, seed: number, groups?: string[]) {
  const random = mulberry32(seed);
  if (!groups) return Array.from({ length: n }, () => Math.floor(random() * n));
  if (groups.length !== n || groups.some((g) => typeof g !== "string" || !g))
    throw new EfaError(
      "resampling-groups",
      "Every fitting respondent needs a group identifier.",
    );
  const units = new Map<string, number[]>();
  groups.forEach((g, i) => {
    const rows = units.get(g) ?? [];
    rows.push(i);
    units.set(g, rows);
  });
  if (units.size < 2)
    throw new EfaError(
      "resampling-groups",
      "Group resampling requires at least two groups.",
    );
  const entries = [...units.values()];
  return Array.from(
    { length: entries.length },
    () => entries[Math.floor(random() * entries.length)],
  ).flat();
}
export function resampleData(source: EfaPreparedData, indices: number[]) {
  const n = indices.length,
    p = source.items.length;
  if (
    n < 3 ||
    indices.some((i) => !Number.isInteger(i) || i < 0 || i >= source.nRows)
  )
    throw new EfaError("resample", "Invalid respondent resample.");
  const codes = new Uint16Array(n * p),
    observed = new Uint8Array(n * p),
    numeric = source.numeric ? new Float64Array(n * p) : undefined;
  for (let j = 0; j < p; j++)
    for (let i = 0; i < n; i++) {
      codes[j * n + i] = source.codes[j * source.nRows + indices[i]];
      observed[j * n + i] = source.observed[j * source.nRows + indices[i]];
      if (numeric) numeric[j * n + i] = source.numeric![j * source.nRows + indices[i]];
    }
  if (numeric) return completeNumericSample({ ...source, codes, observed, nRows: n,
    rows: indices.map((_, i) => i), originalRowCount: n }, numeric);
  const sample = preparedSample(
    { ...source, fittingObserved: undefined },
    codes,
    observed,
    indices.map((_, i) => i),
    n,
  );
  return source.imputation?.kind === 'ordinal' ? completeOrdinalSample(sample) : sample;
}
export function bootstrapStability(
  source: EfaPreparedData,
  spec: EfaSpec,
  reference: FactorReference,
  options: StabilityOptions,
  progress?: Progress,
  savedSamples?: number[][],
): StabilityResult {
  validateStability(options);
  if (savedSamples && savedSamples.length !== options.replicates)
    throw new EfaError(
      "resamples",
      "Saved resamples must match the requested replicate count.",
    );
  const replicas: AlignedReplica[] = [],
    failures: StabilityResult["failures"] = [],
    samples: number[][] = [];
  for (let i = 0; i < options.replicates; i++) {
    const result = stabilityReplicate(
      source,
      spec,
      reference,
      options,
      i,
      savedSamples?.[i],
    );
    samples.push(result.indices);
    if (result.replica) replicas.push(result.replica);
    if (result.failure) failures.push(result.failure);
    progress?.({
      stage: `Resampling stability · ${failures.length} failed`,
      completed: i + 1,
      total: options.replicates,
    });
  }
  return summarizeStability(
    reference,
    replicas,
    failures,
    samples,
    options,
    source.fingerprint,
    spec.extraction,
  );
}
export function validateStability(options: StabilityOptions) {
  if (
    !Number.isInteger(options.replicates) ||
    options.replicates < 2 ||
    options.replicates > 1000 ||
    !Number.isSafeInteger(options.seed) ||
    !Number.isSafeInteger(options.seed + (options.replicates - 1)) ||
    !(options.confidence > 0 && options.confidence < 1) ||
    !(options.crossLoadingThreshold >= 0)
  )
    throw new EfaError(
      "stability-settings",
      "Use 2–1000 replicates, an integer seed whose replicate offsets stay within JavaScript's safe integer range, a confidence level between 0 and 1, and a nonnegative loading threshold.",
    );
}
export interface StabilityReplicate {
  indices: number[];
  replica?: AlignedReplica;
  failure?: StabilityResult["failures"][number];
}
export function stabilityReplicate(
  source: EfaPreparedData,
  spec: EfaSpec,
  reference: FactorReference,
  options: StabilityOptions,
  index: number,
  savedSample?: number[],
  progress?: Progress,
): StabilityReplicate {
  const indices =
    savedSample?.slice() ??
    bootstrapIndices(source.nRows, options.seed + index, options.groups);
  try {
    const sample = resampleData(source, indices),
      fit = fitEfa(
        sample,
        correlate(sample, progress),
        spec.extraction === "wlsmv" ? { ...spec, extraction: "dwls" } : spec,
        progress,
      );
    return { indices, replica: alignReplica(reference, fit, index) };
  } catch (error) {
    return {
      indices,
      failure: {
        replicate: index,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
