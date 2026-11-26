import type { FitInvariant } from "./fit-cache";
import { computeSettings } from "./backends/types";
import { Matrix, solve } from "./math";
import { checkCorrelation, extractMinres } from "./extraction";
import { rotate } from "./rotation";
import { EFA_ENGINE, EfaError } from "./types";
import { correlationDescription, preparedCorrelation } from './correlation-method';
import { fitMaximumLikelihood, createConditionalProjector } from './maximum-likelihood';
import { extractDwls } from "./dwls";
import { weightedMoments } from "./weighted-moments";
import { planWeightedInference, weightedInference } from "./weighted-inference";
import { rotatedUncertainty, type RotatedUncertainty, type RotationDerivativeContext, rotationDerivativeContext } from "./weighted-rotation";
import type {
  EfaPreparedData,
  EfaCorrelations,
  EfaResult,
  EfaSpec,
  Progress,
  EfaExtraction,
} from "./types";

export interface FitRotationTask {
  kind: "rotation";
  context: RotationDerivativeContext;
  covariance: Matrix;
}

export interface FitInferenceTask {
  kind: "inference";
  args: Parameters<typeof weightedInference>;
}
export type FitTask = FitRotationTask | FitInferenceTask;
export type FitContinuation = RotatedUncertainty | ReturnType<typeof weightedInference>;

/** Pause at the asynchronous trace stage, then at parallel rotation derivatives.
 * The owning worker retains the fit and covariance across both boundaries. */
