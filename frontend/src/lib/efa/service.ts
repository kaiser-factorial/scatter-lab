import type { DataTable } from "../table";
import { assembleCorrelations } from "./correlation";
import {
  EfaError,
  type EfaSpec,
  type EfaPreparedData,
  type EfaResult,
  type EfaCorrelations,
  type EfaProgress,
  type PairEstimate,
  type EfaRun,
  type ParallelResult,
  type EfaExtraction,
} from "./types";
import type { WorkerRequest } from "./efa.worker";

type Request = WorkerRequest extends infer T
  ? T extends WorkerRequest
    ? Omit<T, "id">
    : never
  : never;
export type EfaJobStatus = "running" | "completed" | "failed" | "cancelled";
export interface EfaJob<T = unknown> {
  id: string;
  status: EfaJobStatus;
  progress: EfaProgress;
  error?: string;
  result?: T;
  promise: Promise<T>;
  cancel: () => void;
}
type CacheEntry = {
  key: string;
  data: EfaPreparedData;
  correlation: EfaCorrelations;
};
class WorkerClient {
  worker: Worker;
  counter = 0;
  pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      progress: (value: EfaProgress) => void;
    }
  >();
  constructor(factory: () => Worker) {
    this.worker = factory();
    this.worker.onmessage = (event) => {
      const { id, progress, error, value } = event.data;
      const p = this.pending.get(id);
      if (!p) return;
      if (progress) {
        p.progress(progress);
        return;
      }
      this.pending.delete(id);
      if (error)
        p.reject(new EfaError(error.code, error.message, error.diagnostics));
      else p.resolve(value);
    };
    this.worker.onerror = (event) => {
      for (const p of this.pending.values())
        p.reject(new Error(event.message || "Worker failed."));
      this.pending.clear();
    };
  }
  request<T>(
    request: Request,
    progress: (value: EfaProgress) => void = () => {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = ++this.counter;
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        progress,
      });
      this.worker.postMessage({ ...request, id });
    });
  }
  terminate() {
    this.worker.terminate();
    for (const p of this.pending.values())
      p.reject(new EfaError("cancelled", "Analysis cancelled."));
    this.pending.clear();
  }
}

/** UI and assistant use the same jobs. Publishing results is the caller's
 * transaction: a completed numerical job never mutates a dataset itself. */
