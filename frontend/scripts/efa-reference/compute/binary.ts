import type { OrdinalTraceSource, RobustTraceBlock } from "../../../src/lib/efa/trace-kernel";
export function encodeOrdinalSource(source: OrdinalTraceSource) {
  const cells = source.codes.length, pairs = source.pairs.length, parameters = source.projection[0].length;
  const lookups = source.pairs.reduce((sum, pair) => sum + pair.values.length, 0);
  const size = 24 + cells * 2 + pairs * 16 + lookups * 8 + source.nRows * parameters * 8;
  if (size > 512 * 1024 ** 2) throw new Error("Resident source exceeds the explicit 512 MiB transfer budget");
  const buffer = new ArrayBuffer(size), view = new DataView(buffer);
  [0x45464132, source.nRows, cells, pairs, parameters, lookups].forEach((v, i) => view.setUint32(i * 4, v, true));
  let at = 24;
  for (let i = 0; i < cells; i++, at += 2) view.setUint16(at, source.observed[i] ? source.codes[i] : 65535, true);
  let lookup = 0;
  for (const pair of source.pairs) {
    for (const v of [pair.i * source.nRows, pair.j * source.nRows, pair.columns, lookup]) { view.setUint32(at, v, true); at += 4; }
    lookup += pair.values.length;
  }
  for (let i = 0; i < pairs; i++) for (const value of source.pairs[i].values) { view.setFloat64(at, value * source.rootWeights[i], true); at += 8; }
  for (const row of source.projection) for (const value of row) { view.setFloat64(at, value, true); at += 8; }
  return buffer;
}
export function encodeOrdinalRange(block: RobustTraceBlock) {
  if (!block.ordinal) throw new Error("Resident kernel requires an ordinal source");
  const { leftStart, rightStart, leftRows, rightRows } = block.ordinal;
  const bytes = new ArrayBuffer(20), view = new DataView(bytes);
  [0x45464133, leftStart, rightStart, leftRows, rightRows].forEach((v, i) => view.setUint32(i * 4, v, true));
  return bytes;
}
export function encodeBlock(block: RobustTraceBlock) {
  const rows = block.left.length, cols = block.right.length, pairs = block.left[0].length, parameters = block.leftProjection[0].length;
  const buffer = new ArrayBuffer(24 + 8 * (rows + cols) * (pairs + parameters));
  const header = new DataView(buffer);
  [0x45464131, rows, cols, pairs, parameters, Number(block.diagonal)].forEach((value, i) => header.setUint32(i * 4, value, true));
  let offset = 24;
  for (const matrix of [block.left, block.right, block.leftProjection, block.rightProjection])
    for (const row of matrix) for (const value of row) { header.setFloat64(offset, value, true); offset += 8; }
  return buffer;
}
export function decodeBlock(buffer: ArrayBuffer): RobustTraceBlock {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x45464131) throw new Error("Invalid fixture header");
  const [rows, cols, pairs, parameters, diagonal] = Array.from({ length: 5 }, (_, i) => view.getUint32(4 + i * 4, true));
  if (!rows || !cols || rows > 128 || cols > 128 || !pairs || !parameters || buffer.byteLength !== 24 + 8 * (rows + cols) * (pairs + parameters)) throw new Error("Invalid fixture dimensions");
  let offset = 24;
  const matrix = (n: number, width: number) => Array.from({ length: n }, () => {
    const row = new Float64Array(width);
    for (let k = 0; k < width; k++) { row[k] = view.getFloat64(offset, true); offset += 8; }
    return row;
  });
  return { left: matrix(rows, pairs), right: matrix(cols, pairs), leftProjection: matrix(rows, parameters), rightProjection: matrix(cols, parameters), diagonal: !!diagonal };
}
export function difference(block: RobustTraceBlock, reference: Float64Array, actual: Float64Array, tolerance = 1e-5) {
  if (reference.length !== actual.length) throw new Error("Output shape mismatch");
  let maxAbs = 0, maxScaled = 0, failures = 0;
  for (let a = 0; a < block.left.length; a++) for (let b = 0; b < block.right.length; b++) {
    if (block.diagonal && b > a) continue;
    const i = a * block.right.length + b;
    const error = Math.abs(actual[i] - reference[i]);
    const scaled = error / Math.max(1, Math.abs(reference[i]));
    maxAbs = Math.max(maxAbs, error); maxScaled = Math.max(maxScaled, scaled);
    if (!Number.isFinite(actual[i]) || scaled > tolerance) failures++;
  }
  return { maxAbs, maxScaled, failures, tolerance, passed: failures === 0 };
}
