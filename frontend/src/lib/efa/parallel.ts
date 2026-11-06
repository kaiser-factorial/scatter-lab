import { mulberry32 } from "../random";
import { Matrix, eigen } from "./math";
import { correlate } from "./correlation";
import { preparedCorrelation } from './correlation-method';
import { extractMinres, MINRES_METHOD } from "./extraction";
import {
  EfaError,
  EFA_ENGINE,
  type EfaPreparedData,
  type ParallelResult,
  type Progress,
} from "./types";

export function factorEigenvalues(r: number[][], progress?: Progress) {
  const one = extractMinres(r, 1, progress),
    reduced = new Matrix(r);
  one.loadings.forEach((row, i) => reduced.set(i, i, row[0] ** 2));
  return eigen(reduced).values;
}
export function permutedData(
  data: EfaPreparedData,
  seed: number,
): EfaPreparedData {
  const codes = data.codes.slice(),
    numeric = data.numeric?.slice(),
    random = mulberry32(seed),
    n = data.nRows;
  for (let j = 0; j < data.items.length; j++) {
    const indices: number[] = [];
    for (let i = 0; i < n; i++)
      if (data.observed[j * n + i]) indices.push(j * n + i);
    for (let i = indices.length - 1; i > 0; i--) {
      const k = Math.floor(random() * (i + 1)),
        a = indices[i],
        b = indices[k];
      [codes[a], codes[b]] = [codes[b], codes[a]];
      if (numeric) [numeric[a], numeric[b]] = [numeric[b], numeric[a]];
    }
  }
  return { ...data, codes, ...(numeric ? { numeric } : {}) };
}
export function parallelAnalysis(
  data: EfaPreparedData,
  seed: number,
  replicates = 100,
  progress?: Progress,
  minimumPairN = 0,
): ParallelResult {
  validateReplicates(replicates, seed);
  const observed = parallelObserved(data, minimumPairN, progress),
    nullEigenvalues: number[][] = [],
    failures: ParallelResult["failures"] = [];
  for (let i = 0; i < replicates; i++) {
    try {
      nullEigenvalues.push(parallelReplicate(data, seed + i));
    } catch (error) {
      failures.push({
        replicate: i,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    progress?.({
      stage: "Parallel analysis",
      completed: i + 1,
      total: replicates,
    });
  }
  return summarizeParallel(
    observed,
    nullEigenvalues,
    failures,
    seed,
    replicates,
    data.fingerprint,
    data.imputation?.method,
    preparedCorrelation(data),
  );
}
export function validateReplicates(replicates: number, seed?: number) {
  if (!Number.isInteger(replicates) || replicates < 1 || replicates > 1000)
    throw new EfaError(
      "replicates",
      "Use 1–1000 parallel-analysis permutations.",
    );
  if (
    seed !== undefined &&
    (!Number.isSafeInteger(seed) ||
      !Number.isSafeInteger(seed + (replicates - 1)))
  )
    throw new EfaError(
      "seed",
      "Choose an integer seed whose full sequence of permutation offsets stays within JavaScript's safe integer range.",
    );
}
export function parallelObserved(
  data: EfaPreparedData,
  minimumPairN = 0,
  progress?: Progress,
) {
  const correlation = correlate(data, progress);
  if (
    data.rows.length < minimumPairN ||
    correlation.pairs.some((pair) => pair.n < minimumPairN)
  )
    throw new EfaError(
      "privacy",
      "This simulation includes item pairs below the private aggregate floor.",
    );
  return factorEigenvalues(correlation.matrix, progress);
}
export function parallelReplicate(
  data: EfaPreparedData,
  seed: number,
  progress?: Progress,
) {
  return factorEigenvalues(
    correlate(permutedData(data, seed), progress).matrix,
    progress,
  );
}
export function summarizeParallel(
  observed: number[],
  nullEigenvalues: number[][],
  failures: ParallelResult["failures"],
  seed: number,
  replicates: number,
  inputSha256?: string,
  imputation?: "mean" | "median",
  correlation: 'pearson' | 'polychoric' = imputation ? 'pearson' : 'polychoric',
): ParallelResult {
  if (nullEigenvalues.length + failures.length !== replicates)
    throw new EfaError(
      "incomplete-simulation",
      "A simulation result must account for every requested replicate.",
    );
  const reference = observed.map((_, j) => {
    const sorted = nullEigenvalues.map((row) => row[j]).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const index = 0.95 * (sorted.length - 1),
      lo = Math.floor(index);
    return sorted[lo] + (sorted[Math.ceil(index)] - sorted[lo]) * (index - lo);
  });
  let suggestion = 0;
  while (
    suggestion < observed.length &&
    reference[suggestion] !== null &&
    observed[suggestion] > reference[suggestion]!
  )
    suggestion++;
  return {
    provenance: {
      inputSha256,
      engine: EFA_ENGINE,
      correlation: `${correlation === 'pearson' ? 'Pearson; numeric values' : 'Two-step pair-margin polychoric; maxcor=.9999'}${imputation ? `; column ${imputation} imputation on fitting rows` : ''}`,
      extraction: MINRES_METHOD,
      nullModel:
        "Within-item observed-response permutations with fixed missingness masks",
      communalityConvention:
        "One-factor MINRES squared loadings replace correlation diagonals for observed and null spectra",
      generator:
        "mulberry32; replicate seed = batch seed + zero-based replicate index",
      percentile: "95th percentile; linear interpolation (R type 7)",
    },
    seed,
    requested: replicates,
    completed: nullEigenvalues.length,
    percentile: 0.95,
    observed,
    nullEigenvalues,
    reference,
    failures,
    suggested: failures.length ? null : suggestion,
  };
}
