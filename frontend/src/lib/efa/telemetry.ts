import type { EfaProgress, EfaResult, EfaSpec } from "./types";

/** Operational records only. Never pass source cells, column names, category
 * counts, row membership, user labels, or free-form exception text here. */
export interface ComputeEvent {
  sequence: number;
  elapsedMs: number;
  kind: "job" | "worker" | "request" | "cache" | "publication" | "stage";
  action: string;
  worker?: number;
  request?: number;
  durationMs?: number;
  workerMs?: number;
  typedBufferBytes?: number;
  count?: number;
}
export interface ComputeStage {
  stage: string;
  durationMs: number;
  completed: number;
  total: number;
}
export function computeStageName(stage: string) {
  return stage.startsWith("MICE") ? "MICE"
    : stage.startsWith("Parallel analysis") ? "Parallel analysis"
    : stage.startsWith("Resampling stability") ? "Resampling stability"
    : stage.split(" · ")[0];
}
export class WorkerStageTimer {
  private started = performance.now();
  private durations: Record<string, number> = {};
  constructor(private stage: string) {}
  change(stage: string) {
    stage = computeStageName(stage);
    if (stage === this.stage) return;
    this.flush(); this.stage = stage;
  }
  private flush() {
    const now = performance.now();
    // Stage names come only from numerical engine labels, never source data.
    const key = Object.keys(this.durations).length < 127 || this.stage in this.durations ? this.stage : "Other stages";
    this.durations[key] = (this.durations[key] ?? 0) + now - this.started;
    this.started = now;
  }
  finish() { this.flush(); return this.durations; }
}
export interface ComputeReport {
  schema: "scatter-compute/1";
  jobId: string;
  startedAt: string;
  elapsedMs: number;
  status: "running" | "completed" | "failed" | "cancelled";
  publication: "not-requested" | "pending" | "accepted" | "discarded";
  backend: "browser-cpu";
  precision: "float64";
  context: {
    operation?: string;
    items?: number;
    eligibleRows?: number;
    fittingRows?: number;
    factors?: number;
    extraction?: string;
    rotation?: string;
    missing?: string;
    partition?: string;
    inputSha256?: string;
  };
  workersCreated: number;
  activeWorkers: number;
  requests: Record<string, { count: number; roundTripMs: number; workerMs: number; postMessageMs: number }>;
  workerStages: Record<string, number>;
  transport: { sentTypedBufferBytes: number; receivedTypedBufferBytes: number; description: string };
  numerical?: {
    extraction: EfaResult["extraction"]["convergence"];
    rotation: EfaResult["rotation"]["convergence"];
    boundaryItems: number;
    conditionNumber: number;
    residualRms: number;
    inferenceEstimatedBytes?: number;
  };
  stages: ComputeStage[];
  events: ComputeEvent[];
  droppedEvents: number;
  droppedStages: number;
}

const EVENT_LIMIT = 512;
const STAGE_LIMIT = 128;

