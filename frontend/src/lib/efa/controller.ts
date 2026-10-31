import type { DataTable } from "../table";
import { EfaService, type EfaJob } from "./service";
import {
  addScoreColumns,
  fittingRows,
  createSampleSplit,
  existingSampleSplit,
} from "./state";
import { compareEfaRuns } from "./compare";
import type { MiceOptions } from "./mice";
import type { StabilityOptions } from "./stability";
import {
  EfaError,
  type EfaSpec,
  type EfaRun,
  type EfaState,
  type ItemReview,
  type SampleSplit,
} from "./types";

export interface EfaContext {
  datasetId: number;
  table: DataTable;
  eligibleRows: number[];
  state: EfaState;
  privateMode: boolean;
  afterFullExploration: boolean;
  filterKey: string;
}
export interface EfaAdapter {
  context: () => EfaContext;
  state: (
    datasetId: number,
    expectedTable: DataTable,
    update: (state: EfaState) => EfaState,
  ) => void;
  scores: (
    datasetId: number,
    expectedTable: DataTable,
    table: DataTable,
    runId: string,
    columns: string[],
  ) => void;
}
export class EfaController {
  private generation = 0;
  private published = new Map<string, Promise<string>>();
  private simulations = new Map<string, Promise<string>>();
  private completedRuns = new Map<
    string,
    { datasetId: number; table: DataTable; run: EfaRun }
  >();
  private adapterValue?: EfaAdapter;
  private adapter: () => EfaAdapter;
  constructor(
    readonly service: EfaService,
    adapter?: () => EfaAdapter,
  ) {
    this.adapter =
      adapter ??
      (() => {
        if (!this.adapterValue) throw new Error("EFA is not ready.");
        return this.adapterValue;
      });
  }
  attach(adapter: EfaAdapter) {
    this.adapterValue = adapter;
  }
  cancel = () => {
    this.generation++;
    this.completedRuns.clear();
    this.service.cancelAll();
  };
  private current() {
    return this.adapter().context();
  }
  private findRun(context: EfaContext, id: unknown) {
    const committed = context.state.runs.find((run) => run.id === id);
    if (committed) return committed;
    const pending = this.completedRuns.get(String(id));
    return pending?.datasetId === context.datasetId &&
      pending.table === context.table
      ? pending.run
      : undefined;
  }
  private assertCurrent(context: EfaContext, generation: number) {
    const now = this.current();
    if (
      generation !== this.generation ||
      now.datasetId !== context.datasetId ||
      now.table !== context.table ||
      now.filterKey !== context.filterKey
    )
      throw new EfaError(
        "stale",
        "The dataset, filter, or workspace changed. This completed job was not published.",
      );
  }
  private input(spec: EfaSpec, assistant = false) {
    const context = this.current(),
      rows = fittingRows(context.eligibleRows, spec, context.state.splits);
    const excluded = context.eligibleRows.length - rows.length;
    if (
      assistant &&
      context.privateMode &&
      (rows.length < 5 || (excluded > 0 && excluded < 5))
    )
      throw new EfaError(
        "privacy",
        "The selected partition is below the private aggregate floor, or excludes fewer than five eligible respondents.",
      );
    return { context, rows };
  }
  start(
    spec: EfaSpec,
    options: {
      parentId?: string;
      kind?: EfaRun["kind"];
      reviews?: Record<string, ItemReview>;
      reasons?: string;
      assistant?: boolean;
    } = {},
  ) {
    spec = structuredClone(spec);
    options = structuredClone(options);
    const { context, rows } = this.input(spec, options.assistant),
      generation = ++this.generation;
    const parent = this.findRun(context, options.parentId),
      kind = options.kind ?? "fit";
    if (options.parentId && !parent)
      throw new EfaError("parent", "Parent EFA run does not exist.");
    if (!["fit", "rotation", "items", "structure-replication"].includes(kind))
      throw new EfaError("kind", "Unknown EFA run kind.");
    if ((kind === "rotation" || kind === "items") && !parent)
      throw new EfaError(
        "parent",
        "A rotation comparison or item refit requires a saved parent run.",
      );
    if (kind === "rotation" && parent) {
      const fixed = (s: EfaSpec) => ({
        ...s,
        label: undefined,
        rotation: undefined,
      });
      if (
        JSON.stringify(fixed(spec)) !== JSON.stringify(fixed(parent.spec)) ||
        JSON.stringify(rows) !== JSON.stringify(parent.eligibleRows)
      )
        throw new EfaError(
          "rotation",
          "A rotation comparison preserves the items, factor count, preprocessing and sample. Use a refit for other changes.",
        );
    }
    if (kind === "structure-replication") {
      if (
        !parent ||
        parent.spec.sample.partition !== "development" ||
        spec.sample.partition !== "holdout" ||
        spec.sample.splitId !== parent.spec.sample.splitId
      )
        throw new EfaError(
          "holdout",
          "Structure replication requires a development parent and its saved holdout partition.",
        );
      const withoutSample = (s: EfaSpec) => ({ ...s, sample: undefined });
      if (
        JSON.stringify(withoutSample(spec)) !==
        JSON.stringify(withoutSample(parent.spec))
      )
        throw new EfaError(
          "holdout",
          "Structure replication freezes the development specification.",
        );
    }
    const job = this.service.fit(
      context.table,
      spec,
      rows,
      kind === "rotation" ? parent : undefined,
      options.assistant && context.privateMode ? 5 : 0,
    );
    const completion = job.promise.then((result) => {
      this.assertCurrent(context, generation);
      const id = crypto.randomUUID(),
        now = new Date().toISOString();
      const run: EfaRun = {
        id,
        revision:
          Math.max(
            0,
            ...context.state.runs.map((r) => r.revision),
            ...[...this.completedRuns.values()]
              .filter(
                (r) =>
                  r.datasetId === context.datasetId &&
                  r.table === context.table,
              )
              .map((r) => r.run.revision),
          ) + 1,
        createdAt: now,
        datasetRevision: this.service.revision(context.table),
        spec: structuredClone(spec),
        result,
        eligibleRows: rows,
        parentId: parent?.id,
        kind,
        reviews: structuredClone(options.reviews ?? {}),
        reasons: options.reasons ?? "",
        revisedAfterHoldout: context.state.splits.some(
          (s) => !!s.holdoutOpenedAt,
        ),
        scoreColumns: [],
      };
      // A following assistant action can run before React commits the saved run.
      // Scope this short-lived bridge to the exact input table; undo clears it.
      this.completedRuns.set(id, {
        datasetId: context.datasetId,
        table: context.table,
        run,
      });
      this.adapter().state(context.datasetId, context.table, (state) => ({
        ...state,
        runs: [...state.runs, run],
      }));
      return id;
    });
    this.published.set(job.id, completion);
    void completion.catch(() => {});
    return { job, completion };
  }
  run = async (
    spec: EfaSpec,
    options?: Parameters<EfaController["start"]>[1],
  ) => this.start(spec, options).completion;
  addScores = async (id: string, assistant = false) => {
    const context = this.current(),
      run = this.findRun(context, id);
    if (!run) throw new EfaError("run", "EFA run not found.");
    if (
      assistant &&
      context.privateMode &&
      "withheld" in this.summary(run, true)
    )
      throw new EfaError(
        "privacy",
        "This saved run is below the private aggregate floor. Add scores locally if appropriate.",
      );
    // A saved run cannot bypass a newer active filter. Require exactly its
    // original fitting population, or a refit through the current gate.
    const allowed = new Set(context.eligibleRows);
    if (run.result.fittingRows.some((r) => !allowed.has(r)))
      throw new EfaError(
        "filter",
        "The active filter excludes fitting rows. Restore the fitting filter or refit before adding scores.",
      );
    const generation = ++this.generation,
      scores = await this.service.scores(context.table, run).promise;
    this.assertCurrent(context, generation);
    const result = addScoreColumns(context.table, run, scores);
    this.adapter().scores(
      context.datasetId,
      context.table,
      result.table,
      run.id,
      result.columns,
    );
    return `Added ${result.columns.join(", ")}. Ordinal linear score approximations; incomplete and excluded rows remain unscored.`;
  };
  preview = async (spec: EfaSpec) => {
    const { context, rows } = this.input(spec);
    return this.service.preview(context.table, spec, rows).promise;
  };
  private startParallel(spec: EfaSpec, replicates: number, assistant = false) {
    spec = structuredClone(spec);
    const { context, rows } = this.input(spec, assistant),
      generation = ++this.generation,
      job = this.service.parallel(
        context.table,
        spec,
        rows,
        replicates,
        assistant && context.privateMode ? 5 : 0,
      );
    const completion = job.promise.then((result) => {
      this.assertCurrent(context, generation);
      const id = crypto.randomUUID();
      this.adapter().state(context.datasetId, context.table, (state) => ({
        ...state,
        parallelRuns: [
          ...(state.parallelRuns ?? []),
          {
            id,
            spec: structuredClone(spec),
            eligibleRows: rows,
            createdAt: new Date().toISOString(),
            result,
          },
        ],
      }));
      return id;
    });
    this.simulations.set(job.id, completion);
    void completion.catch(() => {});
    return { job, completion };
  }
  parallel = async (spec: EfaSpec, replicates: number) => {
    const { job, completion } = this.startParallel(spec, replicates);
    await completion;
    return job.result!;
  };
  impute = async (
    spec: EfaSpec,
    options: MiceOptions,
    changes: {
      parentId?: string;
      reviews?: Record<string, ItemReview>;
      reasons?: string;
    } = {},
  ) => {
    const snapshot = structuredClone(spec),
      settings = structuredClone(options),
      notes = structuredClone(changes);
    const { context, rows } = this.input(snapshot),
      generation = ++this.generation;
    if (
      notes.parentId &&
      !context.state.imputationRuns?.some((r) => r.id === notes.parentId)
    )
      throw new EfaError(
        "parent",
        "Parent imputation analysis does not exist.",
      );
    const job = this.service.impute(context.table, snapshot, rows, settings);
    const completion = job.promise.then((result) => {
      this.assertCurrent(context, generation);
      const id = crypto.randomUUID();
      this.adapter().state(context.datasetId, context.table, (state) => ({
        ...state,
        imputationRuns: [
          ...(state.imputationRuns ?? []),
          {
            id,
            revision:
              Math.max(
                0,
                ...(state.imputationRuns ?? []).map((r) => r.revision),
              ) + 1,
            createdAt: new Date().toISOString(),
            datasetRevision: this.service.revision(context.table),
            spec: snapshot,
            eligibleRows: rows,
            parentId: notes.parentId,
            reviews: notes.reviews ?? {},
            reasons: notes.reasons ?? "",
            revisedAfterHoldout: state.splits.some((s) => !!s.holdoutOpenedAt),
            result,
          },
        ],
      }));
      return id;
    });
    this.simulations.set(job.id, completion);
    void completion.catch(() => {});
    return completion;
  };
  stability = async (
    runId: string,
    options: Omit<StabilityOptions, "groups">,
    groupColumn?: string,
  ) => {
    const context = this.current(),
      run = this.findRun(context, runId);
    if (!run) throw new EfaError("run", "EFA run not found.");
    const allowed = new Set(context.eligibleRows);
    if (run.result.fittingRows.some((r) => !allowed.has(r)))
      throw new EfaError(
        "filter",
        "The active filter excludes fitting respondents. Restore the fitting population or refit before resampling.",
      );
    const groups = groupColumn
      ? run.result.fittingRows.map((row) => {
          const value = context.table.data[groupColumn]?.[row];
          if (value === null || value === undefined || value === "")
            throw new EfaError(
              "resampling-groups",
              "Every fitting respondent needs a group identifier.",
            );
          return `${typeof value}:${String(value)}`;
        })
      : undefined;
    const settings = structuredClone({ ...options, groups }),
      generation = ++this.generation,
      job = this.service.stability(context.table, run, settings);
    const completion = job.promise.then((result) => {
      this.assertCurrent(context, generation);
      const id = crypto.randomUUID();
      this.adapter().state(context.datasetId, context.table, (state) => ({
        ...state,
        stabilityRuns: [
          ...(state.stabilityRuns ?? []),
          {
            id,
            runId,
            createdAt: new Date().toISOString(),
            datasetRevision: this.service.revision(context.table),
            groupColumn,
            result,
          },
        ],
      }));
      return id;
    });
    this.simulations.set(job.id, completion);
    void completion.catch(() => {});
    return completion;
  };
  imputationReviews = (id: string, reviews: Record<string, ItemReview>) => {
    const c = this.current();
    this.adapter().state(c.datasetId, c.table, (state) => ({
      ...state,
      imputationRuns: state.imputationRuns?.map((r) =>
        r.id === id ? { ...r, reviews: structuredClone(reviews) } : r,
      ),
    }));
  };
  split = (options: {
    seed: number;
    fraction: number;
    groupColumn?: string;
    stratumColumn?: string;
    sourceColumn?: string;
    developmentValue?: string;
    holdoutValue?: string;
  }): SampleSplit => {
    const c = this.current(),
      s = options.sourceColumn
        ? existingSampleSplit(
            c.table,
            c.eligibleRows,
            options.sourceColumn,
            options.developmentValue ?? "",
            options.holdoutValue ?? "",
            c.afterFullExploration,
          )
        : createSampleSplit(c.table, c.eligibleRows, {
            ...options,
            afterFullExploration: c.afterFullExploration,
          });
    this.adapter().state(c.datasetId, c.table, (state) => ({
      ...state,
      splits: [...state.splits, s],
    }));
    return s;
  };
  reviews = (id: string, reviews: Record<string, ItemReview>) => {
    const c = this.current();
    this.adapter().state(c.datasetId, c.table, (state) => ({
      ...state,
      runs: state.runs.map((r) =>
        r.id === id ? { ...r, reviews: structuredClone(reviews) } : r,
      ),
    }));
  };
  openHoldout = (id: string) => {
    const c = this.current(),
      run =
        this.findRun(c, id) ?? c.state.imputationRuns?.find((r) => r.id === id);
    if (run?.spec.sample.partition === "holdout")
      this.adapter().state(c.datasetId, c.table, (state) => ({
        ...state,
        splits: state.splits.map((s) =>
          s.id === run.spec.sample.splitId && !s.holdoutOpenedAt
            ? { ...s, holdoutOpenedAt: new Date().toISOString() }
            : s,
        ),
      }));
  };

