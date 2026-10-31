import type { DataTable } from "../table";
import { prepareEfa } from "./prepare";
import { polychoric } from "./correlation";
import { fitEfa, scoreEfa } from "./fit";
import { parallelAnalysis } from "./parallel";
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
      op: "prepare";
      table: DataTable;
      spec: EfaSpec;
      rows: number[];
    }
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
      const meta = new TextEncoder().encode(
        JSON.stringify({
          items: prepared.items,
          rows: prepared.rows,
          originalRowCount: prepared.originalRowCount,
        }),
      );
      const bytes = new Uint8Array(
        meta.byteLength +
          prepared.codes.byteLength +
          prepared.observed.byteLength,
      );
      bytes.set(meta);
      bytes.set(new Uint8Array(prepared.codes.buffer), meta.byteLength);
      bytes.set(prepared.observed, meta.byteLength + prepared.codes.byteLength);
      prepared.fingerprint = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
      value = prepared;
    } else if (request.op === "initialize") {
      prepared = request.data;
      value = true;
    } else {
      if (!prepared)
        throw new EfaError("worker", "Worker has not been prepared.");
      switch (request.op) {
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
