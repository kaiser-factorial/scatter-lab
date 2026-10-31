import { Matrix, solve } from "./math";
import { checkCorrelation, extractMinres } from "./extraction";
import { rotate } from "./rotation";
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
  const unrotated =
    extraction ?? extractMinres(correlation.matrix, spec.nFactors, progress);
  progress?.({ stage: "Rotation", completed: 0, total: 1 });
  const rotation = rotate(unrotated.loadings, spec.rotation, spec.seed),
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
  return {
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
      engine: "scatter-efa/1",
      matrix: "ml-matrix/6.12.1",
      correlation:
        "two-step polychoric; pair margins; maxcor=.9999; no smoothing",
      extraction:
        "MINRES lower-triangle objective; analytic spectral gradient; projected L-BFGS; uniqueness [.005,1]",
      rotation: `${spec.rotation}; oblimin delta=0 unnormalized; varimax normalized; promax power=4`,
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