  /** Deliberately whitelist aggregate fields; never serialize a run/job into a
   * tool response (those contain respondent membership and scaling details). */
  private summary(run: EfaRun, privateMode: boolean) {
    if (
      privateMode &&
      (run.result.fittingRows.length < 5 ||
        run.result.correlation.pairs.some((p) => p.n < 5))
    )
      return {
        runId: run.id,
        label: run.spec.label,
        withheld:
          "This analysis includes pairs below the private aggregate floor. Inspect it locally or revise the sample.",
      };
    return {
      runId: run.id,
      label: run.spec.label,
      revision: run.revision,
      items: run.spec.items.map((i) => i.column),
      nFactors: run.spec.nFactors,
      rotation: run.spec.rotation,
      missing: run.spec.missing,
      kind: run.kind,
      n: run.result.fittingRows.length,
      pattern: run.result.rotation.pattern,
      structure: run.result.structure,
      phi: run.result.rotation.phi,
      communalities: run.result.communalities,
      rmsr: run.result.rmsr,
      diagnostics: run.result.diagnostics.map((d) => ({
        code: d.code,
        message: d.message,
      })),
      revisedAfterHoldout: run.revisedAfterHoldout,
    };
  }
  tool = async (
    action: string,
    args: Record<string, unknown>,
  ): Promise<string> => {
    let privateMode = true;
    try {
      const c = this.current();
      privateMode = c.privateMode;
      if (action === "run_efa") {
        if (!args.spec || typeof args.spec !== "object")
          throw new EfaError(
            "spec",
            "Supply a complete EFA specification with explicit category orders.",
          );
        const spec = args.spec as EfaSpec;
        const { job } = this.start(spec, {
          assistant: true,
          parentId:
            typeof args.parentId === "string" ? args.parentId : undefined,
          kind: args.kind as EfaRun["kind"] | undefined,
          reasons: typeof args.reasons === "string" ? args.reasons : "",
        });
        return JSON.stringify({
          jobId: job.id,
          status: job.status,
          message:
            "Poll efa_job for completion. No score columns are added automatically.",
        });
      }
      if (action === "efa_job") {
        const job = this.service.getJob(String(args.jobId));
        if (!job) throw new EfaError("job", "Job not found.");
        if (args.cancel === true) {
          this.cancel();
          return JSON.stringify({ jobId: job.id, status: "cancelled" });
        }
        if (job.status === "completed") {
          const promise = this.published.get(job.id);
          if (promise) {
            const runId = await promise;
            return JSON.stringify({
              jobId: job.id,
              status: "completed",
              runId,
            });
          }
          const simulation = this.simulations.get(job.id);
          return JSON.stringify({
            jobId: job.id,
            status: "completed",
            simulationId: simulation ? await simulation : undefined,
            message:
              "Simulation completed. Open or export its results locally.",
          });
        }
        return JSON.stringify({
          jobId: job.id,
          status: job.status,
          progress: job.progress,
          ...(!privateMode && job.error ? { error: job.error } : {}),
        });
      }
      if (action === "parallel_efa") {
        const spec = args.spec as EfaSpec,
          { job } = this.startParallel(
            spec,
            typeof args.replicates === "number" ? args.replicates : 100,
            true,
          );
        return JSON.stringify({ jobId: job.id, status: job.status });
      }
      const run = this.findRun(c, args.runId);
      if (!run) throw new EfaError("run", "EFA run not found.");
      if (action === "get_efa_diagnostics") {
        this.openHoldout(run.id);
        return JSON.stringify(this.summary(run, privateMode));
      }
      if (action === "add_efa_scores")
        return await this.addScores(run.id, true);
      if (action === "compare_efa") {
        const other = this.findRun(c, args.otherRunId);
        if (!other) throw new EfaError("run", "Comparison run not found.");
        this.openHoldout(run.id);
        this.openHoldout(other.id);
        const a = this.summary(run, privateMode),
          b = this.summary(other, privateMode);
        if ("withheld" in a || "withheld" in b)
          return JSON.stringify({ baseline: a, comparison: b });
        const match = compareEfaRuns(run, other);
        return JSON.stringify({
          baseline: a,
          comparison: b,
          sharedItems: match.shared,
          factorMapping: match.mapping,
          signs: match.signs,
          congruence: match.congruence,
          unmatchedFactors: match.unmatchedCandidate,
          sameRows: match.sameRows,
        });
      }
      throw new EfaError("action", "Unknown EFA action.");
    } catch (error) {
      return privateMode
        ? `EFA action failed (${error instanceof EfaError ? error.code : "invalid-request"}). Review the local EFA panel for details.`
        : `EFA action failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  jobs(): EfaJob[] {
    return this.service.listJobs();
  }
}
