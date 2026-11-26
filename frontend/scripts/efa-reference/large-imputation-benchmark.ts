import { EfaService } from "../../src/lib/efa/service";
import { mulberry32 } from "../../src/lib/random";
import { benchmarkData } from "./benchmark-data";

const service = new EfaService(
  () => new Worker(new URL("worker.js", import.meta.url)),
  2,
);
const output = document.querySelector("#output")!,
  stage = document.querySelector("#stage")!;
let heartbeats = 0,
  previous = performance.now(),
  maxHeartbeatGapMs = 0;
setInterval(() => {
  const now = performance.now();
  maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, now - previous);
  previous = now;
  document.querySelector("#heartbeat")!.textContent = String(++heartbeats);
}, 100);
service.subscribe(() => {
  const job = service.listJobs().at(-1);
  if (job)
    stage.textContent = JSON.stringify({
      id: job.id,
      status: job.status,
      ...job.progress,
    });
});
document.querySelector<HTMLButtonElement>("#cancel")!.onclick = () => {
  const start = performance.now();
  service.cancelAll();
  document.querySelector("#cancelTime")!.textContent = String(
    performance.now() - start,
  );
};
const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
document.querySelector<HTMLButtonElement>("#run")!.onclick = async () => {
  output.textContent = "running";
  try {
    const { table, spec } = benchmarkData(),
      n = table.nRows,
      p = table.columns.length,
      random = mulberry32(73291),
      snapshot = new Uint8Array(n * p);
    let missing = 0;
    for (let j = 0; j < p; j++)
      for (let i = 0; i < n; i++) {
        if (random() < 0.05) {
          table.data[table.columns[j]][i] = null;
          missing++;
        }
        snapshot[j * n + i] = Number(table.data[table.columns[j]][i] ?? 0);
      }
    const options = {
      imputations: 2,
      iterations: 1,
      seed: 54091,
      predictorEncoding: "ordered-polynomial" as const,
      // Same synthetic factor block, four prespecified observed items per target.
      predictors: Array.from({ length: p }, (_, j) =>
        [5, 10, 15, 20].map((offset) => (j + offset) % p),
      ),
    };
    previous = performance.now();
    maxHeartbeatGapMs = 0;
    const start = performance.now(),
      result = await service.impute(
        table,
        { ...spec, label: "Full-size sparse-predictor MICE execution check" },
        Array.from({ length: n }, (_, i) => i),
        options,
      ).promise,
      elapsedMs = performance.now() - start;
    assert(
      result.completed === 2 && result.failures.length === 0,
      `Both completed-data fits must succeed: ${JSON.stringify(result.failures)}`,
    );
    assert(
      result.missingPositions.length === missing,
      "Missing positions changed.",
    );
    assert(
      result.trace.length === 2 * p,
      "Conditional trace entries were lost.",
    );
    const hashes = result.fits.map((fit) => fit.result.provenance.inputSha256);
    assert(
      new Set(hashes).size === 2 &&
        hashes.every((h) => h && h !== result.provenance.inputSha256),
      "Completed datasets need separate response fingerprints.",
    );
    for (let j = 0; j < p; j++)
      for (let i = 0; i < n; i++)
        assert(
          Number(table.data[table.columns[j]][i] ?? 0) === snapshot[j * n + i],
          "The source response snapshot changed.",
        );
    assert(
      result.fits.every(
        (fit) =>
          fit.replacements.length === missing &&
          fit.replacements.every((v) => Number.isInteger(v) && v >= 0 && v < 5),
      ),
      "Invalid completed-response replacements.",
    );
    output.textContent = JSON.stringify({
      status: "passed",
      recordedAt: new Date().toISOString(),
      browser: navigator.userAgent,
      dimensions: {
        items: p,
        respondents: n,
        missingCells: missing,
        factors: spec.nFactors,
      },
      dataSeed: 8801,
      missingnessSeed: 73291,
      options,
      elapsedMs,
      heartbeats,
      maxHeartbeatGapMs,
      requested: result.requested,
      completed: result.completed,
      traceEntries: result.trace.length,
      failures: result.failures,
      provenance: result.provenance,
      fits: result.fits.map((fit) => ({
        imputation: fit.imputation,
        inputSha256: fit.result.provenance.inputSha256,
        convergence: fit.result.extraction.convergence,
        rmsr: fit.result.rmsr,
      })),
      qualification:
        "Execution and source-preservation check with four prespecified predictors per item and one sweep. One sweep is not a chain-convergence claim. This does not qualify all-499-predictor models, default 20-by-10 batches, or large-data statistical recovery; independent R method parity uses the saved smaller fixtures.",
    });
  } catch (error) {
    output.textContent = JSON.stringify({
      status:
        service.listJobs().at(-1)?.status === "cancelled"
          ? "cancelled"
          : "failed",
      error: String(error),
    });
  }
};
