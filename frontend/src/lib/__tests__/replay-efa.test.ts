import { describe, it, expect, vi } from "vitest";
import { runAssistantTurn, type AppBridge } from "../assistant";
import { call, replayTransport, say } from "../replay";
import { EfaController, type EfaContext } from "../efa/controller";
import { EfaService, type EfaJob } from "../efa/service";
import { ComputeTrace } from "../efa/telemetry";
import { prepareEfa } from "../efa/prepare";
import { correlate } from "../efa/correlation";
import { fitEfa, scoreEfa } from "../efa/fit";
import { parallelAnalysis } from "../efa/parallel";
import type { EfaRun, EfaSpec, EfaResult, ParallelResult } from "../efa/types";
import { readFileSync } from "node:fs";
import type { DataTable } from "../table";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

const table = JSON.parse(
  readFileSync(
    new URL("./fixtures/efa/mixed.input.json", import.meta.url),
    "utf8",
  ),
) as DataTable & { categories: number[][] };
const spec: EfaSpec = {
  items: table.columns.map((column, i) => ({
    column,
    categories: table.categories[i],
    reverse: false,
  })),
  nFactors: 2,
  rotation: "oblimin",
  missing: "pairwise",
  seed: 73021,
  label: "public-fixture",
  sample: { partition: "all" },
};
const rows = Array.from({ length: table.nRows }, (_, i) => i),
  data = prepareEfa(table, spec, rows),
  result = fitEfa(data, correlate(data), spec);
