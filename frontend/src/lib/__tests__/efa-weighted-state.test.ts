import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { prepareEfa } from "../efa/prepare";
import { correlate } from "../efa/correlation";
import { fitEfa, scoreEfa } from "../efa/fit";
import { validateWorkspace } from "../workspaces";
import { serializeEfaCsv } from "../efa/state";
import { bootstrapStability } from "../efa/stability";
import {
  fitImputationChain,
  summarizeImputations,
} from "../efa/imputation-analysis";
import type { MiceOptions } from "../efa/mice";
import type { EfaSpec, EfaRun } from "../efa/types";
import type { DataTable } from "../table";

const table = JSON.parse(
    readFileSync(
      new URL("./fixtures/efa-weighted/pairwise.input.json", import.meta.url),
      "utf8",
    ),
  ) as DataTable & { categories: number[][]; reverse: number[] },
  rows = Array.from({ length: table.nRows }, (_, i) => i),
  spec: EfaSpec = {
    items: table.columns.map((column, i) => ({
      column,
      categories: table.categories[i],
      reverse: table.reverse.includes(i),
    })),
    extraction: "wlsmv",
    nFactors: 2,
    rotation: "oblimin",
    missing: "pairwise",
    seed: 73021,
    label: "weighted",
    sample: { partition: "all" },
  },
  prepared = prepareEfa(table, spec, rows),
  correlation = correlate(prepared),
  result = fitEfa(prepared, correlation, spec),
  run: EfaRun = {
    id: "weighted",
    revision: 1,
    createdAt: "2026-10-31",
    datasetRevision: "synthetic",
    spec,
    result,
    eligibleRows: rows,
    kind: "fit",
    reviews: {},
    reasons: "qualification",
    revisedAfterHoldout: false,
    scoreColumns: [],
  },
  workspace = {
    version: 2,
    tables: { t0: table },
    datasets: [
      {
        id: 1,
        name: "weighted",
        table: "t0",
        efa: { runs: [run], splits: [] },
      },
    ],
  };

