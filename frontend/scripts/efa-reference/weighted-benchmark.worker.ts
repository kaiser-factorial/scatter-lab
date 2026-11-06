import { benchmarkData } from "./benchmark-data";
import { prepareEfa } from "../../src/lib/efa/prepare";
import { fingerprintPrepared } from "../../src/lib/efa/fingerprint";
import { correlate } from "../../src/lib/efa/correlation";
import { weightedMoments } from "../../src/lib/efa/weighted-moments";
import { extractDwls } from "../../src/lib/efa/dwls";
import {
  weightedInference,
  planWeightedInference,
} from "../../src/lib/efa/weighted-inference";
import { rotatedUncertainty } from "../../src/lib/efa/weighted-rotation";
import { rotate } from "../../src/lib/efa/rotation";
import { Matrix, solve } from "../../src/lib/efa/math";

self.onmessage = async (
  event: MessageEvent<{
    robust?: boolean;
    n?: number;
    p?: number;
    inferenceSpace?: "moments" | "cases";
  }>,
) => {
  const progress = (value: unknown) => self.postMessage({ progress: value }),
    timings: Record<string, number> = {};
  try {
    const n = event.data.n ?? 20000,
      p = event.data.p ?? 500,
      robust = event.data.robust ?? false;
    const { table, spec } = benchmarkData(n, p),
      rows = Array.from({ length: n }, (_, i) => i);
    const fit = async (indices: number[], prefix: string) => {
      let start = performance.now();
      const data = prepareEfa(table, spec, indices);
      data.fingerprint = await fingerprintPrepared(data);
      timings[prefix + "Preparation"] = performance.now() - start;
      start = performance.now();
      const correlation = correlate(data, progress);
      timings[prefix + "Correlations"] = performance.now() - start;
      start = performance.now();
      const moments = weightedMoments(data, correlation, progress);
      timings[prefix + "Uncertainty"] = performance.now() - start;
      start = performance.now();
      const extraction = extractDwls(
        correlation.matrix,
        moments,
        spec.nFactors,
        progress,
      );
      timings[prefix + "DWLS"] = performance.now() - start;
      const rotations: Record<string, unknown> = {};
      for (const method of ["oblimin", "promax", "varimax"] as const) {
        start = performance.now();
        const rotation = rotate(
          extraction.loadings,
          method,
          spec.seed,
          4,
          true,
        );
        timings[prefix + method] = performance.now() - start;
        const pattern = new Matrix(rotation.pattern),
          structure = pattern.mmul(new Matrix(rotation.phi));
        if (method === "oblimin") {
          start = performance.now();
          const weights = solve(new Matrix(correlation.matrix), structure),
            scores = new Float64Array(data.nRows * spec.nFactors);
          for (let row = 0; row < data.nRows; row++)
            for (let j = 0; j < p; j++) {
              const z =
                (data.codes[j * data.nRows + row] + 1 - data.means[j]) /
                data.sds[j];
              for (let f = 0; f < spec.nFactors; f++)
                scores[row * spec.nFactors + f] += z * weights.get(j, f);
            }
          if (scores.some((v) => !Number.isFinite(v)))
            throw new Error("Nonfinite scores");
          timings[prefix + "Scores"] = performance.now() - start;
        }
        rotations[method] = { convergence: rotation.convergence };
        if (robust) {
          start = performance.now();
          const inference = weightedInference(
            data,
            moments,
            extraction.loadings,
            extraction.convergence.objective,
            progress,
            { space: event.data.inferenceSpace },
          );
          timings[prefix + method + "RobustInference"] =
            performance.now() - start;
          start = performance.now();
          const se = rotatedUncertainty(
            inference.identified,
            inference.covariance,
            rotation,
            method,
            spec.seed,
            progress,
          );
          timings[prefix + method + "RotatedSE"] = performance.now() - start;
          rotations[method] = {
            convergence: rotation.convergence,
            test: inference.test,
            plan: inference.plan,
            derivativeMaxRelativeChange: se.derivativeMaxRelativeChange,
          };
        }
      }
      return {
        inputSha256: data.fingerprint,
        rows: data.nRows,
        convergence: extraction.convergence,
        rotations,
        varianceRange: [
          moments.pairs.reduce((v, p) => Math.min(v, p.variance), Infinity),
          moments.pairs.reduce((v, p) => Math.max(v, p.variance), -Infinity),
        ],
        robustPlan: planWeightedInference(p, spec.nFactors, data.nRows),
      };
    };
    const full = await fit(rows, "Full"),
      holdout = await fit(rows.slice(Math.floor(0.7 * n)), "Holdout");
    self.postMessage({
      result: {
        status: "passed",
        recordedAt: new Date().toISOString(),
        dimensions: { items: p, rows: n, factors: spec.nFactors },
        robustComputed: robust,
        method:
          "DWLS plus explicit WLSMV only when robustComputed=true; weighted rotations use varimax convergence 1e-14",
        timingsMs: timings,
        full,
        holdout,
      },
    });
  } catch (error) {
    self.postMessage({
      result: { status: "failed", error: String(error), timingsMs: timings },
    });
  }
};
