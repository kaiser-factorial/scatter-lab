import { describe, it, expect } from "vitest";
import { mvRuntimeAdvice } from "../efa/runtime-advice";
import { planWeightedInference } from "../efa/weighted-inference";

describe("MV runtime advice", () => {
  it("uses fitting dimensions and moment-space feasibility, not a cell-count cutoff", () => {
    // Same 20,000 cells: very different item-pair matrices and available paths.
    const narrow = planWeightedInference(20, 5, 1000);
    const wide = planWeightedInference(200, 5, 100);
    expect(mvRuntimeAdvice(narrow)?.choice).toBe("exact-cpu");
    expect(mvRuntimeAdvice(wide)?.choice).toBe("exact");
  });
  it("describes large-case arithmetic without claiming measured speed or accuracy", () => {
    const plan = planWeightedInference(500, 5, 20000, undefined, { budgetBytes: 1536 * 1024 ** 2 });
    const before = structuredClone(plan);
    expect(mvRuntimeAdvice(plan, 128)).toMatchObject({ choice: "estimated-gpu" });
    expect(mvRuntimeAdvice(plan, 128)?.detail).toContain("39.1×");
    expect(mvRuntimeAdvice(plan, 128)?.detail).toContain("Accuracy is unknown");
    expect(mvRuntimeAdvice(plan, 4096)?.detail).toContain("1.2×");
    expect(plan).toEqual(before);
  });
  it("does not invent a chi-square comparison or accept an invalid probe budget", () => {
    expect(mvRuntimeAdvice(planWeightedInference(3, 1, 100))?.choice).toBe("no-test");
    expect(mvRuntimeAdvice(planWeightedInference(8, 2, 100), 0)).toBeUndefined();
  });
});