export function* fitEfaSteps(
  data: EfaPreparedData,
  correlation: EfaCorrelations,
  spec: EfaSpec,
  progress?: Progress,
  extraction?: EfaExtraction,
  invariant?: FitInvariant,
  capture?: (base: FitInvariant) => void,
): Generator<FitTask, EfaResult, FitContinuation> {
  const settings = computeSettings(spec);
  const estimator = spec.extraction ?? "minres",
    pointEstimator = estimator === "minres" || estimator === "ml" ? estimator : "dwls";
  let conditionNumber = estimator === 'ml' ? 0 : checkCorrelation(correlation.matrix).conditionNumber;
  if (!["minres", "dwls", "wlsmv", "ml"].includes(estimator))
    throw new EfaError("method", "Unsupported EFA extractor.");
  if (data.numeric && estimator !== "minres" && estimator !== "ml")
    throw new EfaError("imputation-method", "Pearson correlations use MINRES or Maximum Likelihood. Select polychoric correlations to use an ordinal weighted estimator.");
  if (extraction && (extraction.estimator ?? "minres") !== pointEstimator)
    throw new EfaError(
      "extraction-reuse",
      "A saved extraction can only be reused with its original point estimator.",
    );
  if (estimator === "wlsmv")
    planWeightedInference(
      data.items.length,
      spec.nFactors,
      data.nRows,
      correlation.pairs.reduce(
        (sum, pair) =>
          sum +
          data.items[pair.i].categories.length *
            data.items[pair.j].categories.length,
        0,
      ),
      settings,
    );
  const moments =
    estimator === "minres" || estimator === "ml" || invariant
      ? undefined
      : weightedMoments(data, correlation, progress);
  const unrotated =
    invariant?.extraction ?? extraction ??
    (estimator === 'ml' ? fitMaximumLikelihood(data, spec, correlation, progress) : moments
      ? extractDwls(correlation.matrix, moments, spec.nFactors, progress)
      : extractMinres(correlation.matrix, spec.nFactors, progress));
  progress?.({ stage: "Rotation", completed: 0, total: 1 });
  const rotation = rotate(
      unrotated.loadings,
      spec.rotation,
      spec.seed,
      4,
      estimator !== "minres",
    ),
    l = new Matrix(rotation.pattern),
    phi = new Matrix(rotation.phi),
    s = l.mmul(phi),
    model = s.mmul(l.transpose());
  const reproduced = model.to2DArray(),
    communalities = model.diag(),
    uniquenesses = communalities.map((v) => 1 - v),
    residuals = correlation.matrix.map((row, i) =>
      row.map((v, j) => (i === j ? 0 : v - reproduced[i][j])),
    );
  const p = l.rows,
    rmsr = Math.sqrt(
      residuals.reduce(
        (sum, row) => sum + row.reduce((s, v) => s + v * v, 0),
        0,
      ) /
        (p * (p - 1)),
    );
  const likelihood = unrotated.likelihood;
  const modelSds = likelihood?.covariance.map((row, j) => Math.sqrt(row[j]));
  const scoringMatrix = likelihood ? likelihood.covariance.map((row, i) => row.map((value, j) => value / modelSds![i] / modelSds![j])) : correlation.matrix;
  if (likelihood) conditionNumber = checkCorrelation(scoringMatrix).conditionNumber;
  const weights = solve(new Matrix(scoringMatrix), s).to2DArray();
  let weighted: EfaResult["weighted"];
  if (moments || invariant) {
    weighted = invariant ? { ...invariant.weighted } : {
      estimator: estimator as "dwls" | "wlsmv",
      samplingVariances: moments!.pairs.map((pair) => pair.variance),
      fittingWeights: Array.from(moments!.weights),
      uncertaintyMethod: moments!.method,
      rawStatistic: (data.nRows - 1) * unrotated.convergence.objective,
      df:
        (p * (p - 1)) / 2 -
        (p * spec.nFactors - (spec.nFactors * (spec.nFactors - 1)) / 2),
    };
    capture?.({ extraction: unrotated, weighted: { ...weighted } });
    if (estimator === "wlsmv") {
      const saved = invariant?.inference;
      const inference = saved ? { ...saved, covariance: Matrix.from1DArray(saved.identified.free.length, saved.identified.free.length, saved.covariance) } : (yield {
        kind: "inference",
        args: [data, moments!, unrotated.loadings, unrotated.convergence.objective, progress, settings],
      }) as ReturnType<typeof weightedInference>;
      weighted.robust = {
        test: inference.test,
        plan: inference.plan,
        standardErrors: (yield {
          kind: "rotation",
          context: rotationDerivativeContext(inference.identified, rotation, spec.rotation, spec.seed),
          covariance: inference.covariance,
        }) as RotatedUncertainty,
      };
    }
  }
  return {
    correlationMethod: preparedCorrelation(data),
    ...(likelihood ? { likelihood: structuredClone(likelihood) } : {}),
    ...(data.numericReverseOffsets ? { numericReverseOffsets: data.numericReverseOffsets.slice() } : {}),
    ...(data.imputation ? { imputation: structuredClone(data.imputation) } : {}),
    ...(weighted ? { weighted } : {}),
    correlation,
    extraction: unrotated,
    rotation,
    structure: s.to2DArray(),
    communalities,
    uniquenesses,
    reproduced,
    residuals,
    rmsr,
    means: likelihood?.means ?? data.means,
    sds: modelSds ?? data.sds,
    weights,
    categoryCounts: data.counts,
    fittingRows: data.rows,
    originalRowCount: data.originalRowCount,
    conditionNumber,
    diagnostics: [
      ...data.diagnostics,
      ...correlation.diagnostics,
      ...(likelihood ? [{ code: 'gaussian-likelihood', message: `${likelihood.kind === 'fiml' ? 'FIML integrates missing items out of each observed-response likelihood; it does not fill cells.' : 'ML fits the selected complete or explicitly completed numeric responses.'} Model loadings use model-implied standard deviations. RMSR describes pairwise correlation residuals; the likelihood objective is reported separately.` }] : []),
      ...(likelihood?.allMissingRows ? [{ code: 'uninformative-rows', count: likelihood.allMissingRows, message: `${likelihood.allMissingRows} wholly missing rows contribute no likelihood and receive no conditional score or completion.` }] : []),
      ...(weighted && data.imputation ? [{ code: 'conditional-imputation-uncertainty', message: 'Weighted fit statistics and standard errors condition on the filled categories; they do not propagate uncertainty in single mean/median replacements.' }] : []),
      ...(conditionNumber > 1e6
        ? [
            {
              code: "conditioning",
              message: `Ill-conditioned matrix (condition number ${conditionNumber.toPrecision(4)}).`,
            },
          ]
        : []),
      ...(unrotated.boundaryItems.length
        ? [
            {
              code: "uniqueness-boundary",
              message: "One or more optimized uniquenesses reached a bound.",
              items: unrotated.boundaryItems.map((i) => spec.items[i].column),
            },
          ]
        : []),
      ...(uniquenesses.some((v) => v < 0)
        ? [
            {
              code: "improper",
              message:
                "Improper solution: one or more communalities exceed one.",
            },
          ]
        : []),
    ],
    provenance: {
      inputSha256: data.fingerprint,
      engine: EFA_ENGINE,
      matrix: "ml-matrix/6.12.1",
      correlation: correlationDescription(data),
      extraction:
        unrotated.method ??
        "Reused saved MINRES extraction; see the originating run for optimizer provenance",
      rotation: `${spec.rotation}; oblimin delta=0 unnormalized; varimax normalized; promax power=4${estimator !== "minres" ? "; varimax convergence 1e-14; no additional observed-variable rescaling" : ""}${estimator === 'ml' ? '; canonical standardized ML loading basis' : ''}`,
      scoring: likelihood ? `Gaussian conditional factor mean under the saved model; ${likelihood.kind === 'fiml' ? 'conditions on each respondent’s observed items only; wholly missing rows unscored' : data.imputation ? `missing cells use fitted column ${data.imputation.method}` : 'complete cases'}` : `linear regression approximation: ${data.numeric ? 'numeric values' : 'ordinal ranks'} standardized on fitting sample; R^-1 × structure; ${data.imputation ? `missing cells use fitted column ${data.imputation.method}` : 'complete rows only'}`,
      seed: spec.seed,
    },
  };
}
export function fitEfa(
  data: EfaPreparedData, correlation: EfaCorrelations, spec: EfaSpec,
  progress?: Progress, extraction?: EfaExtraction,
): EfaResult {
  const steps = fitEfaSteps(data, correlation, spec, progress, extraction);
  if (computeSettings(spec).backend !== "cpu")
    throw new EfaError("backend-async", "Accelerated fits require the asynchronous EFA service.");
  let step = steps.next();
  while (!step.done) {
    const task = step.value;
    if (task.kind === "inference") step = steps.next(weightedInference(...task.args));
    else {
      const { context, covariance } = task;
      step = steps.next(rotatedUncertainty(context.identified, covariance,
        { pattern: context.referencePattern }, context.method, context.seed, progress));
    }
  }
  return step.value;
}

