import type { DataTable } from "../table";
import { assembleCorrelations } from "./correlation";
import { summarizeParallel, validateReplicates } from "./parallel";
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
import { validateMiceOptions, type MiceOptions } from "./mice";
import {
  summarizeImputations,
  imputationWorkingSet,
  type ImputationAnalysis,
  type ImputationChainResult,
} from "./imputation-analysis";
import {
  summarizeStability,
  validateStability,
  type StabilityOptions,
  type StabilityResult,
  type StabilityReplicate,
} from "./stability";

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
  ) {
    this.concurrency = Math.max(
      1,
      Math.min(
        4,
        typeof navigator === "undefined"
          ? 4
          : navigator.hardwareConcurrency || 1,
        Math.floor(concurrency) || 1,
      ),
    );
  }
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
  private async batches<T>(
    workers: WorkerClient[],
    first: WorkerClient,
    data: EfaPreparedData,
    count: number,
    request: (index: number) => Request,
    label: string,
    progress: (p: EfaProgress) => void,
    live: () => boolean,
    workerLimit = this.concurrency,
  ): Promise<T[]> {
    const clients = [first],
      results: T[] = Array(count);
    for (let i = 1; i < Math.min(workerLimit, count); i++) {
      if (!live()) throw new EfaError("cancelled", "Analysis cancelled.");
      const client = this.client(workers);
      await client.request({ op: "initialize", data });
      clients.push(client);
    }
    let next = 0,
      completed = 0;
    await Promise.all(
      clients.map(async (client) => {
        while (next < count && live()) {
          const index = next++;
          let reported = 0;
          results[index] = await client.request<T>(request(index), (p) => {
            const now = performance.now();
            if (now - reported > 250 || p.completed === p.total) {
              reported = now;
              progress({
                stage: `${label} ${index + 1}: ${p.stage} (${p.completed}/${p.total})`,
                completed,
                total: count,
              });
            }
          });
          progress({ stage: label, completed: ++completed, total: count });
        }
      }),
    );
    if (!live()) throw new EfaError("cancelled", "Analysis cancelled.");
    return results;
  }
  impute(
    table: DataTable,
    spec: EfaSpec,
    rows: number[],
    options: MiceOptions,
  ): EfaJob<ImputationAnalysis> {
    const snapshot = structuredClone(spec),
      membership = rows.slice(),
      settings = structuredClone(options);
    validateMiceOptions(settings, snapshot.items.length);
    if (snapshot.missing !== "pairwise")
      throw new EfaError(
        "mice-population",
        "MICE keeps incomplete respondents. Choose the pairwise/eligible population before starting imputation; complete-case deletion would remove its targets.",
      );
    return this.launch(async (workers, progress, live) => {
      const first = this.client(workers),
        data = await first.request<EfaPreparedData>({
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
      const estimatedBytes = imputationWorkingSet(data, settings),
        workerLimit = Math.min(
          this.concurrency,
          settings.imputations,
          Math.max(1, Math.floor(1024 ** 3 / Math.max(1, estimatedBytes))),
        );
      const results = await this.batches<ImputationChainResult>(
        workers,
        first,
        data,
        settings.imputations,
        (index) => ({
          op: "imputation",
          spec: snapshot,
          options: settings,
          index,
        }),
        "MICE imputation",
        progress,
        live,
        workerLimit,
      );
      const analysis = summarizeImputations(data, settings, results);
      analysis.provenance.execution = {
        workers: workerLimit,
        estimatedWorkingSetBytesPerWorker: estimatedBytes,
        note: "Concurrency reduced for expanded predictor designs using an approximate 1 GiB combined working-set budget, with at least one worker. This is a scheduling estimate, not measured peak memory or a cap on a single model.",
      };
      return analysis;
    });
  }
  stability(
    table: DataTable,
    run: EfaRun,
    options: StabilityOptions,
  ): EfaJob<StabilityResult> {
    const spec = structuredClone(run.spec),
      membership = run.result.fittingRows.slice(),
      reference = structuredClone({ rotation: run.result.rotation }),
      settings = structuredClone(options),
      fingerprint = run.result.provenance.inputSha256;
    validateStability(settings);
    return this.launch(async (workers, progress, live) => {
      const first = this.client(workers),
        data = await first.request<EfaPreparedData>({
          op: "prepare",
          table: {
            columns: spec.items.map((x) => x.column),
            data: Object.fromEntries(
              spec.items.map((x) => [x.column, table.data[x.column]]),
            ),
            nRows: table.nRows,
          },
          spec,
          rows: membership,
        });
      if (!fingerprint || fingerprint !== data.fingerprint)
        throw new EfaError(
          "changed-data",
          "The fitted responses changed. Refit before evaluating resampling stability.",
        );
      const results = await this.batches<StabilityReplicate>(
        workers,
        first,
        data,
        settings.replicates,
        (index) => ({
          op: "stability",
          spec,
          reference,
          options: settings,
          index,
        }),
        "Stability replicate",
        progress,
        live,
      );
      return summarizeStability(
        reference,
        results.flatMap((r) => (r.replica ? [r.replica] : [])),
        results.flatMap((r) => (r.failure ? [r.failure] : [])),
        results.map((r) => r.indices),
        settings,
        data.fingerprint,
      );
    });
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
    validateReplicates(replicates, spec.seed);
    const snapshot = structuredClone(spec),
      membership = rows.slice();
    return this.launch(async (workers, progress, live) => {
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
      const observed = await worker.request<number[]>(
        { op: "parallel-observed", minimumPairN },
        progress,
      );
      const clients = [worker];
      for (let i = 1; i < Math.min(this.concurrency, replicates); i++) {
        const next = this.client(workers);
        await next.request({ op: "initialize", data });
        clients.push(next);
      }
      let next = 0,
        completed = 0;
      const results: (number[] | undefined)[] = Array(replicates);
      const failures: ParallelResult["failures"] = [];
      progress({ stage: "Parallel analysis", completed: 0, total: replicates });
      await Promise.all(
        clients.map(async (client) => {
          while (next < replicates && live()) {
            const index = next++;
            let reported = 0;
            try {
              results[index] = await client.request<number[]>(
                { op: "parallel-replicate", seed: snapshot.seed + index },
                (p) => {
                  const now = performance.now();
                  if (now - reported > 250 || p.completed === p.total) {
                    reported = now;
                    progress({
                      stage: `Parallel analysis · replicate ${index + 1}: ${p.stage} (${p.completed}/${p.total}) · ${failures.length} failed`,
                      completed,
                      total: replicates,
                    });
                  }
                },
              );
            } catch (error) {
              if (!live()) throw error;
              failures.push({
                replicate: index,
                error: error instanceof Error ? error.message : String(error),
              });
            }
            progress({
              stage: `Parallel analysis · ${failures.length} failed`,
              completed: ++completed,
              total: replicates,
            });
          }
        }),
      );
      if (!live()) throw new EfaError("cancelled", "Analysis cancelled.");
      return summarizeParallel(
        observed,
        results.filter((x): x is number[] => !!x),
        failures.sort((a, b) => a.replicate - b.replicate),
        snapshot.seed,
        replicates,
        data.fingerprint,
      );
    });
  }
}