export class EfaService {
  private jobs = new Map<string, EfaJob>();
  private listeners = new Set<() => void>();
  private cache = new WeakMap<DataTable, CacheEntry[]>();
  private revisionIds = new WeakMap<DataTable, string>();
  constructor(
    private workerFactory = () =>
      new Worker(new URL("./efa.worker.ts", import.meta.url)),
    private concurrency = Math.max(
      1,
      Math.min(
        4,
        typeof navigator === "undefined"
          ? 1
          : navigator.hardwareConcurrency || 1,
      ),
    ),
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit() {
    this.listeners.forEach((fn) => fn());
  }
  getJob(id: string) {
    return this.jobs.get(id);
  }
  listJobs() {
    return [...this.jobs.values()];
  }
  revision(table: DataTable) {
    let id = this.revisionIds.get(table);
    if (!id) {
      id = crypto.randomUUID();
      this.revisionIds.set(table, id);
    }
    return id;
  }
  cancelAll() {
    for (const job of this.jobs.values())
      if (job.status === "running") job.cancel();
  }
  private launch<T>(
    task: (
      workers: WorkerClient[],
      progress: (p: EfaProgress) => void,
      live: () => boolean,
    ) => Promise<T>,
  ): EfaJob<T> {
    // One analysis at a time bounds total workers and resident snapshots.
    this.cancelAll();
    const workers: WorkerClient[] = [],
      id = crypto.randomUUID();
    const job: EfaJob<T> = {
      id,
      status: "running",
      progress: { stage: "Preparing", completed: 0, total: 1 },
      promise: Promise.resolve(undefined as T),
      cancel: () => {
        if (job.status !== "running") return;
        job.status = "cancelled";
        workers.forEach((w) => w.terminate());
        this.emit();
      },
    };
    this.jobs.set(id, job);
    this.emit();
    const progress = (p: EfaProgress) => {
      if (job.status === "running") {
        job.progress = p;
        this.emit();
      }
    };
    job.promise = task(workers, progress, () => job.status === "running")
      .then((result) => {
        if (job.status !== "running")
          throw new EfaError("cancelled", "Analysis cancelled.");
        job.result = result;
        job.status = "completed";
        job.progress = { stage: "Completed", completed: 1, total: 1 };
        return result;
      })
      .catch((error) => {
        if (job.status !== "cancelled") {
          job.status = "failed";
          job.error = error instanceof Error ? error.message : String(error);
        }
        throw error;
      })
      .finally(() => {
        workers.forEach((w) => w.terminate());
        this.emit();
      });
    // Job-id callers may poll later; avoid an unhandled rejection in the meantime.
    void job.promise.catch(() => {});
    for (const [key, value] of this.jobs)
      if (this.jobs.size > 20 && value.status !== "running" && key !== id)
        this.jobs.delete(key);
    return job;
  }
  private client(workers: WorkerClient[]) {
    const client = new WorkerClient(this.workerFactory);
    workers.push(client);
    return client;
  }
  preview(
    table: DataTable,
    spec: EfaSpec,
    rows: number[],
  ): EfaJob<{ nRows: number; counts: number[][] }> {
    const snapshot = structuredClone(spec),
      membership = rows.slice();
    return this.launch(async (workers) => {
      const worker = this.client(workers);
      const data = await worker.request<EfaPreparedData>({
        op: "prepare",
        table: {
          columns: snapshot.items.map((x) => x.column),
          data: Object.fromEntries(
            snapshot.items.map((x) => [x.column, table.data[x.column]]),
          ),
          nRows: table.nRows,
        },
        spec: snapshot,
        rows: membership,
      });
      return { nRows: data.nRows, counts: data.counts };
    });
  }
  fit(
    table: DataTable,
    spec: EfaSpec,
    rows: number[],
    reuse?: EfaRun,
    minimumPairN = 0,
  ): EfaJob<EfaResult> {
    const snapshot = structuredClone(spec),
      membership = rows.slice();
    const key = JSON.stringify({
      items: snapshot.items,
      missing: snapshot.missing,
      rows: membership,
    });
    // Only selected columns are cloned into the preparation worker. Source arrays
    // are immutable in the app; postMessage captures their values synchronously.
    const selected: DataTable = {
      columns: snapshot.items.map((x) => x.column),
      data: Object.fromEntries(
        snapshot.items.map((x) => [x.column, table.data[x.column]]),
      ),
      nRows: table.nRows,
    };
    return this.launch(async (workers, progress, live) => {
      const first = this.client(workers),
        entries = this.cache.get(table) ?? [],
        cached = entries.find((e) => e.key === key);
      const data = cached
        ? cached.data
        : await first.request<EfaPreparedData>({
            op: "prepare",
            table: selected,
            spec: snapshot,
            rows: membership,
          });
      if (cached) await first.request({ op: "initialize", data });
      let correlation = cached?.correlation;
      if (!correlation) {
        const subset = entries.find(
          (entry) =>
            JSON.stringify(entry.data.rows) === JSON.stringify(data.rows) &&
            data.items.every((item) =>
              entry.data.items.some(
                (previous) => JSON.stringify(previous) === JSON.stringify(item),
              ),
            ),
        );
        if (subset) {
          const oldIndices = data.items.map((item) =>
              subset.data.items.findIndex(
                (previous) => JSON.stringify(previous) === JSON.stringify(item),
              ),
            ),
            newIndices = new Map(oldIndices.map((v, i) => [v, i]));
          const pairs: PairEstimate[] = [];
          for (const pair of subset.correlation.pairs) {
            const a = newIndices.get(pair.i),
              b = newIndices.get(pair.j);
            if (a === undefined || b === undefined) continue;
            pairs.push(
              a < b
                ? { ...pair, i: a, j: b }
                : {
                    ...pair,
                    i: b,
                    j: a,
                    thresholdsX: pair.thresholdsY,
                    thresholdsY: pair.thresholdsX,
                    observedCategoriesX: pair.observedCategoriesY,
                    observedCategoriesY: pair.observedCategoriesX,
                  },
            );
          }
          correlation = assembleCorrelations(
            data,
            pairs.sort((a, b) => a.i - b.i || a.j - b.j),
          );
          progress({
            stage: "Reused unchanged item pairs",
            completed: pairs.length,
            total: pairs.length,
          });
        }
      }
      if (!correlation) {
        const pairs: [number, number][] = [];
        for (let i = 0; i < data.items.length - 1; i++)
          for (let j = i + 1; j < data.items.length; j++) pairs.push([i, j]);
        const clients = [first];
        for (
          let n = 1;
          n < Math.min(this.concurrency, Math.ceil(pairs.length / 64));
          n++
        ) {
          const worker = this.client(workers);
          await worker.request({ op: "initialize", data });
          clients.push(worker);
        }
        let next = 0,
          done = 0;
        const estimates: PairEstimate[] = [];
        await Promise.all(
          clients.map(async (client) => {
            while (next < pairs.length && live()) {
              const batch = pairs.slice(next, next + 64);
              next += batch.length;
              const result = await client.request<PairEstimate[]>({
                op: "pairs",
                pairs: batch,
              });
              estimates.push(...result);
              done += result.length;
              progress({
                stage: "Correlations",
                completed: done,
                total: pairs.length,
              });
            }
          }),
        );
        if (!live()) throw new EfaError("cancelled", "Analysis cancelled.");
        estimates.sort((a, b) => a.i - b.i || a.j - b.j);
        correlation = assembleCorrelations(data, estimates);
        this.cache.set(
          table,
          [
            { key, data, correlation },
            ...entries.filter((e) => e.key !== key),
          ].slice(0, 2),
        );
      }
      if (!cached)
        this.cache.set(
          table,
          [
            { key, data, correlation },
            ...entries.filter((e) => e.key !== key),
          ].slice(0, 2),
        );
      let extraction: EfaExtraction | undefined;
      if (
        data.rows.length < minimumPairN ||
        correlation.pairs.some((pair) => pair.n < minimumPairN)
      )
        throw new EfaError(
          "privacy",
          "This fit includes item pairs below the private aggregate floor. Widen the sample or revise the selected items.",
        );
      if (
        reuse &&
        data.fingerprint &&
        reuse.result.provenance.inputSha256 === data.fingerprint &&
        reuse.spec.nFactors === snapshot.nFactors &&
        JSON.stringify({
          items: reuse.spec.items,
          missing: reuse.spec.missing,
          rows: reuse.eligibleRows,
        }) === key
      )
        extraction = reuse.result.extraction;
      if (reuse && !extraction)
        throw new EfaError(
          "rotation",
          "The fitted inputs changed. Create a refit before comparing rotations.",
        );
      return first.request<EfaResult>(
        { op: "fit", correlation, spec: snapshot, extraction },
        progress,
      );
    });
  }
  scores(table: DataTable, run: EfaRun): EfaJob<(number | null)[][]> {
    const spec = structuredClone(run.spec),
      rows = run.result.fittingRows.slice(),
      result = run.result;
    return this.launch(async (workers) => {
      const worker = this.client(workers);
      await worker.request({
        op: "prepare",
        table: {
          columns: spec.items.map((x) => x.column),
          data: Object.fromEntries(
            spec.items.map((x) => [x.column, table.data[x.column]]),
          ),
          nRows: table.nRows,
        },
        spec,
        rows,
      });
      return worker.request({ op: "score", result });
    });
  }
  parallel(
    table: DataTable,
    spec: EfaSpec,
    rows: number[],
    replicates = 100,
    minimumPairN = 0,
  ): EfaJob<ParallelResult> {
    const snapshot = structuredClone(spec),
      membership = rows.slice();
    return this.launch(async (workers, progress) => {
      const worker = this.client(workers);
      await worker.request({
        op: "prepare",
        table: {
          columns: snapshot.items.map((x) => x.column),
          data: Object.fromEntries(
            snapshot.items.map((x) => [x.column, table.data[x.column]]),
          ),
          nRows: table.nRows,
        },
        spec: snapshot,
        rows: membership,
      });
      return worker.request(
        { op: "parallel", seed: snapshot.seed, replicates, minimumPairN },
        progress,
      );
    });
  }
}
