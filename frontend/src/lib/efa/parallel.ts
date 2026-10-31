import { mulberry32 } from "../random";
import { Matrix, eigen } from "./math";
import { correlate } from "./correlation";
import { extractMinres } from "./extraction";
import {
  EfaError,
  type EfaPreparedData,
  type ParallelResult,
  type Progress,
} from "./types";

export function factorEigenvalues(r: number[][]) {
  const one = extractMinres(r, 1),
    reduced = new Matrix(r);
  one.loadings.forEach((row, i) => reduced.set(i, i, row[0] ** 2));
  return eigen(reduced).values;
}
export function permutedData(
  data: EfaPreparedData,
  seed: number,
): EfaPreparedData {
  const codes = data.codes.slice(),
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
    }
  }
  return { ...data, codes };
}
export function parallelAnalysis(
  data: EfaPreparedData,
  seed: number,
  replicates = 100,
  progress?: Progress,
  minimumPairN = 0,
): ParallelResult {
  if (!Number.isInteger(replicates) || replicates < 1 || replicates > 1000)
    throw new Error("Use 1–1000 parallel-analysis permutations.");
  const correlation = correlate(data);
  if (
    data.rows.length < minimumPairN ||
    correlation.pairs.some((pair) => pair.n < minimumPairN)
  )
    throw new EfaError(
      "privacy",
      "This simulation includes item pairs below the private aggregate floor.",
    );
  const observed = factorEigenvalues(correlation.matrix),
    nullEigenvalues: number[][] = [],
    failures: ParallelResult["failures"] = [];
  for (let i = 0; i < replicates; i++) {
    try {
      nullEigenvalues.push(
        factorEigenvalues(correlate(permutedData(data, seed + i)).matrix),
      );
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
