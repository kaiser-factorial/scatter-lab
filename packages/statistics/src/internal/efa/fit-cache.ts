import type { EfaExtraction, EfaResult } from "./types";
import type { EfaExecution } from "./backends/types";
import type { IdentifiedLoadings, InferencePlan, WeightedTest } from "./weighted-inference";

/** Rotation-independent state only. No respondent projections or GPU buffers.
 * Ephemeral: this potentially large covariance never enters a workspace. */
export interface FitInvariant {
  extraction: EfaExtraction;
  weighted: Omit<NonNullable<EfaResult["weighted"]>, "robust">;
  inference?: {
    identified: IdentifiedLoadings;
    covariance: Float64Array;
    test: WeightedTest;
    plan: InferencePlan;
  };
  execution?: EfaExecution;
  sourceJobId?: string;
}

/** A global byte/entry bound, including metadata; keys contain revision IDs,
 * not tables, so this cache does not keep source datasets alive. */
export class FitInvariantCache {
  private entries = new Map<string, { value: FitInvariant; bytes: number }>();
  private bytes = 0;
  constructor(private budget = 128 * 1024 ** 2, private limit = 2) {}
  acceptsCovariance(parameters: number) { return parameters * parameters * 8 <= this.budget && this.limit > 0; }
  get(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value;
  }
  put(key: string, value: FitInvariant) {
    const { inference, ...rest } = value;
    const { covariance, ...metadata } = inference ?? {};
    // Conservative UTF-16 metadata allowance plus the packed Float64 matrix.
    const bytes = 2 * JSON.stringify({ ...rest, inference: metadata }).length + (covariance?.byteLength ?? 0);
    if (bytes > this.budget || this.limit < 1) return false;
    const previous = this.entries.get(key);
    if (previous) { this.bytes -= previous.bytes; this.entries.delete(key); }
    while (this.entries.size >= this.limit || this.bytes + bytes > this.budget) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes; this.entries.delete(oldest);
    }
    this.entries.set(key, { value, bytes }); this.bytes += bytes;
    return true;
  }
}
