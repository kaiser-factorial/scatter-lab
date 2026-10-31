import { correlate } from "./correlation";
import { fitEfa } from "./fit";
import {
  imputeMice,
  type MiceOptions,
  type MiceTrace,
  type MiceDrawRequest,
} from "./mice";
import { alignReplica, type AlignedReplica } from "./stability";
import {
  EfaError,
  EFA_ENGINE,
  type EfaPreparedData,
  type EfaResult,
  type EfaSpec,
  type Progress,
} from "./types";

export interface ImputationFailure {
  imputation: number;
  stage: "imputation" | "fit";
  error: string;
  iteration?: number;
  item?: number;
}
export interface ImputationFit {
  imputation: number;
  /** Only originally missing cells, in missingPositions order. */ replacements: number[];
  result: EfaResult;
}
export interface ImputationChainResult {
  fit?: ImputationFit;
  failure?: ImputationFailure;
  trace: MiceTrace[];
}
export interface BetweenImputation {
  mean: number | null;
  sd: number | null;
  min: number | null;
  max: number | null;
}
export interface ImputationAnalysis {
  options: MiceOptions;
  requested: number;
  completed: number;
  fittingRows: number[];
  originalRowCount: number;
  /** Column-major positions in the saved fitting population, not source rows. */
  missingPositions: number[];
  fits: ImputationFit[];
  aligned: AlignedReplica[];
  failures: ImputationFailure[];
  trace: MiceTrace[];
  pattern: BetweenImputation[][];
  structure: BetweenImputation[][];
  phi: BetweenImputation[][];
  communalities: BetweenImputation[];
  uniquenesses: BetweenImputation[];
  provisional: boolean;
  provenance: {
    engine?: string;
    method: string;
    inputSha256?: string;
    alignment: string;
    uncertainty: string;
    execution?: {
      workers: number;
      estimatedWorkingSetBytesPerWorker: number;
      note: string;
    };
  };
}
/** Scheduling estimate, not a measured memory limit. Ordinal contrasts expand
 * predictor columns; augmentation and standardized designs are resident too. */
export function imputationWorkingSet(
  source: EfaPreparedData,
  options: MiceOptions,
): number {
  let maximum = 0;
  for (let target = 0; target < source.items.length; target++) {
    if (source.counts[target].reduce((a, b) => a + b, 0) === source.nRows)
      continue;
    const d = options.predictors[target].reduce(
        (sum, j) =>
          sum +
          (options.predictorEncoding === "rank"
            ? 1
            : source.items[j].categories.length - 1),
        0,
      ),
      k = source.items[target].categories.length;
    maximum = Math.max(maximum, 8 * d * (3 * source.nRows + 4 * d * k));
  }
  return (
    maximum +
    2 * (source.codes.byteLength + source.observed.byteLength) +
    128 * source.items.length ** 2
  );
}
/** One independent chain per worker keeps resident completed data bounded. */
export function fitImputationChain(
  source: EfaPreparedData,
  spec: EfaSpec,
  options: MiceOptions,
  imputation: number,
  progress?: Progress,
  savedDraws?: (request: MiceDrawRequest) => number[],
): ImputationChainResult {
  const imputed = imputeMice(source, options, progress, savedDraws, [
    imputation,
  ]);
  if (imputed.failures.length)
    return {
      trace: imputed.trace,
      failure: { ...imputed.failures[0], stage: "imputation" },
    };
  const complete = imputed.completed[0].data;
  try {
    const result = fitEfa(
      complete,
      correlate(complete, progress),
      spec,
      progress,
    );
    return {
      trace: imputed.trace,
      fit: {
        imputation,
        replacements: imputed.missingPositions.map((i) => complete.codes[i]),
        result,
      },
    };
  } catch (error) {
    return {
      trace: imputed.trace,
      failure: {
        imputation,
        stage: "fit",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
export function betweenImputation(values: number[]): BetweenImputation {
  if (!values.length) return { mean: null, sd: null, min: null, max: null };
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
    min: Math.min(...values),
    max: Math.max(...values),
  };
}
export function missingPositions(source: EfaPreparedData): number[] {
  const positions: number[] = [];
  for (let i = 0; i < source.observed.length; i++)
    if (!source.observed[i]) positions.push(i);
  return positions;
}
export function summarizeImputations(
  source: EfaPreparedData,
  options: MiceOptions,
  chains: ImputationChainResult[],
): ImputationAnalysis {
  const fits = chains
      .flatMap((c) => (c.fit ? [c.fit] : []))
      .sort((a, b) => a.imputation - b.imputation),
    failures = chains
      .flatMap((c) => (c.failure ? [c.failure] : []))
      .sort((a, b) => a.imputation - b.imputation);
  const ids = [
    ...fits.map((f) => f.imputation),
    ...failures.map((f) => f.imputation),
  ];
  if (
    ids.length !== options.imputations ||
    new Set(ids).size !== ids.length ||
    ids.some((i) => i < 0 || i >= options.imputations)
  )
    throw new EfaError(
      "incomplete-imputation",
      "Every requested imputation must have one fit or recorded failure.",
    );
  const reference = fits[0]?.result,
    aligned = fits.map((f) => alignReplica(reference!, f.result, f.imputation));
  const p = source.items.length,
    k = reference?.rotation.phi.length ?? 0;
  const matrix = (
    field: "pattern" | "structure" | "phi",
    rows: number,
    cols: number,
  ) =>
    Array.from({ length: rows }, (_, i) =>
      Array.from({ length: cols }, (_, j) =>
        betweenImputation(aligned.map((r) => r[field][i][j])),
      ),
    );
  return {
    options: structuredClone({
      ...options,
      predictorEncoding: options.predictorEncoding ?? "ordered-polynomial",
    }),
    requested: options.imputations,
    completed: fits.length,
    fittingRows: source.rows.slice(),
    originalRowCount: source.originalRowCount,
    missingPositions: missingPositions(source),
    fits,
    aligned,
    failures,
    trace: chains
      .flatMap((c) => c.trace)
      .sort(
        (a, b) =>
          a.imputation - b.imputation ||
          a.iteration - b.iteration ||
          a.item - b.item,
      ),
    pattern: matrix("pattern", p, k),
    structure: matrix("structure", p, k),
    phi: matrix("phi", k, k),
    communalities: Array.from({ length: p }, (_, i) =>
      betweenImputation(aligned.map((r) => r.communalities[i])),
    ),
    uniquenesses: Array.from({ length: p }, (_, i) =>
      betweenImputation(aligned.map((r) => r.uniquenesses[i])),
    ),
    provisional: failures.length > 0,
    provenance: {
      engine: EFA_ENGINE,
      method:
        "Separate ordinal polr / binary logreg conditional imputations; MINRES fitted independently to each completed dataset",
      inputSha256: source.fingerprint,
      alignment:
        "Signs and factor permutation only, anchored to first successful imputation",
      uncertainty:
        "Descriptive between-imputation dispersion only; no within-imputation variance or Rubin-pooled confidence intervals",
    },
  };
}
