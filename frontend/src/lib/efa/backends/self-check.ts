import { cpuTraceBlock, type OrdinalTraceSource, type RobustTraceBlock, type TraceKernel } from "../trace-kernel";
import { EfaError } from "../types";
import type { KernelSelfCheck } from "./types";

/** Public, deterministic synthetic inputs only. Covers missing cells, mixed
 * categories, multiple dot chunks, nonzero offsets, tails and cancellation. */
export function checkSource(items: number, rows: number): OrdinalTraceSource {
  const codes = new Uint16Array(items * rows), observed = new Uint8Array(codes.length);
  for (let j = 0; j < items; j++) for (let r = 0; r < rows; r++) {
    codes[j * rows + r] = (r * 7 + j * 3 + Math.floor(r / 3)) % (2 + j % 4);
    observed[j * rows + r] = (r * 11 + j) % 17 ? 1 : 0;
  }
  const pairs: OrdinalTraceSource["pairs"] = [];
  for (let i = 0; i < items; i++) for (let j = i + 1; j < items; j++) pairs.push({
    i, j, n: rows, columns: 2 + j % 4, variance: 1,
    values: Float64Array.from({ length: (2 + i % 4) * (2 + j % 4) }, (_, c) => Math.sin(c + i * .4 - j) * (1 + (i + j) % 7)),
  });
  return { nRows: rows, codes, observed, pairs,
    rootWeights: Float64Array.from(pairs, (_, i) => .2 + (i % 13) / 7),
    projection: Array.from({ length: rows }, (_, r) => Float64Array.from({ length: 11 }, (_, q) => Math.cos(r * .3 + q) * 3)),
  };
}
export function checkBlock(source: OrdinalTraceSource, leftStart: number, rightStart: number, leftRows: number, rightRows: number): RobustTraceBlock {
  const panel = (start: number, rows: number) => Array.from({ length: rows }, (_, r) => Float64Array.from(source.pairs, (pair, index) => {
    const a = pair.i * source.nRows + start + r, b = pair.j * source.nRows + start + r;
    return source.observed[a] && source.observed[b] ? pair.values[source.codes[a] * pair.columns + source.codes[b]] * source.rootWeights[index] : 0;
  }));
  return { left: panel(leftStart, leftRows), right: panel(rightStart, rightRows),
    leftProjection: source.projection.slice(leftStart, leftStart + leftRows), rightProjection: source.projection.slice(rightStart, rightStart + rightRows),
    diagonal: leftStart === rightStart, ordinal: { source, leftStart, rightStart, leftRows, rightRows } };
}
export async function numericalSelfCheck(kernel: TraceKernel, blockSize: number, progress?: (completed: number, total: number) => void): Promise<KernelSelfCheck> {
  const start = performance.now(), wide = checkSource(64, 19), tall = checkSource(8, blockSize + 3);
  const blocks = [checkBlock(wide, 0, 0, 17, 17), checkBlock(wide, 3, 1, 16, 9),
    checkBlock(tall, 0, 0, blockSize, blockSize), checkBlock(tall, 3, 0, blockSize, blockSize),
    checkBlock(tall, blockSize, 1, 3, 7)];
  let maxScaledError = 0, checks = 0;
  for (const block of blocks) {
    const expected = cpuTraceBlock(block), actual = await kernel(block);
    if (actual.length !== expected.length) throw new EfaError("backend-self-check", "Backend self-check failed: wrong output shape. No analysis was run on this backend.");
    for (let i = 0; i < expected.length; i++) {
      if (block.diagonal && i % block.right.length > Math.floor(i / block.right.length)) continue;
      const error = Math.abs(actual[i] - expected[i]) / Math.max(1, Math.abs(expected[i]));
      if (!Number.isFinite(error) || error > 1e-10) throw new EfaError("backend-self-check", "Backend self-check failed the 1e-10 numerical tolerance. No analysis was run on this backend.");
      maxScaledError = Math.max(maxScaledError, error); checks++;
    }
    progress?.(blocks.indexOf(block) + 1, blocks.length);
  }
  return { version: "ordinal-trace/1", passed: true, checks, tolerance: 1e-10, maxScaledError, elapsedMs: performance.now() - start };
}