const initial: EfaRun = {
  id: "baseline",
  revision: 1,
  createdAt: "2026-10-30",
  datasetRevision: "fixture",
  spec,
  result,
  eligibleRows: rows,
  kind: "fit",
  reviews: {},
  reasons: "",
  revisedAfterHoldout: false,
  scoreColumns: [],
};
function setup(patch: Partial<EfaContext> = {}) {
  let context: EfaContext = {
    datasetId: 1,
    table,
    eligibleRows: rows,
    state: {
      runs: [initial, { ...initial, id: "comparison", revision: 2 }],
      splits: [],
    },
    privateMode: true,
    afterFullExploration: true,
    filterKey: "all",
    ...patch,
  };
  const service = new EfaService(),
    jobs = new Map<string, EfaJob>();
  const job = <T>(value: T): EfaJob<T> => {
    const j: EfaJob<T> = {
      trace: new ComputeTrace("replay"),
      id: `job-${jobs.size}`,
      status: "completed",
      progress: { stage: "Completed", completed: 1, total: 1 },
      result: value,
      promise: Promise.resolve(value),
      cancel: () => {
        j.status = "cancelled";
      },
    };
    jobs.set(j.id, j);
    return j;
  };
  vi.spyOn(service, "fit").mockImplementation(() => job<EfaResult>(result));
  vi.spyOn(service, "getJob").mockImplementation((id) => jobs.get(id));
  vi.spyOn(service, "scores").mockImplementation(() =>
    job(scoreEfa(data, result)),
  );
  vi.spyOn(service, "parallel").mockImplementation(() =>
    job<ParallelResult>(parallelAnalysis(data, 12, 2)),
  );
  vi.spyOn(service, "cancelAll").mockImplementation(() =>
    jobs.forEach((j) => j.cancel()),
  );
  const controller = new EfaController(service, () => ({
    context: () => context,
    state: (_id, _table, update) => {
      context = { ...context, state: update(context.state) };
    },
    scores: (_id, _table, next) => {
      context = { ...context, table: next };
    },
  }));
  const bridge = {
    current: {
      getState: () => ({
        datasets: [
          {
            name: "fixture",
            nRows: table.nRows,
            active: true,
            dataMode: "private",
          },
        ],
        columns: [],
        axes: { x: "item1", y: "item2", z: null },
        colorBy: "",
        shapeBy: "",
        viewMode: "2D",
        pinnedViews: 0,
        clusterSettings: {
          method: "NONE",
          eps: 0.5,
          minSamples: 5,
          k: 3,
          standardize: false,
        },
        clusterBreakdown: {
          attribute: "",
          direction: "cluster",
          palette: "Viridis",
        },
        pcaRuns: [],
      }),
      efa: controller.tool,
      snapshot: () => context,
      restore: (snap: EfaContext) => {
        controller.cancel();
        context = snap;
      },
    } as unknown as AppBridge,
  };
  return { bridge, controller, service, jobs, job, get: () => context };
}
async function replay(
  action: string,
  args: Record<string, unknown>,
  check: (text: string) => void,
  patch: Partial<EfaContext> = {},
) {
  const { bridge } = setup(patch),
    transport = replayTransport([
      call(action, args),
      (ctx) => {
        check(ctx.lastObservation ?? "");
        return say("done");
      },
    ]);
  await runAssistantTurn(
    "",
    "",
    "replay",
    [] as ChatCompletionMessageParam[],
    "go",
    bridge,
    { onText: () => {}, onToolUse: () => {} },
    transport,
  );
}
describe("EFA tools through the real offline assistant loop", () => {
  it("rejects a tiny private selection through the assistant loop", async () =>
    replay("run_efa", { spec }, (text) => expect(text).toContain("privacy"), {
      eligibleRows: [0, 1, 2, 3],
    }));
  it("rejects mislabeled rotation comparisons through the assistant loop", async () =>
    replay(
      "run_efa",
      {
        spec: { ...spec, missing: "complete" },
        parentId: "baseline",
        kind: "rotation",
      },
      (text) => expect(text).toContain("rotation"),
    ));
  it("refuses score publication from a saved rare-pair run through the assistant loop", async () =>
    replay(
      "add_efa_scores",
      { runId: "baseline" },
      (text) => expect(text).toContain("privacy"),
      {
        state: {
          runs: [
            {
              ...initial,
              result: {
                ...result,
                correlation: {
                  ...result.correlation,
                  pairs: result.correlation.pairs.map((p, i) =>
                    i === 0 ? { ...p, n: 4 } : p,
                  ),
                },
              },
            },
          ],
          splits: [],
        },
      },
    ));
  it("starts a fit, polls its completion and retrieves aggregate diagnostics", async () => {
    const { bridge } = setup();
    const transport = replayTransport([
      call("run_efa", { spec }),
      (ctx) => {
        const response = JSON.parse(ctx.lastObservation ?? "");
        expect(response.jobId).toBe("job-0");
        return call("efa_job", { jobId: response.jobId });
      },
      (ctx) => {
        const response = JSON.parse(ctx.lastObservation ?? "");
        expect(response.status).toBe("completed");
        return call("get_efa_diagnostics", { runId: response.runId });
      },
      (ctx) => {
        const response = JSON.parse(ctx.lastObservation ?? "");
        expect(response.nItems).toBe(8);
        expect(response.readItemsWith).toContain("get_efa_items");
        expect(response).not.toHaveProperty("fittingRows");
        expect(response).not.toHaveProperty("scores");
        return say("done");
      },
    ]);
    await runAssistantTurn(
      "",
      "",
      "replay",
      [],
      "go",
      bridge,
      { onText: () => {}, onToolUse: () => {} },
      transport,
    );
  });
  it("compares shared items without exposing respondent ids", async () =>
    replay(
      "compare_efa",
      { runId: "baseline", otherRunId: "comparison" },
      (text) => {
        expect(text).toContain("congruence");
        expect(text).not.toContain("eligibleRows");
      },
    ));
  it("adds scores and returns names only", async () =>
    replay("add_efa_scores", { runId: "baseline" }, (text) => {
      expect(text).toContain("FA1_public-fixture_r1");
      expect(text).toContain("incomplete");
    }));
  it("starts a simulation job", async () =>
    replay("parallel_efa", { spec, replicates: 2 }, (text) =>
      expect(JSON.parse(text).jobId).toBe("job-0"),
    ));
  it("cancels a job through the loop", async () => {
    const { bridge, jobs } = setup(),
      transport = replayTransport([
        call("run_efa", { spec }),
        () => {
          jobs.get("job-0")!.status = "running";
          return call("efa_job", { jobId: "job-0", cancel: true });
        },
        (ctx) => {
          expect(ctx.lastObservation).toContain("cancelled");
          return say("done");
        },
      ]);
    await runAssistantTurn(
      "",
      "",
      "replay",
      [],
      "go",
      bridge,
      { onText: () => {}, onToolUse: () => {} },
      transport,
    );
  });
  for (const action of [
    "run_efa",
    "efa_job",
    "get_efa_diagnostics",
    "compare_efa",
    "add_efa_scores",
    "parallel_efa",
    "get_efa_items",
    "update_efa_items",
    "refit_efa_selection",
  ])
    it(`${action} rejects invalid requests without raw-value disclosure`, async () =>
      replay(
        action,
        {
          runId: "missing",
          jobId: "missing",
          spec: { secret: "rare response" },
        },
        (text) => {
          expect(text).toContain("EFA action failed");
          expect(text).not.toContain("rare response");
        },
      ));
});