it("keeps DWLS point fitting and completed WLSMV uncertainty distinct", () => {
  const dwls = fitEfa(prepared, correlation, { ...spec, extraction: "dwls" });
  expect(dwls.weighted?.estimator).toBe("dwls");
  expect(dwls.weighted?.robust).toBeUndefined();
  expect(result.weighted?.estimator).toBe("wlsmv");
  expect(result.weighted?.robust?.test.df).toBe(13);
  expect(result.extraction.loadings).toEqual(dwls.extraction.loadings);
  expect(result.extraction.estimator).toBe("dwls");
  expect(() =>
    fitEfa(
      prepared,
      correlation,
      { ...spec, extraction: "minres" },
      undefined,
      result.extraction,
    ),
  ).toThrow(/original point estimator/);
});
it("reuses the same weighted extraction when comparing rotations", () => {
  const rotation = fitEfa(
    prepared,
    correlation,
    { ...spec, rotation: "promax" },
    undefined,
    result.extraction,
  );
  expect(rotation.extraction).toBe(result.extraction);
  expect(rotation.weighted?.robust?.test).toEqual(
    result.weighted?.robust?.test,
  );
  expect(rotation.weighted?.robust?.standardErrors.pattern).not.toEqual(
    result.weighted?.robust?.standardErrors.pattern,
  );
});
it("scores original eligible rows only when their selected responses are complete", () => {
  const eligible = rows.filter((i) => i % 2 === 0),
    data = prepareEfa(table, spec, eligible),
    fit = fitEfa(data, correlate(data), { ...spec, extraction: "dwls" }),
    scores = scoreEfa(data, fit);
  for (let row = 0; row < table.nRows; row++) {
    const complete =
      eligible.includes(row) &&
      spec.items.every((item) => table.data[item.column][row] != null);
    expect(
      scores[row].every((v) =>
        complete ? typeof v === "number" && Number.isFinite(v) : v === null,
      ),
    ).toBe(true);
  }
});
it("round-trips weighted runs and exports their estimator and robust SEs", () => {
  const restored = JSON.parse(JSON.stringify(workspace));
  expect(() => validateWorkspace(restored)).not.toThrow();
  expect(restored.datasets[0].efa.runs[0].result.weighted).toEqual(
    result.weighted,
  );
  const csv = serializeEfaCsv(run);
  expect(csv).toContain("pattern_SE_F1");
  expect(csv).toContain("structure_SE_F2");
  expect(csv).toContain("uniqueness_SE");
  expect(csv).toContain(",wlsmv,");
});
it("rejects missing, inconsistent, or malformed weighted metadata before rendering", () => {
  for (const mutate of [
    (r: EfaRun) => {
      delete r.result.weighted;
    },
    (r: EfaRun) => {
      delete r.result.weighted!.robust;
    },
    (r: EfaRun) => {
      r.result.weighted!.samplingVariances[0] = 0;
    },
    (r: EfaRun) => {
      r.result.weighted!.robust!.standardErrors.pattern[0][0] = -1;
    },
    (r: EfaRun) => {
      r.result.weighted!.robust!.test.denominator = 1;
    },
    (r: EfaRun) => {
      r.result.weighted!.robust!.plan.budgetBytes = Infinity;
    },
    (r: EfaRun) => {
      r.spec.extraction = "minres";
    },
  ]) {
    const damaged = structuredClone(workspace);
    mutate(damaged.datasets[0].efa.runs[0]);
    expect(() => validateWorkspace(damaged)).toThrow(/EFA/);
  }
});
it("labels WLSMV resampling as DWLS point refits without per-replicate tests", () => {
  const stability = bootstrapStability(prepared, spec, result, {
    replicates: 2,
    seed: 1389,
    confidence: 0.95,
    crossLoadingThreshold: 0.3,
  });
  expect(stability.completed).toBe(2);
  expect(stability.provenance?.extraction).toContain(
    "DWLS point refits of a WLSMV baseline",
  );
});
it("retains separate within-imputation robust fits without claiming Rubin pooling", () => {
  const input = JSON.parse(
      readFileSync(
        new URL(
          "./fixtures/efa-extensions/mice-chain.reference.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      table: DataTable & { categories: number[][] };
      options: MiceOptions;
    },
    miSpec: EfaSpec = {
      ...spec,
      items: input.table.columns.map((column, i) => ({
        column,
        categories: input.table.categories[i],
        reverse: false,
      })),
      nFactors: 1,
    },
    data = prepareEfa(
      input.table,
      miSpec,
      Array.from({ length: input.table.nRows }, (_, i) => i),
    ),
    before = data.codes.slice(),
    options = { ...input.options, iterations: 1 },
    chains = [0, 1].map((i) => fitImputationChain(data, miSpec, options, i)),
    analysis = summarizeImputations(data, options, chains, "wlsmv");
  expect(analysis.completed).toBe(2);
  expect(data.codes).toEqual(before);
  expect(analysis.fits.every((f) => !!f.result.weighted?.robust)).toBe(true);
  expect(analysis.provenance.uncertainty).toContain("no Rubin-pooled");
  expect(analysis.provenance.method).toContain("WLSMV");
});

it("round-trips backend provenance and refuses incomplete self-checks or saved pairing credentials", () => {
  const saved = structuredClone(workspace), r = saved.datasets[0].efa.runs[0];
  r.spec.compute = { backend: "webgpu", blockSize: 256, memoryMiB: 1536 };
  r.result.provenance.execution = { backend: "webgpu", state: "completed", precision: "portable split-f32 / host-f64", kernelVersion: "ordinal-trace/1", kernelSha256: "a".repeat(64), blockSize: 256, budgetBytes: 1536 * 1024 ** 2,
    selfCheck: { version: "ordinal-trace/1", passed: true, checks: 5000, tolerance: 1e-10, maxScaledError: 1e-13, elapsedMs: 75 } };
  r.result.weighted!.robust!.plan.blockSize = 256;
  r.result.weighted!.robust!.plan.budgetBytes = 1536 * 1024 ** 2;
  r.result.provenance.execution.reusedFromJobId = "11111111-2222-4333-8444-555555555555";
  expect(() => validateWorkspace(JSON.parse(JSON.stringify(saved)))).not.toThrow();
  for (const mutate of [
    (r: EfaRun) => { r.result.provenance.execution!.selfCheck!.passed = false; },
    (r: EfaRun) => { r.result.provenance.execution!.selfCheck!.tolerance = 1e-8; },
    (r: EfaRun) => { r.result.provenance.execution!.selfCheck!.maxScaledError = NaN; },
    (r: EfaRun) => { r.result.provenance.execution!.state = "failed"; },
    (r: EfaRun) => { r.result.provenance.execution!.reusedFromJobId = "private item name"; },
    (r: EfaRun) => { Object.assign(r.result.provenance.execution!, { token: "secret" }); },
    (r: EfaRun) => { Object.assign(r.spec.compute!, { url: "http://127.0.0.1:8787" }); },
    (r: EfaRun) => { delete r.result.provenance.execution; },
    (r: EfaRun) => { r.result.weighted!.robust!.plan.blockSize = 257; },
    (r: EfaRun) => { r.result.weighted!.robust!.plan.budgetBytes = 4097 * 1024 ** 2; },
  ]) {
    const damaged = structuredClone(saved); mutate(damaged.datasets[0].efa.runs[0]);
    expect(() => validateWorkspace(damaged)).toThrow(/EFA/);
  }
});
