import { it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { prepareEfa } from "../efa/prepare";
import { fitEfa } from "../efa/fit";
import { correlate } from "../efa/correlation";
import {
  fitImputationChain,
  summarizeImputations,
  type ImputationAnalysis,
} from "../efa/imputation-analysis";
import { bootstrapStability, type StabilityResult } from "../efa/stability";
import { EfaController, type EfaContext } from "../efa/controller";
import { EfaService, type EfaJob } from "../efa/service";
import { validateWorkspace } from "../workspaces";
import { fingerprintPrepared } from "../efa/fingerprint";
import type { EfaSpec, EfaState, EfaRun } from "../efa/types";
import type { DataTable } from "../table";
import type { MiceOptions } from "../efa/mice";
const fixture = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/efa-extensions/mice-chain.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { table: DataTable & { categories: number[][] }; options: MiceOptions };
const table = fixture.table,
  rows = Array.from({ length: table.nRows }, (_, i) => i),
  spec: EfaSpec = {
    items: table.columns.map((column, i) => ({
      column,
      categories: table.categories[i],
      reverse: false,
    })),
    nFactors: 1,
    rotation: "oblimin",
    missing: "pairwise",
    seed: 1,
    label: "saved extensions",
    sample: { partition: "all" },
  };
const prepared = prepareEfa(table, spec, rows),
  options = { ...fixture.options, iterations: 1 };
const imputation = summarizeImputations(
  prepared,
  options,
  [0, 1].map((i) => fitImputationChain(prepared, spec, options, i)),
);
const run: EfaRun = {
  id: "baseline",
  revision: 1,
  createdAt: "2026-10-31",
  datasetRevision: "fixture",
  spec,
  result: fitEfa(prepared, correlate(prepared), spec),
  eligibleRows: rows,
  kind: "fit",
  reviews: {},
  reasons: "baseline",
  revisedAfterHoldout: false,
  scoreColumns: [],
};
const stabilityOptions = {
    replicates: 2,
    seed: 1,
    confidence: 0.95,
    crossLoadingThreshold: 0.3,
  },
  stability = bootstrapStability(prepared, spec, run.result, stabilityOptions);
const state: EfaState = {
  runs: [run],
  splits: [],
  imputationRuns: [
    {
      id: "imputations",
      revision: 1,
      createdAt: "2026-10-31",
      datasetRevision: "fixture",
      spec,
      eligibleRows: rows,
      reviews: { item1: { status: "investigate", note: "Content coverage" } },
      reasons: "MAR sensitivity",
      revisedAfterHoldout: false,
      result: imputation,
    },
  ],
  stabilityRuns: [
    {
      id: "bootstrap",
      runId: run.id,
      createdAt: "2026-10-31",
      datasetRevision: "fixture",
      result: stability,
    },
  ],
};
const workspace = {
  version: 2,
  tables: { t0: table },
  datasets: [{ id: 1, name: "extensions", table: "t0", efa: state }],
};
it("fingerprints exact encoded views, missingness, item transformations and original row membership", async () => {
  const original = await fingerprintPrepared(prepared);
  const storage = new Uint16Array(prepared.codes.length + 4);
  storage.set(prepared.codes, 2);
  expect(
    await fingerprintPrepared({ ...prepared, codes: storage.subarray(2, -2) }),
  ).toBe(original);
  const mutations = [
    (d: typeof prepared) => {
      d.observed[0] = 1 - d.observed[0];
    },
    (d: typeof prepared) => {
      d.codes[0] = (d.codes[0] + 1) % d.items[0].categories.length;
    },
    (d: typeof prepared) => {
      d.rows.reverse();
    },
    (d: typeof prepared) => {
      d.items[0].reverse = !d.items[0].reverse;
    },
  ];
  for (const change of mutations) {
    const data = structuredClone(prepared);
    change(data);
    expect(await fingerprintPrepared(data)).not.toBe(original);
  }
});
it("round-trips separate imputations, replacement cells, aligned analyses and repeated bootstrap memberships", () => {
  const restored = JSON.parse(JSON.stringify(workspace));
  expect(() => validateWorkspace(restored)).not.toThrow();
  expect(restored.datasets[0].efa).toEqual(state);
  expect(imputation.completed).toBe(2);
  expect(imputation.fits[0].replacements).not.toEqual(
    imputation.fits[1].replacements,
  );
});
it("preserves an entirely failed imputation analysis so its diagnostics can be restored", () => {
  const failed = summarizeImputations(
    prepared,
    options,
    [0, 1].map((imputation) => ({
      trace: [],
      failure: {
        imputation,
        stage: "imputation" as const,
        error: "Declared category absent",
      },
    })),
  );
  const saved = structuredClone(workspace);
  saved.datasets[0].efa.imputationRuns![0].result = failed;
  expect(failed.completed).toBe(0);
  expect(failed.provisional).toBe(true);
  expect(() =>
    validateWorkspace(JSON.parse(JSON.stringify(saved))),
  ).not.toThrow();
});
it("rejects damaged imputation positions, duplicate chains, invalid sample indices and missing bootstrap parents", () => {
  const mutations: ((s: EfaState) => void)[] = [
    (s) => {
      s.imputationRuns![0].result.missingPositions[0] = -1;
    },
    (s) => {
      s.imputationRuns![0].result.fits[1].imputation = 0;
    },
    (s) => {
      s.imputationRuns![0].result.fits[0].replacements[0] = 999;
    },
    (s) => {
      s.stabilityRuns![0].result.samples[0][0] = table.nRows;
    },
    (s) => {
      s.stabilityRuns![0].runId = "absent";
    },
    (s) => {
      s.stabilityRuns![0].result.completed = 99;
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(workspace);
    mutate(changed.datasets[0].efa);
    expect(() => validateWorkspace(changed)).toThrow(/EFA/);
  }
});
function harness<T>(result: T) {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  const job: EfaJob<T> = {
    id: "extension-job",
    status: "running",
    progress: { stage: "test", completed: 0, total: 1 },
    promise,
    cancel: () => {
      job.status = "cancelled";
    },
  };
  let context: EfaContext = {
    datasetId: 1,
    table,
    eligibleRows: rows,
    state: { runs: [run], splits: [] },
    privateMode: true,
    afterFullExploration: false,
    filterKey: "all",
  };
  const service = new EfaService(),
    controller = new EfaController(service, () => ({
      context: () => context,
      state: (_id, _table, update) =>
        (context = { ...context, state: update(context.state) }),
      scores: () => {
        throw new Error("No automatic scores");
      },
    }));
  vi.spyOn(service, "cancelAll").mockImplementation(() => job.cancel());
  return {
    controller,
    service,
    job,
    resolve: () => resolve(result),
    get: () => context,
    set: (patch: Partial<EfaContext>) => (context = { ...context, ...patch }),
  };
}
it("saves immutable imputation specs and rejects late results after filter changes or undo", async () => {
  const good = harness(imputation);
  vi.spyOn(good.service, "impute").mockReturnValue(
    good.job as EfaJob<ImputationAnalysis>,
  );
  const candidate = structuredClone(spec),
    pending = good.controller.impute(candidate, options);
  candidate.label = "changed while running";
  good.resolve();
  await pending;
  expect(good.get().state.imputationRuns![0].spec.label).toBe(spec.label);
  expect(good.get().state.runs).toHaveLength(1);
  for (const undo of [false, true]) {
    const h = harness(imputation);
    vi.spyOn(h.service, "impute").mockReturnValue(
      h.job as EfaJob<ImputationAnalysis>,
    );
    const pending = h.controller.impute(spec, options);
    if (undo) h.controller.cancel();
    else h.set({ filterKey: "changed" });
    h.resolve();
    await expect(pending).rejects.toThrow(/not published/);
    expect(h.get().state.imputationRuns).toBeUndefined();
  }
});
it("resampling respects the current filter and freezes group membership before publication", async () => {
  const h = harness(stability),
    spy = vi
      .spyOn(h.service, "stability")
      .mockReturnValue(h.job as EfaJob<StabilityResult>);
  h.set({ eligibleRows: rows.slice(1) });
  await expect(
    h.controller.stability(run.id, stabilityOptions),
  ).rejects.toThrow(/filter/);
  expect(spy).not.toHaveBeenCalled();
  h.set({ eligibleRows: rows });
  const pending = h.controller.stability(run.id, stabilityOptions);
  h.resolve();
  await pending;
  expect(h.get().state.stabilityRuns![0].runId).toBe(run.id);
  expect(h.get().state.stabilityRuns![0].result.samples).toEqual(
    stability.samples,
  );
});
