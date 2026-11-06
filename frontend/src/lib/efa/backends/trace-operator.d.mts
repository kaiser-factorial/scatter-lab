import type { OrdinalTraceSource } from "../trace-kernel";
import type { Progress } from "../types";
export interface TraceOperator {
  metadata: { precision: string; shader: string; reductionShader: string; adapter: { vendor: string; architecture: string } };
  apply(probes: Float64Array, count: number): Promise<{ products: Float64Array; elapsedMs: number; stages: { stage: string; elapsedMs: number; rows: number; cols: number; inner: number }[]; peakOwnedGpuBufferBytes: number }>;
  destroy(): void;
}
export function createTraceOperator(source: OrdinalTraceSource, progress?: Progress): Promise<TraceOperator>;
