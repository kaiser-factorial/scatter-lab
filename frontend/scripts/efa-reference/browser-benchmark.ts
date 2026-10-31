import { EfaService } from "../../src/lib/efa/service";
import { benchmarkData } from "./benchmark-data";
import type { EfaRun } from "../../src/lib/efa/types";
const output = document.querySelector("#output")!,
  stage = document.querySelector("#stage")!;
const service = new EfaService(
  () => new Worker(new URL("worker.js", import.meta.url)),
);
const stageTimings: { jobId: string; stage: string; milliseconds: number }[] =
  [];
let previousStage = "",
  previousJob = "",
  stageStarted = performance.now();
service.subscribe(() => {
  const job = service.listJobs().at(-1);
  if (!job) return;
  const name = job.progress.stage.split(" · ")[0];
  if (name !== previousStage || job.id !== previousJob) {
    const now = performance.now();
    if (previousStage)
      stageTimings.push({
        jobId: previousJob,
        stage: previousStage,
        milliseconds: now - stageStarted,
      });
    stageStarted = now;
    previousStage = name;
    previousJob = job.id;
  }
});
service.subscribe(() => {
  const job = service.listJobs().at(-1);
  if (job)
    stage.textContent = JSON.stringify({
      id: job.id,
      status: job.status,
      ...job.progress,
    });
});
let heartbeats = 0;
setInterval(() => {
  document.querySelector("#heartbeat")!.textContent = String(++heartbeats);
}, 100);
(document.querySelector("#cancel") as HTMLButtonElement).onclick = () => {
  const start = performance.now();
  service.cancelAll();
  document.querySelector("#cancelTime")!.textContent = String(
    performance.now() - start,
  );
};
(document.querySelector("#run") as HTMLButtonElement).onclick = async () => {
  output.textContent = "running";
  try {
    const { table, spec } = benchmarkData(),
      rows = Array.from({ length: table.nRows }, (_, i) => i),
      timings: Record<string, number> = {};
    let start = performance.now();
    const result = await service.fit(table, spec, rows).promise;
    timings.fit = performance.now() - start;
    const run: EfaRun = {
      id: "benchmark",
      revision: 1,
      createdAt: new Date().toISOString(),
      datasetRevision: service.revision(table),
      spec,
      result,
      eligibleRows: rows,
      kind: "fit",
      reviews: {},
      reasons: "",
      revisedAfterHoldout: false,
      scoreColumns: [],
    };
    (window as unknown as { efaLargeFixture: unknown }).efaLargeFixture = {
      table,
      run,
    };
    for (const rotation of ["promax", "varimax"] as const) {
      start = performance.now();
      await service.fit(table, { ...spec, rotation }, rows, run).promise;
      timings[rotation] = performance.now() - start;
    }
    start = performance.now();
    await service.scores(table, run).promise;
    timings.scores = performance.now() - start;
    start = performance.now();
    await service.fit(table, spec, rows.slice(14000)).promise;
    timings.holdout = performance.now() - start;
    output.textContent = JSON.stringify({
      status: "passed",
      recordedAt: new Date().toISOString(),
      dimensions: {
        items: spec.items.length,
        respondents: table.nRows,
        holdoutRespondents: 6000,
        nFactors: spec.nFactors,
      },
      seed: spec.seed,
      inputSha256: result.provenance.inputSha256,
      timingsMs: timings,
      stages: stageTimings,
      hardwareConcurrency: navigator.hardwareConcurrency,
      browser: navigator.userAgent,
      heartbeats,
      convergence: result.extraction.convergence,
    });
  } catch (error) {
    output.textContent = JSON.stringify({
      status: "failed",
      error: String(error),
    });
  }
};