/** Monotonic timings; wall clock is recorded only for the report's start. */
export class ComputeTrace {
  private origin: number;
  private ended?: number;
  private sequence = 0;
  private stageStart: number;
  private currentStage?: ComputeStage;
  private report: ComputeReport;
  constructor(jobId: string, private clock = () => performance.now()) {
    this.origin = this.stageStart = clock();
    this.report = {
      schema: "scatter-compute/1", jobId, startedAt: new Date().toISOString(),
      elapsedMs: 0, status: "running", publication: "not-requested",
      backend: "browser-cpu", precision: "float64", context: {},
      workersCreated: 0, activeWorkers: 0, requests: {}, workerStages: {},
      transport: {
        sentTypedBufferBytes: 0, receivedTypedBufferBytes: 0,
        description: "Cumulative typed-array payload bytes copied or transferred by messages; excludes ordinary arrays/objects. Not resident or peak memory. Round-trip time includes queuing and communication; postMessage time is measured on the sender.",
      },
      stages: [], events: [], droppedEvents: 0, droppedStages: 0,
    };
    this.event("job", "started");
    this.progress({ stage: "Preparing", completed: 0, total: 1 });
  }
  event(kind: ComputeEvent["kind"], action: string, values: Partial<Omit<ComputeEvent, "sequence" | "elapsedMs" | "kind" | "action">> = {}) {
    this.report.events.push({ sequence: ++this.sequence, elapsedMs: this.clock() - this.origin, kind, action, ...values });
    if (this.report.events.length > EVENT_LIMIT) {
      this.report.events.shift();
      this.report.droppedEvents++;
    }
  }
  spec(spec: EfaSpec, rows: number, operation?: string) {
    const known = (value: string, choices: string[]) => choices.includes(value) ? value : "invalid";
    Object.assign(this.report.context, {
      operation, items: spec.items.length, eligibleRows: rows, factors: spec.nFactors,
      extraction: known(spec.extraction ?? "minres", ["minres", "dwls", "wlsmv"]),
      rotation: known(spec.rotation, ["oblimin", "promax", "varimax"]),
      missing: known(spec.missing, ["pairwise", "complete"]),
      partition: known(spec.sample.partition, ["all", "development", "holdout"]),
    });
  }
  prepared(rows: number, items: number, fingerprint?: string) {
    Object.assign(this.report.context, { fittingRows: rows, items, inputSha256: fingerprint });
  }
  operation(operation: string) { this.report.context.operation = operation; }
  worker(created: boolean, worker: number) {
    if (created) this.report.workersCreated++;
    this.report.activeWorkers += created ? 1 : -1;
    this.event("worker", created ? "created" : "terminated", { worker });
  }
  sent(bytes: number) { this.report.transport.sentTypedBufferBytes += bytes; }
  received(bytes: number) { this.report.transport.receivedTypedBufferBytes += bytes; }
  workerTiming(stages: Record<string, number>) {
    for (const [stage, ms] of Object.entries(stages)) {
      const key = Object.keys(this.report.workerStages).length < 127 || stage in this.report.workerStages ? stage : "Other stages";
      this.report.workerStages[key] = (this.report.workerStages[key] ?? 0) + ms;
    }
  }
  request(op: string, roundTripMs: number, workerMs: number, postMessageMs: number) {
    const r = this.report.requests[op] ??= { count: 0, roundTripMs: 0, workerMs: 0, postMessageMs: 0 };
    r.count++; r.roundTripMs += roundTripMs; r.workerMs += workerMs; r.postMessageMs += postMessageMs;
  }
  progress(progress: EfaProgress) {
    if (this.ended !== undefined) return;
    const stage = computeStageName(progress.stage);
    progress = { ...progress, stage };
    const now = this.clock();
    if (this.currentStage?.stage !== progress.stage) {
      this.closeStage(now);
      this.currentStage = { ...progress, durationMs: 0 };
      this.stageStart = now;
      this.event("stage", progress.stage);
    } else Object.assign(this.currentStage, progress);
  }
  private closeStage(now: number) {
    if (!this.currentStage) return;
    this.report.stages.push({ ...this.currentStage, durationMs: now - this.stageStart });
    if (this.report.stages.length > STAGE_LIMIT) {
      this.report.stages.shift(); this.report.droppedStages++;
    }
    this.currentStage = undefined;
  }
  numerical(result: EfaResult) {
    const convergence = (value: EfaResult["extraction"]["convergence"]) => ({
      converged: value.converged, iterations: value.iterations,
      objective: value.objective, gradient: value.gradient,
      ...(value.maxIterations === undefined ? {} : { maxIterations: value.maxIterations }),
    });
    this.report.numerical = {
      extraction: convergence(result.extraction.convergence), rotation: convergence(result.rotation.convergence),
      boundaryItems: result.extraction.boundaryItems.length,
      conditionNumber: result.conditionNumber, residualRms: result.rmsr,
      inferenceEstimatedBytes: result.weighted?.robust?.plan.estimatedBytes,
    };
  }
  finish(status: ComputeReport["status"]) {
    if (this.ended !== undefined) return;
    this.ended = this.clock();
    this.closeStage(this.ended);
    this.report.status = status;
    this.event("job", status);
  }
  publication(value: ComputeReport["publication"]) {
    this.report.publication = value;
    this.event("publication", value);
  }
  snapshot(): ComputeReport {
    const now = this.ended ?? this.clock();
    return structuredClone({ ...this.report, elapsedMs: now - this.origin,
      stages: this.currentStage
        ? [...this.report.stages, { ...this.currentStage, durationMs: now - this.stageStart }]
        : this.report.stages,
    });
  }
}
