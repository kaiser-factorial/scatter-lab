import { EfaService } from "../../src/lib/efa/service";
import { benchmarkData } from "./benchmark-data";
import type { WorkerRequest } from "../../src/lib/efa/efa.worker";
const workerFailures: { seed?: number; code: string; message: string }[] = [];
const activeReplicates = new Map<
  number,
  {
    seed: number;
    startedAt: number;
    stage?: string;
    completed?: number;
    total?: number;
  }
>();
const replicateTimings: {
  seed: number;
  milliseconds: number;
  status: string;
}[] = [];
const service = new EfaService(() => {
  const worker = new Worker(new URL("worker.js", import.meta.url)),
    seeds = new Map<number, number>(),
    post = worker.postMessage.bind(worker);
  worker.postMessage = (message: WorkerRequest) => {
    if (message.op === "parallel-replicate") {
      seeds.set(message.id, message.seed);
      activeReplicates.set(message.seed, {
        seed: message.seed,
        startedAt: performance.now(),
      });
    }
    post(message);
  };
  worker.addEventListener("message", (event) => {
    const seed = seeds.get(event.data.id);
    if (seed !== undefined) {
      const active = activeReplicates.get(seed);
      if (active && event.data.progress)
        Object.assign(active, event.data.progress);
      else if (active) {
        replicateTimings.push({
          seed,
          milliseconds: performance.now() - active.startedAt,
          status: event.data.error ? "failed" : "completed",
        });
        activeReplicates.delete(seed);
        seeds.delete(event.data.id);
      }
    }
    if (event.data.error)
      workerFailures.push({
        seed,
        code: event.data.error.code,
        message: event.data.error.message,
      });
  });
  return worker;
});
let heartbeat = 0;
setInterval(
  () =>
    (document.querySelector("#heartbeat")!.textContent = String(++heartbeat)),
  100,
);
service.subscribe(() => {
  const job = service.listJobs().at(-1);
  if (job)
    document.querySelector("#stage")!.textContent = JSON.stringify({
      id: job.id,
      status: job.status,
      ...job.progress,
      workerFailures,
      activeReplicates: [...activeReplicates.values()].map((r) => ({
        ...r,
        elapsedMs: performance.now() - r.startedAt,
      })),
    });
});
document.querySelector<HTMLButtonElement>("#cancel")!.onclick = () => {
  const start = performance.now();
  service.cancelAll();
  document.querySelector("#cancelTime")!.textContent = String(
    performance.now() - start,
  );
};
document.querySelector<HTMLButtonElement>("#run")!.onclick = async () => {
  document.querySelector("#output")!.textContent = "running";
  workerFailures.length = 0;
  activeReplicates.clear();
  replicateTimings.length = 0;
  const params = new URLSearchParams(location.search),
    p = Number(params.get("items") ?? 500),
    n = Number(params.get("rows") ?? 20000),
    replicates = Number(params.get("replicates") ?? 100);
  const { table, spec } = benchmarkData(n, p),
    start = performance.now();
  try {
    const result = await service.parallel(
      table,
      spec,
      Array.from({ length: n }, (_, i) => i),
      replicates,
    ).promise;
    document.querySelector("#output")!.textContent = JSON.stringify({
      status: result.failures.length ? "completed-with-failures" : "passed",
      dimensions: { items: p, respondents: n },
      elapsedMs: performance.now() - start,
      heartbeat,
      browser: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      recordedAt: new Date().toISOString(),
      result,
      workerFailures,
      replicateTimings,
    });
  } catch (error) {
    document.querySelector("#output")!.textContent = JSON.stringify({
      status: "failed",
      elapsedMs: performance.now() - start,
      error: String(error),
      workerFailures,
      replicateTimings,
    });
  }
};
