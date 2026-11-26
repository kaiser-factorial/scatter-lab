import { EfaService } from "../../src/lib/efa/service";
import type { EfaRun, EfaSpec } from "../../src/lib/efa/types";
import type { DataTable } from "../../src/lib/table";
import imputationFixture from "../../src/lib/__tests__/fixtures/efa-extensions/mice-chain-polynomial.reference.json";
import stabilityFixtures from "../../src/lib/__tests__/fixtures/efa-extensions/stability.reference.json";
const service = new EfaService(
  () => new Worker(new URL("worker.js", import.meta.url)),
);
const output = document.querySelector("#output")!,
  stage = document.querySelector("#stage")!;
let heartbeats = 0,
  previous = performance.now(),
  maxGap = 0;
setInterval(() => {
  const now = performance.now();
  maxGap = Math.max(maxGap, now - previous);
  previous = now;
  document.querySelector("#heartbeat")!.textContent = String(++heartbeats);
}, 100);
service.subscribe(() => {
  const job = service.listJobs().at(-1);
  if (job)
    stage.textContent = JSON.stringify({ status: job.status, ...job.progress });
});
const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
document.querySelector<HTMLButtonElement>("#run")!.onclick = async () => {
  output.textContent = "running";
  const timings: Record<string, number> = {};
  try {
    const table = imputationFixture.table as DataTable & {
        categories: number[][];
      },
      before = JSON.stringify(table),
      rows = Array.from({ length: 300 }, (_, i) => i);
    const spec: EfaSpec = {
      items: table.columns.map((column, i) => ({
        column,
        categories: table.categories[i],
        reverse: false,
      })),
      missing: "pairwise",
      rotation: "oblimin",
      nFactors: 1,
      seed: 22031,
      label: "browser imputation qualification",
      sample: { partition: "all" },
    };
    const options = {
      ...imputationFixture.options,
      predictorEncoding: "ordered-polynomial" as const,
      imputations: 5,
      iterations: 10,
    };
    let start = performance.now();
    const result = await service.impute(table, spec, rows, options).promise;
    timings.imputation = performance.now() - start;
    assert(
      result.completed === 5 && result.failures.length === 0,
      `All five imputation fits must complete: ${JSON.stringify(result.failures)}`,
    );
    assert(
      result.fittingRows.length === 300 &&
        result.fits.every((f) => f.result.fittingRows.every((r) => r < 300)),
      "Imputation fitting membership escaped the selected population.",
    );
    assert(JSON.stringify(table) === before, "Source observations changed.");
    assert(
      result.fits.every(
        (f) => f.replacements.length === result.missingPositions.length,
      ),
      "Replacement positions do not match saved cells.",
    );
    const long = service.impute(table, spec, rows, {
      ...options,
      imputations: 100,
      iterations: 100,
    });
    await new Promise<void>((resolve) => {
      const stop = service.subscribe(() => {
        if (long.progress.stage.includes("MICE")) {
          stop();
          resolve();
        }
      });
    });
    const ticks = heartbeats;
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert(heartbeats > ticks, "UI heartbeat stalled during imputation.");
    start = performance.now();
    long.cancel();
    await long.promise.catch(() => {});
    timings.cancel = performance.now() - start;
    assert(
      long.status === "cancelled" &&
        long.result === undefined &&
        timings.cancel < 1000,
      "Cancelled imputation published or cancellation exceeded one second.",
    );
    const raw = stabilityFixtures.cases["heavy-tail"].table as DataTable & {
        categories: number[][];
      },
      members = Array.from({ length: raw.nRows }, (_, i) => i),
      stabilitySpec: EfaSpec = {
        ...spec,
        items: raw.columns.map((column, i) => ({
          column,
          categories: raw.categories[i],
          reverse: false,
        })),
        nFactors: 2,
      };
    const fitted = await service.fit(raw, stabilitySpec, members).promise;
    const run: EfaRun = {
      id: "browser-stability",
      revision: 1,
      createdAt: new Date().toISOString(),
      datasetRevision: service.revision(raw),
      spec: stabilitySpec,
      result: fitted,
      eligibleRows: members,
      kind: "fit",
      reviews: {},
      reasons: "Synthetic browser qualification",
      revisedAfterHoldout: false,
      scoreColumns: [],
    };
    start = performance.now();
    const stability = await service.stability(raw, run, {
      replicates: 100,
      seed: 50911,
      confidence: 0.95,
      crossLoadingThreshold: 0.3,
    }).promise;
    timings.bootstrap = performance.now() - start;
    assert(
      stability.completed + stability.failures.length === 100 &&
        stability.samples.length === 100,
      "Bootstrap lost requested replicates.",
    );
    assert(
      stability.completed === 100,
      "Heavy-tailed browser bootstrap has fit failures; qualification remains incomplete.",
    );
    const groups = members.map((i) => String(Math.floor(i / 5)));
    start = performance.now();
    const grouped = await service.stability(raw, run, {
      replicates: 20,
      seed: 731,
      confidence: 0.95,
      crossLoadingThreshold: 0.3,
      groups,
    }).promise;
    timings.groupBootstrap = performance.now() - start;
    assert(grouped.completed === 20, "Group bootstrap has fit failures.");
    for (const sample of grouped.samples) {
      const counts = Array(raw.nRows).fill(0);
      sample.forEach((i) => counts[i]++);
      for (let i = 0; i < raw.nRows; i += 5)
        assert(
          counts.slice(i, i + 5).every((v) => v === counts[i]),
          "A group was split during resampling.",
        );
    }
    output.textContent = JSON.stringify({
      status: "passed",
      recordedAt: new Date().toISOString(),
      browser: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      timingsMs: timings,
      heartbeats,
      maxHeartbeatGapMs: maxGap,
      imputation: {
        requested: result.requested,
        completed: result.completed,
        rows: result.fittingRows.length,
        traceEntries: result.trace.length,
        missingCells: result.missingPositions.length,
        failures: result.failures,
        provenance: result.provenance,
      },
      bootstrap: {
        requested: stability.requested,
        completed: stability.completed,
        failures: stability.failures,
      },
      groups: {
        requested: grouped.requested,
        completed: grouped.completed,
        failures: grouped.failures,
      },
    });
  } catch (error) {
    output.textContent = JSON.stringify({
      status: "failed",
      error: String(error),
      timingsMs: timings,
    });
  }
};
