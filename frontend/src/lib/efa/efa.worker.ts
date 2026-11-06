import { createEstimatedBackend } from "./backends/estimated";
import type { FitInvariant } from "./fit-cache";
import { createBackend } from "./backends/runtime";
import { computeSettings, type CompanionSession, type EfaExecution } from "./backends/types";
import { weightedInference, weightedInferenceWithKernel, weightedInferenceWithEstimator } from "./weighted-inference";
import type { DataTable } from "../table";
import { prepareEfa } from "./prepare";
import { estimatePair } from "./correlation";
import { fitEfa, fitEfaSteps, scoreEfa, type FitRotationTask, type FitTask, type FitContinuation } from "./fit";
import {
  parallelAnalysis,
  parallelObserved,
  parallelReplicate,
} from "./parallel";
import { fitImputationChain, observedPairFloor, imputationFitData } from "./imputation-analysis";
import { fingerprintPrepared } from "./fingerprint";
import { WorkerStageTimer } from "./telemetry";
import type { MiceOptions } from "./mice";
import {
  stabilityReplicate,
  type StabilityOptions,
  type FactorReference,
} from "./stability";
import {
  EfaError,
  type EfaPreparedData,
  type EfaSpec,
  type EfaCorrelations,
  type EfaExtraction,
  type EfaResult,
} from "./types";

import { RotationDerivativeAccumulator, rotationDerivativeBatch, type RotationDerivativeContext, type RotationDerivativeBatch } from "./weighted-rotation";

export type WorkerRequest =
  | { id: number; op: "rotation-initialize"; context: RotationDerivativeContext }
  | { id: number; op: "rotation-batch"; start: number; count: number }
  | { id: number; op: "rotation-accept"; batch: RotationDerivativeBatch }
  | { id: number; op: "fit-finish" }
  | { id: number; op: "fit-cache" }
  | {
      id: number;
      op: "imputation";
      spec: EfaSpec;
      options: MiceOptions;
      index: number;
    }
  | {
      id: number;
      op: "stability";
      spec: EfaSpec;
      reference: FactorReference;
      options: StabilityOptions;
      index: number;
    }
  | { id: number; op: "parallel-observed"; minimumPairN: number }
  | { id: number; op: "parallel-replicate"; seed: number }
  | {
      id: number;
      op: "prepare";
      table: DataTable;
      spec: EfaSpec;
      rows: number[];
    }
  | { id: number; op: "observed-support" }
  | { id: number; op: "initialize"; data: EfaPreparedData }
  | { id: number; op: "pairs"; pairs: [number, number][] }
  | {
      id: number;
      op: "fit";
      correlation: EfaCorrelations;
      spec: EfaSpec;
      extraction?: EfaExtraction;
      invariant?: FitInvariant;
      parallelDerivatives?: boolean;
      companion?: CompanionSession;
    }
  | { id: number; op: "score"; result: EfaResult }
  | {
      id: number;
      op: "parallel";
      seed: number;
      replicates: number;
      minimumPairN?: number;
    };