export function scoreEfa(
  data: EfaPreparedData,
  result: EfaResult,
): (number | null)[][] {
  const resultMethod = result.correlationMethod ?? (result.imputation && result.imputation.kind !== 'ordinal' ? 'pearson' : 'polychoric');
  if (preparedCorrelation(data) !== resultMethod)
    throw new EfaError("scoring-method", "The score inputs must use the saved fit's numeric or ordinal preparation method.");
  const k = result.weights[0].length,
    p = data.items.length,
    n = data.nRows,
    scores = Array.from({ length: data.originalRowCount }, () =>
      Array<number | null>(k).fill(null),
    );
  if (result.likelihood) {
    if (!data.numeric) throw new EfaError('scoring-method', 'Gaussian factor scores require numeric inputs.');
    const model = result.likelihood, project = createConditionalProjector(result);
    for (let row = 0; row < n; row++) {
      const values = Array.from({ length: p }, (_, j) => data.observed[j * n + row]
        ? data.numeric![j * n + row] + ((result.numericReverseOffsets ?? result.imputation?.reverseOffsets)?.[j] ?? 0) - ((data.numericReverseOffsets ?? data.imputation?.reverseOffsets)?.[j] ?? 0)
        : model.kind !== 'fiml' && result.imputation ? result.imputation.values[j] : null);
      const projected = project(values);
      if (projected) scores[data.rows[row]] = projected.factors;
    }
    return scores;
  }
  for (let row = 0; row < n; row++) {
    let complete = true;
    for (let j = 0; j < p; j++)
      if (!data.observed[j * n + row]) {
        complete = false;
        break;
      }
    if (!complete && !result.imputation) continue;
    const values = Array(k).fill(0);
    for (let j = 0; j < p; j++) {
      const value = data.numeric
        ? data.observed[j * n + row]
          ? data.numeric[j * n + row] + ((result.numericReverseOffsets ?? result.imputation?.reverseOffsets)?.[j] ?? 0) - ((data.numericReverseOffsets ?? data.imputation?.reverseOffsets)?.[j] ?? 0)
          : result.imputation!.values[j]
        : data.observed[j * n + row] ? data.codes[j * n + row] + 1 : result.imputation!.values[j];
      const z = (value - result.means[j]) / result.sds[j];
      for (let f = 0; f < k; f++) values[f] += z * result.weights[j][f];
    }
    scores[data.rows[row]] = values;
  }
  return scores;
}
