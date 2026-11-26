import { mulberry32 } from "../random";
import { Matrix, QrDecomposition } from "ml-matrix";
import {
  binaryConditionalDraw,
  drawOrdinal,
  fitOrdinal,
  ordinalProbabilities,
  MAX_CONDITIONAL_LEVELS,
} from "./ordinal-regression";
import { preparedSample } from "./prepared-sample";
import { EfaError, type EfaPreparedData, type Progress } from "./types";

export interface MiceOptions {
  imputations: number;
  iterations: number;
  seed: number;
  /** Explicit predictor indices for each target. No automatic predictor pruning. */
  predictors: number[][];
  predictorEncoding?: "ordered-polynomial" | "rank";
}
export interface MiceDrawRequest {
  imputation: number;
  iteration: number;
  item: number;
  kind: "initial" | "uniform" | "normal";
  count: number;
}
export interface MiceTrace {
  imputation: number;
  iteration: number;
  item: number;
  mean: number;
  sd: number;
  counts: number[];
  regressionIterations: number;
  gradient: number;
}
export interface MiceResult {
  options: MiceOptions;
  completed: { imputation: number; data: EfaPreparedData }[];
  failures: {
    imputation: number;
    iteration: number;
    item: number;
    error: string;
  }[];
  trace: MiceTrace[];
  missingPositions: number[];
  provenance: { method: string; generator: string; seed: number };
}
export function validateMiceOptions(options: MiceOptions, p: number) {
  if (
    !Number.isInteger(options.imputations) ||
    options.imputations < 2 ||
    options.imputations > 100 ||
    !Number.isInteger(options.iterations) ||
    options.iterations < 1 ||
    options.iterations > 100 ||
    !Number.isSafeInteger(options.seed) ||
    !Number.isSafeInteger(options.seed + (options.imputations - 1) * 104729)
  )
    throw new EfaError(
      "mice-settings",
      "Use 2–100 imputations, 1–100 iterations and an integer seed whose chain offsets stay within JavaScript's safe integer range.",
    );
  if (
    !Array.isArray(options.predictors) ||
    options.predictors.length !== p ||
    options.predictors.some(
      (row, j) =>
        !Array.isArray(row) ||
        new Set(row).size !== row.length ||
        row.some((i) => !Number.isInteger(i) || i < 0 || i >= p || i === j),
    )
  )
    throw new EfaError(
      "predictors",
      "Specify unique valid predictors for each item, excluding the target itself.",
    );
  if (
    !["ordered-polynomial", "rank"].includes(
      options.predictorEncoding ?? "ordered-polynomial",
    )
  )
    throw new EfaError(
      "predictor-encoding",
      "Choose ordered-polynomial contrasts or ordinal ranks explicitly.",
    );
}
/** R's ordered-factor contrast space, including its positive leading sign. */
export function ordinalContrasts(levels: number): number[][] {
  // Validate before the quadratic basis allocation, including when the item
  // is only a predictor and would never reach conditional-outcome validation.
  if (
    !Number.isInteger(levels) ||
    levels < 2 ||
    levels > MAX_CONDITIONAL_LEVELS
  )
    throw new EfaError(
      "mice-categories",
      `Ordered-polynomial MICE supports 2–${MAX_CONDITIONAL_LEVELS} declared categories per item. Review the category metadata or explicitly choose rank predictors.`,
    );
  if (levels === 2) return [[0], [1]];
  const grid = Array.from(
    { length: levels },
    (_, i) => (2 * i - levels + 1) / (levels - 1),
  );
  const q = new QrDecomposition(
    new Matrix(
      grid.map((x) =>
        Array.from({ length: levels }, (_, degree) => x ** degree),
      ),
    ),
  ).orthogonalMatrix;
  return grid.map((_, i) =>
    Array.from(
      { length: levels - 1 },
      (_, j) => q.get(i, j + 1) * (q.get(levels - 1, j + 1) < 0 ? -1 : 1),
    ),
  );
}
/** Fully conditional ordinal imputation. Observed outcomes are immutable;
 * every chain is kept separately. Fixed iteration count is not a convergence claim.
 */
