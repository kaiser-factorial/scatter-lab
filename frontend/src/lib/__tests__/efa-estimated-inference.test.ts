import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { prepareEfa } from "../efa/prepare";
import { correlate } from "../efa/correlation";
import { weightedMoments } from "../efa/weighted-moments";
import { extractDwls } from "../efa/dwls";
import { weightedInference, weightedInferenceWithEstimator } from "../efa/weighted-inference";
import { applyTraceOperatorCpu, rademacherProbes, probeSquaredNorms, traceEstimate, isTraceEstimate } from "../efa/trace-estimation";
import { computeSettings } from "../efa/backends/types";
import type { EfaSpec } from "../efa/types";
import type { DataTable } from "../table";

const input = JSON.parse(readFileSync(new URL("./fixtures/efa-weighted/normal.input.json", import.meta.url), "utf8")) as DataTable & { categories: number[][] };
const spec: EfaSpec = { items: input.columns.map((column, i) => ({ column, categories: input.categories[i], reverse: false })), extraction: "wlsmv", nFactors: 2, rotation: "oblimin", missing: "pairwise", seed: 73021, label: "test", sample: { partition: "all" } };
const data = prepareEfa(input, spec, Array.from({ length: input.nRows }, (_, i) => i)), correlation = correlate(data), moments = weightedMoments(data, correlation), fit = extractDwls(correlation.matrix, moments, 2);
const args = [data, moments, fit.loadings, fit.convergence.objective] as const;

it("keeps exact as default and bounds explicit estimated settings", () => {
  expect(computeSettings(spec)).toMatchObject({ correction: "exact" });
  expect(computeSettings({ ...spec, compute: { backend: "webgpu", correction: "estimated" } })).toMatchObject({ correction: "estimated", probes: 128, probeSeed: 61001 });
  expect(() => computeSettings({ ...spec, compute: { backend: "cpu", correction: "estimated" } })).toThrow(/requires/);
  expect(() => computeSettings({ ...spec, compute: { backend: "webgpu", correction: "estimated", probes: 17.5 } })).toThrow(/integer/);
});

it("changes only the second trace and corrected test, preserving canonical covariance and exact first trace", async () => {
  const exact = weightedInference(...args, undefined, { space: "cases" });
  const estimated = await weightedInferenceWithEstimator(async task => traceEstimate(probeSquaredNorms(applyTraceOperatorCpu(task.source, rademacherProbes(data.nRows, task.probes, task.seed), task.probes), task.probes), task.seed, task.probes), ...args, undefined, { correction: "estimated", probes: 64, probeSeed: 61001 });
  expect(estimated.covariance.to2DArray()).toEqual(exact.covariance.to2DArray());
  expect(estimated.test.trace).toBe(exact.test.trace);
  expect(estimated.test.traceEstimation).toMatchObject({ approximate: true, probes: 64, requestedProbes: 64, seed: 61001 });
  expect(estimated.test.traceSquared).not.toBe(exact.test.traceSquared);
  expect(estimated.test.scalingFactor).toBe(Math.sqrt(estimated.test.traceSquared / estimated.test.df));
  expect(estimated.test.statistic).toBeCloseTo(estimated.test.rawStatistic / estimated.test.scalingFactor! + estimated.test.shift!, 12);
});

it("rejects incomplete probe budgets and malformed uncertainty before returning a fit", async () => {
  await expect(weightedInferenceWithEstimator(async task => traceEstimate(Array(32).fill(1), task.seed, task.probes), ...args, undefined, { correction: "estimated", probes: 64, probeSeed: 1 })).rejects.toThrow(/Incomplete/);
  const estimate = traceEstimate([1, 2, 3], 1, 16);
  expect(isTraceEstimate(estimate)).toBe(true);
  expect(isTraceEstimate({ ...estimate, normalInterval95: [-1, 10] })).toBe(false);
  expect(isTraceEstimate({ ...estimate, rawScores: [1, 2] })).toBe(false);
  expect(isTraceEstimate({ ...estimate, seed: 1.5 })).toBe(false);
});
