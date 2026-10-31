import type { DataTable } from "../table";
import { prepareEfa } from "./prepare";
import { polychoric } from "./correlation";
import { fitEfa, scoreEfa } from "./fit";
import {
  parallelAnalysis,
  parallelObserved,
  parallelReplicate,
} from "./parallel";
import { fitImputationChain, observedPairFloor } from "./imputation-analysis";
import { fingerprintPrepared } from "./fingerprint";
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

export type WorkerRequest =
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
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data,
    id = request.id;
  const progress = (value: unknown) =>
    self.postMessage({ id, progress: value });
  try {
    let value: unknown;
    if (request.op === "prepare") {
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
              {
                ...prepared,
                codes,
                observed: new Uint8Array(codes.length).fill(1),
              },
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
          value = request.pairs.map(([i, j]) => polychoric(prepared!, i, j));
          break;
        case "fit":
          value = fitEfa(
            prepared,
            request.correlation,
            request.spec,
            progress,
            request.extraction,
          );
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
    self.postMessage({ id, value });
  } catch (error) {
    self.postMessage({
      id,
      error: {
        code: error instanceof EfaError ? error.code : "worker",
        message: error instanceof Error ? error.message : String(error),
        diagnostics: error instanceof EfaError ? error.diagnostics : [],
      },
    });
  }
};
