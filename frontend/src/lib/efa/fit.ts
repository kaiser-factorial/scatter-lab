import { Matrix, solve } from "./math";
import { checkCorrelation, extractMinres } from "./extraction";
import { rotate } from "./rotation";
import { EFA_ENGINE, EfaError } from "./types";
import { extractDwls } from "./dwls";
import { weightedMoments } from "./weighted-moments";
import { planWeightedInference, weightedInference } from "./weighted-inference";
import { rotatedUncertainty } from "./weighted-rotation";
import type {
  EfaPreparedData,
  EfaCorrelations,
  EfaResult,
  EfaSpec,
  Progress,
  EfaExtraction,
} from "./types";

export function fitEfa(
  data: EfaPreparedData,
  correlation: EfaCorrelations,
  spec: EfaSpec,
  progress?: Progress,
  extraction?: EfaExtraction,
): EfaResult {
  const { conditionNumber } = checkCorrelation(correlation.matrix);
  const estimator = spec.extraction ?? "minres",
    pointEstimator = estimator === "minres" ? "minres" : "dwls";
  if (!["minres", "dwls", "wlsmv"].includes(estimator))
    throw new EfaError("method", "Unsupported EFA extractor.");
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
    );
  const moments =
    estimator === "minres"
      ? undefined
      : weightedMoments(data, correlation, progress);
  const unrotated =
    extraction ??
    (moments
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
  const weights = solve(new Matrix(correlation.matrix), s).to2DArray();
  let weighted: EfaResult["weighted"];
  if (moments) {
    weighted = {
      estimator: estimator as "dwls" | "wlsmv",
      samplingVariances: moments.pairs.map((pair) => pair.variance),
      fittingWeights: Array.from(moments.weights),
      uncertaintyMethod: moments.method,
      rawStatistic: (data.nRows - 1) * unrotated.convergence.objective,
      df:
        (p * (p - 1)) / 2 -
        (p * spec.nFactors - (spec.nFactors * (spec.nFactors - 1)) / 2),
    };
    if (estimator === "wlsmv") {
      const inference = weightedInference(
        data,
        moments,
        unrotated.loadings,
        unrotated.convergence.objective,
        progress,
      );
      weighted.robust = {
        test: inference.test,
        plan: inference.plan,
        standardErrors: rotatedUncertainty(
          inference.identified,
          inference.covariance,
          rotation,
          spec.rotation,
          spec.seed,
          progress,
        ),
      };
    }
  }
  return {
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
    means: data.means,
    sds: data.sds,
    weights,
    categoryCounts: data.counts,
    fittingRows: data.rows,
    originalRowCount: data.originalRowCount,
    conditionNumber,
    diagnostics: [
      ...data.diagnostics,
      ...correlation.diagnostics,
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
      correlation:
        "two-step polychoric; pair margins; maxcor=.9999; no smoothing",
      extraction:
        unrotated.method ??
        "Reused saved MINRES extraction; see the originating run for optimizer provenance",
      rotation: `${spec.rotation}; oblimin delta=0 unnormalized; varimax normalized; promax power=4${estimator !== "minres" ? "; weighted varimax convergence 1e-14; no additional observed-variable rescaling" : ""}`,
      scoring:
        "linear regression approximation: ordinal ranks standardized on fitting sample; R^-1 × structure; complete rows only",
      seed: spec.seed,
    },
  };
}
export function scoreEfa(
  data: EfaPreparedData,
  result: EfaResult,
): (number | null)[][] {
  const k = result.weights[0].length,
    p = data.items.length,
    n = data.nRows,
    scores = Array.from({ length: data.originalRowCount }, () =>
      Array<number | null>(k).fill(null),
    );
  for (let row = 0; row < n; row++) {
    let complete = true;
    for (let j = 0; j < p; j++)
      if (!data.observed[j * n + row]) {
        complete = false;
        break;
      }
    if (!complete) continue;
    const values = Array(k).fill(0);
    for (let j = 0; j < p; j++) {
      const z = (data.codes[j * n + row] + 1 - result.means[j]) / result.sds[j];
      for (let f = 0; f < k; f++) values[f] += z * result.weights[j][f];
    }
    scores[data.rows[row]] = values;
  }
  return scores;
}
