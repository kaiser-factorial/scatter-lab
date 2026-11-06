import type { RobustTraceBlock } from "../trace-kernel";
export interface GpuKernel {
  run(block: RobustTraceBlock): Promise<Float64Array>;
  destroy(): void;
  metadata: { shader: string; triangularShader?: string; reductionShader?: string; adapter: { vendor: string; architecture: string; device: string; description: string }; precision: string };
  timings: Record<string, number | null>;
}
export function createGpuKernel(options: { split: boolean; resident: boolean; portable: boolean; reduce: boolean; dotChunkSize: number; signal?: AbortSignal }): Promise<GpuKernel>;