export function imputeMice(
  source: EfaPreparedData,
  options: MiceOptions,
  progress?: Progress,
  savedDraws?: (request: MiceDrawRequest) => number[],
  chainIndices?: number[],
): MiceResult {
  const p = source.items.length,
    n = source.nRows;
  validateMiceOptions(options, p);
  const encoding = options.predictorEncoding ?? "ordered-polynomial";
  const contrasts = source.items.map((item) =>
    encoding === "rank"
      ? item.categories.map((_, i) => [i + 1])
      : ordinalContrasts(item.categories.length),
  );
  const chains =
    chainIndices ?? Array.from({ length: options.imputations }, (_, i) => i);
  if (
    !chains.length ||
    new Set(chains).size !== chains.length ||
    chains.some(
      (i) => !Number.isInteger(i) || i < 0 || i >= options.imputations,
    )
  )
    throw new EfaError("mice-chains", "Invalid imputation chain selection.");
  const missing = source.items.map((_, j) =>
      Array.from({ length: n }, (_, i) => i).filter(
        (i) => !source.observed[j * n + i],
      ),
    ),
    targets = missing.flatMap((rows, j) => (rows.length ? [j] : []));
  if (!targets.length)
    throw new EfaError(
      "no-missing",
      "These selected items have no missing responses. Fit the observed data directly.",
    );
  const result: MiceResult = {
    options: structuredClone({ ...options, predictorEncoding: encoding }),
    completed: [],
    failures: [],
    trace: [],
    missingPositions: targets.flatMap((j) => missing[j].map((i) => j * n + i)),
    provenance: {
      method: `mice 3.18 ordinal polr and binary logreg conditional conventions; ${encoding} predictors; no multinomial fallback`,
      generator:
        "mulberry32; independent chain seeds; saved draws supported for R qualification",
      seed: options.seed,
    },
  };
  for (const m of chains) {
    const random = mulberry32(options.seed + m * 104729),
      codes = source.codes.slice();
    let iteration = 0,
      item = -1;
    const draws = (kind: MiceDrawRequest["kind"], count: number) => {
      const request = { imputation: m, iteration, item, kind, count };
      const values = savedDraws
        ? savedDraws(request)
        : Array.from({ length: count }, () =>
            kind === "normal"
              ? Math.sqrt(-2 * Math.log(Math.max(Number.MIN_VALUE, random()))) *
                Math.cos(2 * Math.PI * random())
              : random(),
          );
      if (
        values.length !== count ||
        values.some(
          (v) =>
            !Number.isFinite(v) || (kind !== "normal" && (v < 0 || v >= 1)),
        )
      )
        throw new EfaError("mice-draws", "Invalid imputation random draws.");
      return values;
    };
    try {
      for (item of targets) {
        const donors = Array.from({ length: n }, (_, i) => i).filter(
            (i) => source.observed[item * n + i],
          ),
          u = draws("initial", missing[item].length);
        if (!donors.length)
          throw new EfaError(
            "unobserved-item",
            "An all-missing item cannot be imputed from this fitting sample.",
          );
        missing[item].forEach(
          (row, i) =>
            (codes[item * n + row] =
              source.codes[
                item * n + donors[Math.floor(u[i] * donors.length)]
              ]),
        );
      }
      for (iteration = 1; iteration <= options.iterations; iteration++)
        for (let visit = 0; visit < targets.length; visit++) {
          item = targets[visit];
          const predictors = options.predictors[item],
            x = Array.from({ length: n }, (_, i) =>
              predictors.flatMap((j) => contrasts[j][codes[j * n + i]]),
            ),
            y = Array.from({ length: n }, (_, i) =>
              source.observed[item * n + i] ? source.codes[item * n + i] : null,
            ),
            levels = source.items[item].categories.length;
          let values: number[], iterations: number, gradient: number;
          if (levels === 2) {
            const normal = draws("normal", x[0].length + 1),
              uniform = draws("uniform", missing[item].length),
              fit = binaryConditionalDraw(x, y, normal, uniform);
            values = fit.draws;
            iterations = fit.fit.iterations;
            gradient = fit.fit.gradient;
          } else {
            const fit = fitOrdinal(x, y, levels),
              probabilities = ordinalProbabilities(
                fit,
                missing[item].map((i) => x[i]),
              );
            values = drawOrdinal(
              probabilities,
              draws("uniform", missing[item].length),
            );
            iterations = fit.iterations;
            gradient = fit.gradient;
          }
          missing[item].forEach(
            (row, i) => (codes[item * n + row] = values[i]),
          );
          const mean =
              values.reduce((sum, c) => sum + c + 1, 0) / values.length,
            sd =
              values.length > 1
                ? Math.sqrt(
                    values.reduce((sum, c) => sum + (c + 1 - mean) ** 2, 0) /
                      (values.length - 1),
                  )
                : 0,
            counts = Array(levels).fill(0);
          values.forEach((c) => counts[c]++);
          result.trace.push({
            imputation: m,
            iteration,
            item,
            mean,
            sd,
            counts,
            regressionIterations: iterations,
            gradient,
          });
          progress?.({
            stage: `MICE · imputation ${m + 1}, iteration ${iteration}, item ${item + 1}`,
            completed:
              (m * options.iterations + iteration - 1) * targets.length +
              visit +
              1,
            total: options.imputations * options.iterations * targets.length,
          });
        }
      result.completed.push({
        imputation: m,
        data: preparedSample(
          source,
          codes,
          new Uint8Array(codes.length).fill(1),
        ),
      });
    } catch (error) {
      result.failures.push({
        imputation: m,
        iteration,
        item,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