// Full model-loop replays: no model/provider calls and no participant fixtures.
import { MUTATING_TOOLS } from "../assistant";
import {
  summarizeImputations,
  observedPairFloor,
} from "../efa/imputation-analysis";
import { validateEfaState } from "../efa/persistence";
import type { EfaImputationRun } from "../efa/types";
import type { ReplayStep } from "../replay";
const miOptions = {
  imputations: 2,
  iterations: 2,
  seed: 91,
  predictors: spec.items.map((_, i) =>
    spec.items.flatMap((__, j) => (i === j ? [] : [j])),
  ),
};
const miResult = summarizeImputations(
  data,
  miOptions,
  [0, 1].map((imputation) => ({
    trace: [],
    fit: { imputation, replacements: [], result },
  })),
);
const miRun: EfaImputationRun = { ...initial, id: "mi", result: miResult };
async function play(
  bridge: ReturnType<typeof setup>["bridge"],
  steps: ReplayStep[],
) {
  const transport = replayTransport(steps);
  await runAssistantTurn(
    "",
    "",
    "replay",
    [],
    "Review and refine this item set",
    bridge,
    { onText: () => {}, onToolUse: () => {} },
    transport,
  );
  return transport;
}
describe("bounded EFA item collaboration", () => {
  it("lists, inspects, selects, refits, compares and undoes through the shared controller", async () => {
    const { bridge, service, controller, get, job } = setup();
    vi.mocked(service.fit).mockImplementation((t, s, rows) => {
      const prepared = prepareEfa(t, s, rows);
      return job(fitEfa(prepared, correlate(prepared), s));
    });
    const before = bridge.current.snapshot();
    let child = "";
    const transport = await play(bridge, [
      call("list_efa_runs"),
      (ctx) => {
        const r = JSON.parse(ctx.lastObservation!);
        expect(r.runs).toHaveLength(2);
        expect(ctx.toolNames).toContain("update_efa_items");
        return call("get_efa_items", {
          runId: "baseline",
          limit: 2,
          factorLimit: 1,
        });
      },
      (ctx) => {
        const r = JSON.parse(ctx.lastObservation!);
        expect(r.nextOffset).toBe(2);
        expect(r.nextFactorOffset).toBe(1);
        expect(r.items[0].pattern).toHaveLength(1);
        expect(r.items[0].uniqueness).toBe(result.uniquenesses[0]);
        expect(r.items[0].relatedItems).toHaveLength(3);
        return call("update_efa_items", {
          runId: "baseline",
          expectedReviewRevision: r.reviewRevision,
          changes: [
            {
              column: spec.items[7].column,
              status: "exclude",
              note: "Review content redundancy with the retained items",
            },
          ],
        });
      },
      (ctx) => {
        const r = JSON.parse(ctx.lastObservation!);
        expect(r.reviewRevision).toBe(1);
        expect(r.selected).toBe(7);
        expect(get().state.runs[0].reviews[spec.items[7].column].status).toBe(
          "exclude",
        );
        return call("refit_efa_selection", {
          runId: "baseline",
          expectedReviewRevision: 1,
          label: "seven items",
          reasons: "Content redundancy review",
        });
      },
      (ctx) =>
        call("efa_job", { jobId: JSON.parse(ctx.lastObservation!).jobId }),
      (ctx) => {
        child = JSON.parse(ctx.lastObservation!).runId;
        return call("compare_efa", { runId: "baseline", otherRunId: child });
      },
      (ctx) => {
        const r = JSON.parse(ctx.lastObservation!);
        expect(r.sharedItemCount).toBe(7);
        expect(r.sameRows).toBe(true);
        expect(r.comparison.parentReviewRevision).toBe(1);
        return say("Saved the seven-item candidate; baseline retained.");
      },
    ]);
    expect(get().state.runs[0].result).toBe(result);
    expect(
      get().state.runs.find((r) => r.id === child)?.spec.items,
    ).toHaveLength(7);
    expect(get().state.runs.find((r) => r.id === child)?.scoreColumns).toEqual(
      [],
    );
    expect(() => validateEfaState(get().state, table.nRows)).not.toThrow();
    expect(JSON.stringify(transport.seen)).not.toContain("thresholdsX");
    expect(MUTATING_TOOLS.has("update_efa_items")).toBe(true);
    expect(MUTATING_TOOLS.has("refit_efa_selection")).toBe(true);
    bridge.current.restore(before);
    expect(get().state.runs).toHaveLength(2);
    expect(
      JSON.parse(await controller.tool("get_efa_items", { runId: "baseline" }))
        .reviewRevision,
    ).toBe(0);
  });
  it("rejects stale revisions after a user edit, without overwriting the visible selection", async () => {
    const { bridge, controller, get } = setup();
    controller.reviews("baseline", {
      [spec.items[0].column]: { status: "investigate", note: "User note" },
    });
    await play(bridge, [
      call("update_efa_items", {
        runId: "baseline",
        expectedReviewRevision: 0,
        changes: [
          {
            column: spec.items[0].column,
            status: "exclude",
            note: "Stale edit",
          },
        ],
      }),
      (ctx) => {
        expect(ctx.lastObservation).toContain("review-conflict");
        return call("refit_efa_selection", {
          runId: "baseline",
          expectedReviewRevision: 0,
          label: "stale",
          reasons: "stale",
        });
      },
      (ctx) => {
        expect(ctx.lastObservation).toContain("review-conflict");
        return say("Reread the current review.");
      },
    ]);
    expect(get().state.runs[0].reviews[spec.items[0].column].status).toBe(
      "investigate",
    );
  });
  it("does not cancel a current job when asked to cancel an already completed job", async () => {
    const { bridge, service, job } = setup();
    job(result);
    const active = job(result);
    active.status = "running";
    await play(bridge, [
      call("efa_job", { jobId: "job-0", cancel: true }),
      (ctx) => {
        expect(ctx.lastObservation).toContain("completed");
        return say("The old job is already complete.");
      },
    ]);
    expect(active.status).toBe("running");
    expect(service.cancelAll).not.toHaveBeenCalled();
  });
  it("supports MICE separate-fit and descriptive views, retaining uncertainty distinctions", async () => {
    await replay(
      "get_efa_items",
      { runId: "mi", view: "imputation-summary", limit: 1 },
      (text) => {
        const r = JSON.parse(text);
        expect(r.view).toBe("aligned-imputation-summary");
        expect(r.items[0].betweenImputation.pattern[0].sd).toBe(0);
        expect(r.uncertainty).toContain("not a pooled SE");
        expect(text).not.toContain("replacements");
        expect(text).not.toContain("missingPositions");
      },
      { state: { runs: [], splits: [], imputationRuns: [miRun] } },
    );
    await replay(
      "get_efa_items",
      { runId: "mi", imputation: 2 },
      (text) => {
        expect(JSON.parse(text).imputation).toBe(2);
      },
      { state: { runs: [], splits: [], imputationRuns: [miRun] } },
    );
  });
  it("refits MICE asynchronously with reduced predictor sets and original fitting membership", async () => {
    const { bridge, service, job, get } = setup({
      state: { runs: [], splits: [], imputationRuns: [miRun] },
    });
    const spy = vi
      .spyOn(service, "impute")
      .mockImplementation(() => job(miResult));
    await play(bridge, [
      call("update_efa_items", {
        runId: "mi",
        expectedReviewRevision: 0,
        changes: [
          {
            column: spec.items[0].column,
            status: "exclude",
            note: "Redundancy",
          },
        ],
      }),
      () =>
        call("refit_efa_selection", {
          runId: "mi",
          expectedReviewRevision: 1,
          label: "MICE candidate",
          reasons: "Redundancy",
        }),
      (ctx) =>
        call("efa_job", { jobId: JSON.parse(ctx.lastObservation!).jobId }),
      (ctx) => {
        expect(JSON.parse(ctx.lastObservation!).simulationId).toBeTruthy();
        return say("Saved.");
      },
    ]);
    expect(spy.mock.calls[0][1].items).toHaveLength(7);
    expect(spy.mock.calls[0][1].sample.fixedRows).toEqual(result.fittingRows);
    expect(spy.mock.calls[0][3].predictors).toHaveLength(7);
    expect(spy.mock.calls[0][3].predictors[0]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(spy.mock.calls[0][4]).toBe(5);
    expect(get().state.imputationRuns?.[1].parentReviewRevision).toBe(1);
  });
  it("counts original pair support, never the imputed sample size", () => {
    const sparse = { ...data, observed: data.observed.slice() };
    sparse.observed.fill(0, 0, data.nRows);
    sparse.observed.fill(1, 0, 4);
    expect(observedPairFloor(sparse)).toBe(4);
  });
  for (const floor of [undefined, 4])
    for (const action of [
      "get_efa_items",
      "get_efa_diagnostics",
      "update_efa_items",
      "refit_efa_selection",
    ])
      it(`${action} withholds MICE original support=${floor}`, async () => {
        await replay(
          action,
          { runId: "mi" },
          (text) => expect(text).toContain("privacy"),
          {
            state: {
              runs: [],
              splits: [],
              imputationRuns: [
                { ...miRun, result: { ...miResult, observedPairFloor: floor } },
              ],
            },
          },
        );
      });
  it("keeps private notes and diagnostic canaries out of provider-visible observations", async () => {
    const canary = "RARE_PARTICIPANT_CANARY";
    const privateRun = {
      ...initial,
      reviews: {
        [spec.items[0].column]: { status: "retain" as const, note: canary },
      },
      result: { ...result, diagnostics: [{ code: canary, message: canary }] },
    };
    const { bridge } = setup({ state: { runs: [privateRun], splits: [] } });
    const transport = await play(bridge, [
      call("get_efa_items", { runId: "baseline" }),
      () => call("get_efa_diagnostics", { runId: "baseline" }),
      (ctx) => {
        expect(JSON.stringify(ctx.observations)).not.toContain(canary);
        return say("Only aggregates are exposed.");
      },
    ]);
    expect(transport.seen.at(-1)?.observations[0]).toContain("hasLocalNote");
  });
  it("exposes notes in explicitly open mode", async () =>
    replay(
      "get_efa_items",
      { runId: "baseline" },
      (text) => expect(text).toContain("Substantive note"),
      {
        privateMode: false,
        state: {
          runs: [
            {
              ...initial,
              reviews: {
                [spec.items[0].column]: {
                  status: "investigate",
                  note: "Substantive note",
                },
              },
            },
          ],
          splits: [],
        },
      },
    ));
  it("reports robust within-fit standard errors through the item tool", async () => {
    const weightedSpec = { ...spec, extraction: "wlsmv" as const },
      weightedResult = fitEfa(data, result.correlation, weightedSpec);
    await replay(
      "get_efa_items",
      { runId: "baseline", limit: 1 },
      (text) => {
        const r = JSON.parse(text);
        expect(r.items[0].standardErrors.pattern).toEqual(
          weightedResult.weighted!.robust!.standardErrors.pattern[0],
        );
        expect(r.extraction).toBe("wlsmv");
      },
      {
        state: {
          runs: [{ ...initial, spec: weightedSpec, result: weightedResult }],
          splits: [],
        },
      },
    );
  });
  for (const [action, args, code] of [
    ["list_efa_runs", { limit: 21 }, "page"],
    ["get_efa_items", { limit: 21 }, "page"],
    ["get_efa_items", { factorLimit: 13 }, "page"],
    ["get_efa_items", { columns: ["missing"] }, "items"],
    [
      "get_efa_items",
      { columns: [spec.items[0].column, spec.items[0].column] },
      "items",
    ],
    ["get_efa_items", { view: "unknown" }, "view"],
    ["get_efa_items", { view: "imputation-summary" }, "view"],
    ["get_efa_items", { imputation: 1 }, "imputation"],
    ["update_efa_items", { expectedReviewRevision: 0, changes: [] }, "items"],
    [
      "update_efa_items",
      {
        expectedReviewRevision: 0,
        changes: [{ column: "missing", status: "retain", note: "" }],
      },
      "items",
    ],
    [
      "update_efa_items",
      {
        expectedReviewRevision: 0,
        changes: [{ column: spec.items[0].column, status: "delete", note: "" }],
      },
      "items",
    ],
    [
      "refit_efa_selection",
      { expectedReviewRevision: 0, label: "", reasons: "" },
      "refit",
    ],
    [
      "refit_efa_selection",
      {
        expectedReviewRevision: 0,
        label: "test",
        reasons: "test",
        nFactors: 7,
      },
      "identification",
    ],
  ] as const)
    it(`rejects ${action} ${JSON.stringify(args)}`, async () =>
      replay(action, { runId: "baseline", ...args }, (text) =>
        expect(text).toContain(code),
      ));
  for (const [action, args, code] of [
    ["get_efa_items", { imputation: 3 }, "page"],
    ["get_efa_items", { imputation: 1, view: "imputation-summary" }, "view"],
    ["add_efa_scores", {}, "imputation-scores"],
    [
      "refit_efa_selection",
      {
        expectedReviewRevision: 0,
        label: "test",
        reasons: "test",
        keepRows: false,
      },
      "refit",
    ],
  ] as const)
    it(`rejects MICE ${action} ${JSON.stringify(args)}`, async () =>
      replay(
        action,
        { runId: "mi", ...args },
        (text) => expect(text).toContain(code),
        { state: { runs: [], splits: [], imputationRuns: [miRun] } },
      ));
});


describe("EFA backend assistant replay", () => {
  it.each(["webgpu", "scala"] as const)("passes an explicit %s selection through the shared controller", async backend => {
    const { bridge, service } = setup();
    await play(bridge, [call("run_efa", { spec: { ...spec, extraction: "wlsmv", compute: { backend } } }), ctx => {
      expect(JSON.parse(ctx.lastObservation!).jobId).toBeDefined(); return say("done");
    }]);
    expect(service.fit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ compute: { backend } }), expect.anything(), undefined, 5);
  });
  it.each([
    { backend: "unknown" }, { backend: "scala", token: "do-not-export" },
    { backend: "cpu", correction: "estimated" }, { backend: "scala", correction: "estimated" },
    { backend: "webgpu", correction: "unknown" }, { backend: "webgpu", correction: "estimated", probes: 1 },
    { backend: "webgpu", correction: "estimated", probes: 4097 }, { backend: "webgpu", correction: "estimated", probes: 16.5 },
    { backend: "webgpu", correction: "estimated", probeSeed: -1 }, { backend: "webgpu", correction: "estimated", probeSeed: 4294967296 },
    { backend: "webgpu", blockSize: 512 }, { backend: "webgpu", memoryMiB: 1 },
  ])("rejects invalid or credential-bearing settings offline", async compute => {
    const { bridge, service } = setup();
    await play(bridge, [call("run_efa", { spec: { ...spec, extraction: "wlsmv", compute } }), ctx => {
      expect(ctx.lastObservation).toContain("EFA action failed"); expect(ctx.lastObservation).not.toContain("do-not-export"); return say("done");
    }]);
    expect(service.fit).not.toHaveBeenCalled();
  });
  it("does not let an assistant supply a companion endpoint", async () => {
    const { bridge, service } = setup();
    await play(bridge, [call("run_efa", { spec: { ...spec, extraction: "wlsmv", compute: { backend: "scala", url: "https://external.example" } } }), ctx => {
      expect(ctx.lastObservation).toContain("EFA action failed"); return say("done");
    }]);
    expect(service.fit).not.toHaveBeenCalled();
  });
});

it("offline assistant replay cannot start Scala without an explicit UI pairing", async () => {
  const { bridge, service } = setup();
  vi.mocked(service.fit).mockRestore();
  await play(bridge, [call("run_efa", { spec: { ...spec, extraction: "wlsmv", compute: { backend: "scala" } } }), ctx => {
    expect(ctx.lastObservation).toContain("EFA action failed (companion-unavailable)"); return say("done");
  }]);
  expect(service.listJobs()).toHaveLength(0);
});

it("offline replay preserves explicit MV probe settings and their approximation label", async () => {
  const { bridge, service } = setup();
  const compute = { backend: "webgpu", correction: "estimated", probes: 64, probeSeed: 789 };
  await play(bridge, [call("run_efa", { spec: { ...spec, extraction: "wlsmv", compute } }), ctx => {
    expect(JSON.parse(ctx.lastObservation!).jobId).toBeDefined(); return say("done");
  }]);
  expect(service.fit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ compute }), expect.anything(), undefined, 5);
});
