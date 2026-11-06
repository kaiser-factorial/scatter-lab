import type { PairInfluence } from "./weighted-moments";

export interface OrdinalTraceSource {
  nRows: number;
  codes: Uint16Array;
  observed: Uint8Array;
  pairs: PairInfluence[];
  rootWeights: Float64Array;
  projection: Float64Array[];
}

/** Bounded case-space product used by exact WLSMV trace corrections.
 * Inputs are read-only. A backend must return row-major H = A B' - ZA ZB'. */
export interface RobustTraceBlock {
  left: Float64Array[];
  right: Float64Array[];
  leftProjection: Float64Array[];
  rightProjection: Float64Array[];
  diagonal: boolean;
  /** Resident accelerated backends consume row ranges and never evaluate the
   * lazy left/right matrices. Production CPU still uses the same matrix loop. */
  ordinal?: {
    source: OrdinalTraceSource;
    leftStart: number;
    rightStart: number;
    leftRows: number;
    rightRows: number;
  };
}
export type TraceKernel = (block: RobustTraceBlock) => Promise<Float64Array>;

/** Original compensated Float64 loop, preserved as the qualified baseline. */
export function cpuTraceBlock(block: RobustTraceBlock): Float64Array {
  const { left, right, leftProjection, rightProjection, diagonal } = block;
  const output = new Float64Array(left.length * right.length);
  for (let a = 0; a < left.length; a++)
    for (let b = 0; b < right.length; b++) {
      if (diagonal && b > a) continue;
      let h = 0, correction = 0;
      for (let pair = 0; pair < left[a].length; pair++) {
        const term = left[a][pair] * right[b][pair] - correction,
          sum = h + term;
        correction = sum - h - term;
        h = sum;
      }
      for (let v = 0; v < leftProjection[a].length; v++)
        h -= leftProjection[a][v] * rightProjection[b][v];
      output[a * right.length + b] = h;
    }
  return output;
}
