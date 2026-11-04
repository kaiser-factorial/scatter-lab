import { validateSpec } from "./prepare";
import {
  inspectItems,
  inspectedFit,
  isImputation,
  pageInteger,
  requireAggregate,
  runMetadata,
  runOverview,
  type InspectableRun,
} from "./inspection";
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
  type EfaImputationRun,
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
  private reviewed = new Map<
    string,
    { datasetId: number; table: DataTable; run: InspectableRun }
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
    this.reviewed.clear();
    this.service.cancelAll();
  };
  private current() {
    return this.adapter().context();
  }
  private findRun(context: EfaContext, id: unknown) {
    const committed = context.state.runs.find((run) => run.id === id);
    const edited = this.reviewed.get(String(id));
    if (
      edited &&
      !isImputation(edited.run) &&
      edited.datasetId === context.datasetId &&
      edited.table === context.table &&
      (edited.run.reviewRevision ?? 0) > (committed?.reviewRevision ?? 0)
    )
      return edited.run;
    if (committed) return committed;
    const pending = this.completedRuns.get(String(id));
    return pending?.datasetId === context.datasetId &&
      pending.table === context.table
      ? pending.run
      : undefined;
  }
  private findAnalysis(
    context: EfaContext,
    id: unknown,
  ): InspectableRun | undefined {
    const ordinary = this.findRun(context, id);
    if (ordinary) return ordinary;
    const committed = context.state.imputationRuns?.find((r) => r.id === id);
    const edited = this.reviewed.get(String(id));
    return edited &&
      isImputation(edited.run) &&
      edited.datasetId === context.datasetId &&
      edited.table === context.table &&
      (!committed ||
        (edited.run.reviewRevision ?? 0) > (committed.reviewRevision ?? 0))
      ? edited.run
      : committed;
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
      parentReviewRevision?: number;
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
        reviewRevision: 0,
        parentReviewRevision:
          options.parentReviewRevision ??
          parent?.reviewRevision ??
          (parent ? 0 : undefined),
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
    this.service.trackPublication(job, completion);
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
      job = this.service.scores(context.table, run);
    const completion = job.promise.then((scores) => {
      this.assertCurrent(context, generation);
      const result = addScoreColumns(context.table, run, scores);
      this.adapter().scores(
        context.datasetId, context.table, result.table, run.id, result.columns,
      );
      return `Added ${result.columns.join(", ")}. Ordinal linear score approximations; incomplete and excluded rows remain unscored.`;
    });
    this.service.trackPublication(job, completion);
    return completion;
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
    this.service.trackPublication(job, completion);
    void completion.catch(() => {});
    return { job, completion };
  }
  parallel = async (spec: EfaSpec, replicates: number) => {
    const { job, completion } = this.startParallel(spec, replicates);
    await completion;
    return job.result!;
  };
  private startImputation = (
    spec: EfaSpec,
    options: MiceOptions,
    changes: {
      parentId?: string;
      reviews?: Record<string, ItemReview>;
      reasons?: string;
      parentReviewRevision?: number;
      assistant?: boolean;
    } = {},
  ) => {
    const snapshot = structuredClone(spec),
      settings = structuredClone(options),
      notes = structuredClone(changes);
    const { context, rows } = this.input(snapshot, changes.assistant),
      generation = ++this.generation;
    if (
      notes.parentId &&
      !context.state.imputationRuns?.some((r) => r.id === notes.parentId)
    )
      throw new EfaError(
        "parent",
        "Parent imputation analysis does not exist.",
      );
    const job = this.service.impute(
      context.table,
      snapshot,
      rows,
      settings,
      changes.assistant && context.privateMode ? 5 : 0,
    );
    const completion = job.promise.then((result) => {
      this.assertCurrent(context, generation);
      const id = crypto.randomUUID();
      const state = this.current().state;
      const saved: EfaImputationRun = {
        id,
        revision:
          Math.max(
            0,
            ...(state.imputationRuns ?? []).map((r) => r.revision),
            ...[...this.reviewed.values()]
              .filter(
                (v) =>
                  v.datasetId === context.datasetId &&
                  v.table === context.table &&
                  isImputation(v.run),
              )
              .map((v) => v.run.revision),
          ) + 1,
        createdAt: new Date().toISOString(),
        datasetRevision: this.service.revision(context.table),
        spec: snapshot,
        eligibleRows: rows,
        parentId: notes.parentId,
        reviews: notes.reviews ?? {},
        reviewRevision: 0,
        parentReviewRevision:
          notes.parentReviewRevision ??
          context.state.imputationRuns?.find((r) => r.id === notes.parentId)
            ?.reviewRevision ??
          (notes.parentId ? 0 : undefined),
        reasons: notes.reasons ?? "",
        revisedAfterHoldout: state.splits.some((s) => !!s.holdoutOpenedAt),
        result,
      };
      this.reviewed.set(id, {
        datasetId: context.datasetId,
        table: context.table,
        run: saved,
      });
      this.adapter().state(context.datasetId, context.table, (state) => ({
        ...state,
        imputationRuns: [...(state.imputationRuns ?? []), saved],
      }));
      return id;
    });
    this.simulations.set(job.id, completion);
    this.service.trackPublication(job, completion);
    void completion.catch(() => {});
    return { job, completion };
  };
  impute = async (
    spec: EfaSpec,
    options: MiceOptions,
    changes: Parameters<EfaController["startImputation"]>[2] = {},
  ) => this.startImputation(spec, options, changes).completion;
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
    this.service.trackPublication(job, completion);
    void completion.catch(() => {});
    return completion;
  };
  imputationReviews = (id: string, reviews: Record<string, ItemReview>) =>
    this.saveReviews(id, reviews);
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
  private saveReviews(id: string, reviews: Record<string, ItemReview>) {
    const c = this.current(),
      run = this.findAnalysis(c, id);
    if (!run) throw new EfaError("run", "EFA run not found.");
    const updated = {
      ...run,
      reviews: structuredClone(reviews),
      reviewRevision: (run.reviewRevision ?? 0) + 1,
    };
    this.reviewed.set(id, {
      datasetId: c.datasetId,
      table: c.table,
      run: updated,
    });
    this.adapter().state(c.datasetId, c.table, (state) =>
      isImputation(run)
        ? {
            ...state,
            imputationRuns: state.imputationRuns?.map((r) =>
              r.id === id
                ? {
                    ...r,
                    reviews: updated.reviews,
                    reviewRevision: updated.reviewRevision,
                  }
                : r,
            ),
          }
        : {
            ...state,
            runs: state.runs.map((r) =>
              r.id === id
                ? {
                    ...r,
                    reviews: updated.reviews,
                    reviewRevision: updated.reviewRevision,
                  }
                : r,
            ),
          },
    );
    return updated;
  }
  reviews = (id: string, reviews: Record<string, ItemReview>) => {
    this.saveReviews(id, reviews);
  };
  private checkReviewRevision(run: InspectableRun, expected: unknown) {
    if (
      !Number.isSafeInteger(expected) ||
      expected !== (run.reviewRevision ?? 0)
    )
      throw new EfaError(
        "review-conflict",
        "Item reviews changed. Read get_efa_items again before editing or refitting.",
      );
  }
  private updateItems(run: InspectableRun, args: Record<string, unknown>) {
    this.checkReviewRevision(run, args.expectedReviewRevision);
    const changes = args.changes;
    if (!Array.isArray(changes) || !changes.length || changes.length > 100)
      throw new EfaError("items", "Supply 1–100 explicit item review changes.");
    const reviews = structuredClone(run.reviews),
      seen = new Set<string>();
    for (const change of changes) {
      if (
        !change ||
        typeof change !== "object" ||
        Array.isArray(change) ||
        typeof change.column !== "string" ||
        !run.spec.items.some((i) => i.column === change.column) ||
        seen.has(change.column) ||
        !["retain", "investigate", "exclude"].includes(change.status) ||
        typeof change.note !== "string" ||
        change.note.length > 2000 ||
        Object.keys(change).some(
          (k) => !["column", "status", "note"].includes(k),
        )
      )
        throw new EfaError(
          "items",
          "Each change needs a unique saved item, valid status and a note of at most 2000 characters.",
        );
      seen.add(change.column);
      Object.defineProperty(reviews, change.column, {
        value: { status: change.status, note: change.note },
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return runMetadata(this.saveReviews(run.id, reviews));
  }
  private refitSelection(run: InspectableRun, args: Record<string, unknown>) {
    this.checkReviewRevision(run, args.expectedReviewRevision);
    if (
      typeof args.label !== "string" ||
      !args.label.trim() ||
      args.label.length > 200 ||
      typeof args.reasons !== "string" ||
      !args.reasons.trim() ||
      args.reasons.length > 2000 ||
      (args.keepRows !== undefined && typeof args.keepRows !== "boolean")
    )
      throw new EfaError(
        "refit",
        "Supply a label, substantive reasons, and optional keepRows boolean.",
      );
    const indices = run.spec.items.flatMap((i, j) =>
      run.reviews[i.column]?.status === "exclude" ? [] : [j],
    );
    const spec: EfaSpec = {
      ...structuredClone(run.spec),
      items: indices.map((i) => structuredClone(run.spec.items[i])),
      nFactors: pageInteger(args.nFactors, run.spec.nFactors, 1, 499),
      label: args.label,
      sample: {
        ...run.spec.sample,
        fixedRows:
          args.keepRows !== false || isImputation(run)
            ? run.result.fittingRows.slice()
            : undefined,
      },
    };
    validateSpec(spec);
    const changes = {
      parentId: run.id,
      parentReviewRevision: run.reviewRevision ?? 0,
      reviews: run.reviews,
      reasons: args.reasons,
      assistant: true,
    };
    if (isImputation(run)) {
      if (args.keepRows === false)
        throw new EfaError(
          "refit",
          "MICE refits preserve the original fitting population.",
        );
      const mapping = new Map(indices.map((j, i) => [j, i]));
      return this.startImputation(
        spec,
        {
          ...structuredClone(run.result.options),
          predictors: indices.map((i) =>
            run.result.options.predictors[i].flatMap((j) =>
              mapping.has(j) ? [mapping.get(j)!] : [],
            ),
          ),
        },
        changes,
      ).job;
    }
    return this.start(spec, { ...changes, kind: "items" }).job;
  }
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

  private summary(run: EfaRun, privateMode: boolean) {
    try {
      return runOverview(run, privateMode);
    } catch {
      return {
        runId: run.id,
        withheld:
          "Original observed support is below the private aggregate floor.",
      };
    }
  }
  tool = async (
    action: string,
    args: Record<string, unknown>,
  ): Promise<string> => {
    let privateMode = true;
    try {
      const c = this.current();
      privateMode = c.privateMode;
      if (action === "list_efa_runs") {
        const offset = pageInteger(args.offset, 0, 0, 100000),
          limit = pageInteger(args.limit, 20, 1, 20);
        const runs: InspectableRun[] = [
          ...c.state.runs,
          ...(c.state.imputationRuns ?? []),
        ];
        return JSON.stringify({
          total: runs.length,
          offset,
          nextOffset: offset + limit < runs.length ? offset + limit : null,
          runs: runs.slice(offset, offset + limit).map((r) => {
            const current = this.findAnalysis(c, r.id)!;
            try {
              requireAggregate(current, privateMode);
              return runMetadata(current);
            } catch {
              return { runId: r.id, withheld: "Private aggregate floor" };
            }
          }),
        });
      }
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
        if (args.cancel === true && job.status === "running") {
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
          progress: privateMode
            ? { completed: job.progress.completed, total: job.progress.total }
            : job.progress,
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
      const run = this.findAnalysis(c, args.runId);
      if (!run) throw new EfaError("run", "EFA run not found.");
      if (action === "get_efa_diagnostics") {
        this.openHoldout(run.id);
        return JSON.stringify(runOverview(run, privateMode));
      }
      if (action === "get_efa_items") {
        this.openHoldout(run.id);
        return JSON.stringify(inspectItems(run, args, privateMode));
      }
      if (action === "update_efa_items") {
        requireAggregate(run, privateMode);
        return JSON.stringify({
          ...this.updateItems(run, args),
          message:
            "Updated the visible item review table. No refit or score publication yet.",
        });
      }
      if (action === "refit_efa_selection") {
        requireAggregate(run, privateMode);
        const job = this.refitSelection(run, args);
        return JSON.stringify({
          jobId: job.id,
          status: job.status,
          parentId: run.id,
          parentReviewRevision: run.reviewRevision ?? 0,
          message:
            "Poll efa_job; the parent result is preserved. Scores are not added automatically.",
        });
      }
      if (action === "add_efa_scores") {
        if (isImputation(run))
          throw new EfaError(
            "imputation-scores",
            "MICE scores are not pooled. Separate fit results remain available locally.",
          );
        return await this.addScores(run.id, true);
      }
      if (action === "compare_efa") {
        const other = this.findAnalysis(c, args.otherRunId);
        if (!other) throw new EfaError("run", "Comparison run not found.");
        this.openHoldout(run.id);
        this.openHoldout(other.id);
        const a = runOverview(run, privateMode),
          b = runOverview(other, privateMode);
        const asFit = (r: InspectableRun): EfaRun => ({
          ...r,
          kind: "fit",
          scoreColumns: [],
          result: inspectedFit(r),
        });
        const match = compareEfaRuns(asFit(run), asFit(other));
        return JSON.stringify({
          baseline: a,
          comparison: b,
          sharedItems: match.shared.slice(0, 20),
          sharedItemCount: match.shared.length,
          removedItems: match.removedItems,
          addedItems: match.addedItems,
          comparisonBasis:
            "First successful fit for MICE analyses; use get_efa_items for separate fits and descriptive summaries.",
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
