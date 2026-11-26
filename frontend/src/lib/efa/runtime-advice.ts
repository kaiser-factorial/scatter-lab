import { planWeightedInference, type InferencePlan } from "./weighted-inference";

/** Advisory operation counts, not a timing predictor or an accuracy classifier.
 * Uses the same dimensions/allocation planner as fitting, after sample preview. */
export function mvRuntimeAdvice(plan: InferencePlan, probes = 128, lookupCells?: number) {
  const { rows: n, pairs: m, parameters: q, budgetBytes } = plan;
  if (!Number.isInteger(probes) || probes < 16 || probes > 4096) return undefined;
  const p = (1 + Math.sqrt(1 + 8 * m)) / 2;
  // q = p*k - k*(k-1)/2 for this identified EFA parameterization.
  const k = Math.round((2 * p + 1 - Math.sqrt((2 * p + 1) ** 2 - 8 * q)) / 2);
  if (![n, m, q, p, k].every(Number.isSafeInteger) || n < 3 || k < 1 || q > m) return undefined;
  if (q === m) return { choice: "no-test" as const, title: "No global chi-square test at zero degrees of freedom.", detail: "The model has no remaining correlation restrictions to test. Loadings and standard errors can still be estimated." };
  try {
    const cpu = planWeightedInference(p, k, n, lookupCells, { budgetBytes });
    const estimated = planWeightedInference(p, k, n, lookupCells, { budgetBytes, correction: "estimated", probes });
    const exactCaseTrace = n * n * (m + q) / 2;
    const estimatedTrace = 2 * n * (m + q) * probes;
    const ratio = exactCaseTrace / estimatedTrace;
    if (cpu.space === "moments" && cpu.approximateMultiplyAdds <= estimated.approximateMultiplyAdds) {
      return { choice: "exact-cpu" as const, title: "Exact CPU is a good starting point for this battery.", detail: `The exact planner can use a ${m.toLocaleString()} × ${m.toLocaleString()} moment matrix, with less estimated arithmetic than ${probes} case-space probes and no GPU startup. Device timings can differ.` };
    }
    if (ratio > 1) return { choice: "estimated-gpu" as const, title: "Consider estimated WebGPU for trace speed.", detail: `At ${probes} probes, the case-space trace has about ${ratio.toFixed(1)}× fewer dot-product multiply-adds than exact WebGPU. This is a work estimate, not a measured speedup. Accuracy is unknown until probes run; larger dimensions do not guarantee smaller error.` };
    return { choice: "exact" as const, title: "Keep exact correction as the starting point.", detail: `At ${probes} probes, estimated correction has no trace-arithmetic advantage over exact WebGPU for these fitting rows. Hardware and startup costs also affect timing.` };
  } catch {
    return { choice: "budget" as const, title: "Compare runtime options within the selected memory budget.", detail: "An alternative calculation exceeds the allocation estimate. This advice does not change the selected method or bypass its memory checks." };
  }
}
