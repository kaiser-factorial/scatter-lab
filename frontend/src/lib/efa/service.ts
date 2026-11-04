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
import { ComputeTrace, type ComputeReport } from "./telemetry";
import {
  planWeightedInference,
  type InferencePlan,
} from "./weighted-inference";
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
  trace: ComputeTrace;
}
type CacheEntry = {
  key: string;
  data: EfaPreparedData;
  correlation: EfaCorrelations;
};
class WorkerClient {
  worker: Worker;
  counter = 0;
  terminated = false;
  pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      progress: (value: EfaProgress) => void;
      op: string;
      started: number;
      postMessageMs: number;
    }
  >();
  constructor(factory: () => Worker, private trace: ComputeTrace, private index: number) {
    this.worker = factory();
    trace.worker(true, index);
    this.worker.onmessage = (event) => {
      const { id, progress, error, value, workerMs = 0, workerStages = {} } = event.data;
      const p = this.pending.get(id);
      if (!p) return;
      if (progress) {
        p.progress(progress);
        return;
      }
      this.pending.delete(id);
      const durationMs = performance.now() - p.started;
      trace.request(p.op, durationMs, workerMs, p.postMessageMs);
      trace.workerTiming(workerStages);
      trace.event("request", error ? `${p.op} failed` : `${p.op} completed`, {
        worker: index, request: id, durationMs, workerMs,
      });
      if (p.op === "prepare" && !error) {
        trace.prepared(value.nRows, value.items.length, value.fingerprint);
        trace.received(value.codes.byteLength + value.observed.byteLength);
      }
      if (p.op === "fit" && !error) trace.numerical(value);
      if (error)
        p.reject(new EfaError(error.code, error.message, error.diagnostics));
      else p.resolve(value);
    };
    this.worker.onerror = (event) => {
      trace.event("worker", "runtime error", { worker: index });
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
      const started = performance.now();
      if (!["initialize", "pairs", "observed-support"].includes(request.op)) this.trace.operation(request.op);
      if (request.op === "prepare") this.trace.spec(request.spec, request.rows.length, "prepare");
      if (request.op === "initialize") {
        this.trace.prepared(request.data.nRows, request.data.items.length, request.data.fingerprint);
        this.trace.sent(request.data.codes.byteLength + request.data.observed.byteLength);
      }
      const pending = {
        resolve: (v: unknown) => resolve(v as T), reject, progress,
        op: request.op, started, postMessageMs: 0,
      };
      this.pending.set(id, pending);
      this.trace.event("request", `${request.op} started`, { worker: this.index, request: id,
        count: request.op === "pairs" ? request.pairs.length : undefined });
      try {
        const before = performance.now();
        this.worker.postMessage({ ...request, id });
        pending.postMessageMs = performance.now() - before;
      } catch (error) {
        this.pending.delete(id);
        this.trace.event("request", `${request.op} message failed`, { worker: this.index, request: id });
        reject(error);
      }
    });
  }
  terminate() {
    if (this.terminated) return;
    this.terminated = true;
    this.worker.terminate();
    this.trace.worker(false, this.index);
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
  private traces = new WeakMap<WorkerClient[], ComputeTrace>();
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
  report(id: string): ComputeReport | undefined {
    return this.jobs.get(id)?.trace.snapshot();
  }
  trackPublication<T>(job: EfaJob<unknown>, completion: Promise<T>) {
    job.trace.publication("pending");
    void completion.then(() => {
      job.trace.publication("accepted"); this.emit();
    }, () => {
      job.trace.publication("discarded"); this.emit();
    });
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
    const trace = new ComputeTrace(id);
    this.traces.set(workers, trace);
    const job: EfaJob<T> = {
      id,
      trace,
      status: "running",
      progress: { stage: "Preparing", completed: 0, total: 1 },
      promise: Promise.resolve(undefined as T),
      cancel: () => {
        if (job.status !== "running") return;
        job.status = "cancelled";
        workers.forEach((w) => w.terminate());
        trace.finish("cancelled");
        this.emit();
      },
    };
    this.jobs.set(id, job);
    this.emit();
    let lastProgressEmission = 0;
    const progress = (p: EfaProgress) => {
      if (job.status === "running") {
        const changedStage = p.stage !== job.progress.stage;
        job.progress = p;
        trace.progress(p);
        const now = performance.now();
        if (
          changedStage ||
          p.completed === p.total ||
          now - lastProgressEmission >= 250
        ) {
          lastProgressEmission = now;
          this.emit();
        }
      }
    };
    job.promise = task(workers, progress, () => job.status === "running")
      .then((result) => {
        if (job.status !== "running")
          throw new EfaError("cancelled", "Analysis cancelled.");
        job.result = result;
        job.status = "completed";
        trace.finish("completed");
        job.progress = { stage: "Completed", completed: 1, total: 1 };
        return result;
      })
      .catch((error) => {
        if (job.status !== "cancelled") {
          job.status = "failed";
          job.error = error instanceof Error ? error.message : String(error);
          trace.finish("failed");
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
    const client = new WorkerClient(this.workerFactory, this.traces.get(workers)!, workers.length + 1);
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
    minimumPairN = 0,
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
      progress({ stage: "Original observed support", completed: 0, total: 1 });
      const supportFloor = await first.request<number>({
        op: "observed-support",
      });
      if (minimumPairN > 0 && supportFloor < minimumPairN)
        throw new EfaError(
          "privacy",
          "Original observed pairs are below the private aggregate floor. Imputation does not add observed support.",
        );
      const estimatedBytes = imputationWorkingSet(data, settings),
        workerLimit = Math.min(
          this.concurrency,
          settings.imputations,
          snapshot.extraction === "wlsmv" ? 1 : 4,
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
      const analysis = summarizeImputations(
        data,
        settings,
        results,
        snapshot.extraction,
        supportFloor,
      );
      analysis.provenance.execution = {
        workers: workerLimit,
        estimatedWorkingSetBytesPerWorker: estimatedBytes,
        note: `Concurrency reduced for expanded predictor designs using an approximate 1 GiB combined working-set budget, with at least one worker. This is a scheduling estimate, not measured peak memory or a cap on a single model.${snapshot.extraction === "wlsmv" ? " WLSMV chains run sequentially; each robust fit separately enforces its inference allocation budget." : ""}`,
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
        spec.extraction,
      );
    });
  }
  preview(
    table: DataTable,
    spec: EfaSpec,
    rows: number[],
  ): EfaJob<{
    nRows: number;
    counts: number[][];
    inferencePlan?: InferencePlan;
  }> {
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
      return {
        nRows: data.nRows,
        counts: data.counts,
        ...(snapshot.extraction === "wlsmv"
          ? {
              inferencePlan: planWeightedInference(
                data.items.length,
                snapshot.nFactors,
                data.nRows,
                data.items.reduce(
                  (sum, item, i) =>
                    sum +
                    data.items
                      .slice(i + 1)
                      .reduce(
                        (s, next) =>
                          s + item.categories.length * next.categories.length,
                        0,
                      ),
                  0,
                ),
              ),
            }
          : {}),
      };
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
      const trace = this.traces.get(workers)!;
      trace.event("cache", cached ? "correlations hit: identical preprocessing and rows" : "correlations miss");
      const data = cached
        ? cached.data
        : await first.request<EfaPreparedData>({
            op: "prepare",
            table: selected,
            spec: snapshot,
            rows: membership,
          });
      if (cached) await first.request({ op: "initialize", data });
      trace.spec(snapshot, membership.length, "fit");
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
          trace.event("cache", "retained pairs reused: identical fitting rows and item transformations");
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
        progress({ stage: "Correlations", completed: 0, total: pairs.length });
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
        (reuse.spec.extraction ?? "minres") ===
          (snapshot.extraction ?? "minres") &&
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
      if (extraction) trace.event("cache", "unrotated extraction reused");
      // Correlation workers are finished. Keep just the fitting worker while
      // weighted covariance and rotated uncertainty use their bounded buffers.
      if (snapshot.extraction && snapshot.extraction !== "minres")
        workers
          .filter((worker) => worker !== first)
          .forEach((worker) => worker.terminate());
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