let prepared: EfaPreparedData | undefined;
let rotationContext: RotationDerivativeContext | undefined;
let continuation: Generator<FitTask, EfaResult, FitContinuation> | undefined;
let rotationTask: FitRotationTask | undefined;
let accumulator: RotationDerivativeAccumulator | undefined;
let execution: EfaExecution | undefined;
let invariant: FitInvariant | undefined;
let cachedInference: ReturnType<typeof weightedInference> | undefined;
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data,
    id = request.id,
    started = performance.now();
  const timer = new WorkerStageTimer(request.op === "pairs" ? "Correlations" : request.op);
  const progress = (value: { stage: string; completed: number; total: number }) => {
    timer.change(value.stage);
    self.postMessage({ id, progress: value });
  };
  try {
    let value: unknown;
    if (request.op === "fit-cache") {
      if (!invariant || !cachedInference || continuation) throw new EfaError("worker", "No completed invariant fit state.");
      const q = cachedInference.covariance.rows, covariance = new Float64Array(q * q);
      for (let i = 0; i < q; i++) for (let j = 0; j < q; j++) covariance[i * q + j] = cachedInference.covariance.get(i, j);
      value = { ...invariant, execution, inference: { ...cachedInference, covariance } };
      invariant = undefined; cachedInference = undefined;
    } else if (request.op === "rotation-initialize") {
      prepared = undefined;
      rotationContext = request.context;
      value = true;
    } else if (request.op === "rotation-batch") {
      if (!rotationContext) throw new EfaError("worker", "Rotation worker has not been initialized.");
      value = rotationDerivativeBatch(rotationContext, request.start, request.count);
    } else if (request.op === "rotation-accept") {
      if (!accumulator) throw new EfaError("worker", "No pending rotation uncertainty.");
      accumulator.add(request.batch);
      value = accumulator.completed;
    } else if (request.op === "fit-finish") {
      if (!continuation || !rotationTask || !accumulator) throw new EfaError("worker", "No pending fit continuation.");
      const done = continuation.next(accumulator.finish(rotationTask.covariance, progress));
      if (!done.done) throw new EfaError("worker", "Unexpected additional fit continuation.");
      if (execution) done.value.provenance.execution = execution;
      value = done.value;
      continuation = undefined; rotationTask = undefined; accumulator = undefined; rotationContext = undefined;
    } else if (request.op === "prepare") {
      prepared = prepareEfa(request.table, request.spec, request.rows);
      prepared.fingerprint = await fingerprintPrepared(prepared);
      value = prepared;
    } else if (request.op === "initialize") {
      prepared = request.data;
      value = true;
    } else {
      if (!prepared)
        throw new EfaError("worker", "Worker has not been prepared.");
      switch (request.op) {
        case "observed-support":
          value = observedPairFloor(prepared);
          break;
        case "imputation": {
          const chain = fitImputationChain(
            prepared,
            request.spec,
            request.options,
            request.index,
            progress,
          );
          if (chain.fit) {
            const codes = prepared.codes.slice();
            let position = 0;
            for (let i = 0; i < codes.length; i++)
              if (!prepared.observed[i])
                codes[i] = chain.fit.replacements[position++];
            chain.fit.result.provenance.inputSha256 = await fingerprintPrepared(
              imputationFitData({
                ...prepared,
                codes,
                observed: new Uint8Array(codes.length).fill(1),
              }, request.spec),
            );
          }
          value = chain;
          break;
        }
        case "stability":
          value = stabilityReplicate(
            prepared,
            request.spec,
            request.reference,
            request.options,
            request.index,
            undefined,
            progress,
          );
          break;
        case "parallel-observed":
          value = parallelObserved(prepared, request.minimumPairN, progress);
          break;
        case "parallel-replicate":
          value = parallelReplicate(prepared, request.seed, progress);
          break;
        case "pairs":
          value = request.pairs.map(([i, j]) => estimatePair(prepared!, i, j));
          break;
        case "fit":
          if (request.parallelDerivatives && request.spec.extraction === "wlsmv") {
            invariant = undefined; cachedInference = undefined;
            continuation = fitEfaSteps(prepared, request.correlation, request.spec, progress, request.extraction, request.invariant, base => { invariant = base; });
            const settings = computeSettings(request.spec);
            const estimated = !request.invariant && settings.correction === "estimated" ? await createEstimatedBackend(request.spec,
              value => { execution = value; self.postMessage({ id, execution: value }); }, progress) : undefined;
            const backend = !estimated && !request.invariant && settings.backend !== "cpu" ? await createBackend(request.spec, request.companion,
              value => { execution = value; self.postMessage({ id, execution: value }); }, progress) : undefined;
            execution = request.invariant?.execution
              ? { ...request.invariant.execution, reusedFromJobId: request.invariant.sourceJobId, timings: undefined }
              : backend || estimated ? execution : { backend: settings.backend, blockSize: settings.blockSize, budgetBytes: settings.budgetBytes, state: "running", precision: "float64" };
            if (request.invariant) self.postMessage({ id, execution });
            let step;
            try {
              step = continuation.next();
              if (!request.invariant) {
                if (step.done || step.value.kind !== "inference") throw new EfaError("worker", "Missing weighted inference task.");
                const inference = estimated ? await weightedInferenceWithEstimator(task => estimated.estimate(task), ...step.value.args) : backend ? await weightedInferenceWithKernel(block => backend.run(block), ...step.value.args) : weightedInference(...step.value.args);
                cachedInference = inference;
                if (estimated) execution = estimated.finish();
                else if (backend) execution = backend.finish();
                else if (execution) execution.state = "completed";
                step = continuation.next(inference);
              }
            } finally { backend?.destroy(); estimated?.destroy(); }
            if (step.done || step.value.kind !== "rotation") throw new EfaError("worker", "Missing weighted rotation task.");
            rotationTask = step.value;
            rotationContext = rotationTask.context;
            accumulator = new RotationDerivativeAccumulator(rotationContext);
            value = { rotationContext };
          } else value = fitEfa(prepared, request.correlation, request.spec, progress, request.extraction);
          break;
        case "score":
          if (prepared.fingerprint !== request.result.provenance.inputSha256)
            throw new EfaError(
              "changed-data",
              "The selected responses or row membership changed since this fit. Refit before adding scores.",
            );
          value = scoreEfa(prepared, request.result);
          break;
        case "parallel":
          value = parallelAnalysis(
            prepared,
            request.seed,
            request.replicates,
            progress,
            request.minimumPairN,
          );
          break;
      }
    }
    self.postMessage({ id, value, workerMs: performance.now() - started, workerStages: timer.finish() },
      { transfer: request.op === "fit-cache" ? [(value as FitInvariant).inference!.covariance.buffer as ArrayBuffer] : request.op === "rotation-batch" ? [(value as RotationDerivativeBatch).values.buffer as ArrayBuffer] : [] });
  } catch (error) {
    continuation = undefined; rotationTask = undefined; accumulator = undefined; rotationContext = undefined; invariant = undefined; cachedInference = undefined;
    self.postMessage({
      id,
      workerMs: performance.now() - started,
      workerStages: timer.finish(),
      error: {
        code: error instanceof EfaError ? error.code : "worker",
        message: error instanceof Error ? error.message : String(error),
        diagnostics: error instanceof EfaError ? error.diagnostics : [],
      },
    });
  }
};
