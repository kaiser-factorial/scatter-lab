import { describe, it, expect, vi } from "vitest";
import { runAssistantTurn, type AppBridge } from "../assistant";
import { call, replayTransport, say } from "../replay";
import { EfaController, type EfaContext } from "../efa/controller";
import { EfaService, type EfaJob } from "../efa/service";
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
  return { bridge, controller, get: () => context };
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
        expect(response.pattern).toHaveLength(8);
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
    const { bridge } = setup(),
      transport = replayTransport([
        call("run_efa", { spec }),
        () => call("efa_job", { jobId: "job-0", cancel: true }),
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
