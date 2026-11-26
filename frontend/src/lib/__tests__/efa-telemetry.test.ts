import { expect, it } from "vitest";
import { ComputeTrace, WorkerStageTimer } from "../efa/telemetry";
import type { EfaSpec } from "../efa/types";

it("freezes monotonic durations and separates result acceptance from computation", () => {
  let now = 10;
  const trace = new ComputeTrace("test", () => now);
  now = 20; trace.progress({ stage: "MINRES · projected gradient 1e-1", completed: 1, total: 100 });
  now = 40; trace.progress({ stage: "MINRES · projected gradient 1e-5", completed: 9, total: 100 });
  now = 50; trace.finish("completed");
  now = 80; trace.publication("discarded");
  const report = trace.snapshot();
  expect(report.elapsedMs).toBe(40);
  expect(report.stages).toEqual([
    { stage: "Preparing", completed: 0, total: 1, durationMs: 10 },
    { stage: "MINRES", completed: 9, total: 100, durationMs: 30 },
  ]);
  expect(report.status).toBe("completed");
  expect(report.publication).toBe("discarded");
  expect(report.events.at(-1)?.elapsedMs).toBe(70);
  trace.finish("cancelled");
  expect(trace.snapshot().status).toBe("completed");
});

it("bounds event and stage detail while preserving totals and detached snapshots", () => {
  const trace = new ComputeTrace("bounded");
  for (let i = 0; i < 10000; i++) {
    trace.event("request", "pairs completed");
    trace.request("pairs", 2, 1, 0.1);
    trace.progress({ stage: `stage ${i}`, completed: 0, total: 1 });
  }
  trace.finish("completed");
  const first = trace.snapshot();
  expect(first.events).toHaveLength(512);
  expect(first.stages).toHaveLength(128);
  expect(first.droppedEvents).toBeGreaterThan(19000);
  expect(first.requests.pairs.count).toBe(10000);
  first.requests.pairs.count = -1;
  first.events.length = 0;
  expect(trace.snapshot().requests.pairs.count).toBe(10000);
  expect(trace.snapshot().events).toHaveLength(512);
  const worker = new WorkerStageTimer("initial");
  for (let i = 0; i < 1000; i++) worker.change(`stage ${i}`);
  const timings = worker.finish();
  expect(Object.keys(timings)).toHaveLength(128);
  expect(timings["Other stages"]).toBeGreaterThanOrEqual(0);
  trace.workerTiming(timings);
  trace.workerTiming({ "additional stage": 7 });
  expect(Object.keys(trace.snapshot().workerStages)).toHaveLength(128);
});

it("exports specification metadata without names, categories, labels, or membership", () => {
  const trace = new ComputeTrace("privacy");
  const spec: EfaSpec = {
    label: "PRIVATE-RUN", items: [{ column: "PRIVATE-ITEM", categories: ["PRIVATE-CATEGORY", "other"], reverse: true }],
    extraction: "dwls", nFactors: 1, rotation: "oblimin", missing: "pairwise", seed: 42,
    sample: { partition: "development", splitId: "PRIVATE-SPLIT", fixedRows: [123456] },
  };
  trace.spec(spec, 10, "fit");
  trace.prepared(8, 1, "digest");
  const output = JSON.stringify(trace.snapshot());
  expect(output).not.toContain("PRIVATE");
  expect(output).not.toContain("123456");
  expect(trace.snapshot().context).toEqual({ operation: "fit", items: 1, factors: 1, eligibleRows: 10, fittingRows: 8, extraction: "dwls", rotation: "oblimin", missing: "pairwise", partition: "development", inputSha256: "digest" });
  trace.spec({ ...spec, rotation: "PRIVATE-IMPORTED-TEXT" as EfaSpec["rotation"] }, 10);
  expect(trace.snapshot().context.rotation).toBe("invalid");
  expect(JSON.stringify(trace.snapshot())).not.toContain("PRIVATE");
});
