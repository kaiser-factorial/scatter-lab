import type { OrdinalTraceSource, RobustTraceBlock } from "../trace-kernel";
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

export const SOURCE_CHUNK_BYTES = 4 * 1024 ** 2;
export function ordinalSourceSize(source: OrdinalTraceSource) {
  const lookups = source.pairs.reduce((sum, pair) => sum + pair.values.length, 0);
  const size = 24 + source.codes.length * 2 + source.pairs.length * 16 + lookups * 8 + source.nRows * source.projection[0].length * 8;
  if (size > 512 * 1024 ** 2) throw new Error("Resident source exceeds the explicit 512 MiB transfer budget");
  return size;
}
/** Stream the unchanged binary representation. A browser fetch never receives
 * the entire resident source, avoiding repeated half-gigabyte body copies. */
export function* ordinalSourceChunks(source: OrdinalTraceSource, chunkBytes = SOURCE_CHUNK_BYTES): Generator<ArrayBuffer> {
  ordinalSourceSize(source);
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 24 || chunkBytes % 16 || chunkBytes > SOURCE_CHUNK_BYTES) throw new Error("Invalid source chunk size");
  const header = new ArrayBuffer(24), h = new DataView(header);
  [0x45464132, source.nRows, source.codes.length, source.pairs.length, source.projection[0].length, source.pairs.reduce((sum, pair) => sum + pair.values.length, 0)].forEach((v, i) => h.setUint32(i * 4, v, true));
  yield header;
  for (let start = 0; start < source.codes.length; start += chunkBytes / 2) {
    const count = Math.min(chunkBytes / 2, source.codes.length - start), bytes = new ArrayBuffer(count * 2), view = new DataView(bytes);
    for (let i = 0; i < count; i++) view.setUint16(i * 2, source.observed[start + i] ? source.codes[start + i] : 65535, true);
    yield bytes;
  }
  let lookup = 0;
  for (let start = 0; start < source.pairs.length; start += chunkBytes / 16) {
    const count = Math.min(chunkBytes / 16, source.pairs.length - start), bytes = new ArrayBuffer(count * 16), view = new DataView(bytes);
    for (let i = 0; i < count; i++) {
      const pair = source.pairs[start + i];
      [pair.i * source.nRows, pair.j * source.nRows, pair.columns, lookup].forEach((v, j) => view.setUint32(i * 16 + j * 4, v, true));
      lookup += pair.values.length;
    }
    yield bytes;
  }
  let bytes = new ArrayBuffer(chunkBytes), view = new DataView(bytes), at = 0;
  for (let i = 0; i < source.pairs.length; i++) for (const value of source.pairs[i].values) {
    view.setFloat64(at, value * source.rootWeights[i], true); at += 8;
    if (at === chunkBytes) { yield bytes; bytes = new ArrayBuffer(chunkBytes); view = new DataView(bytes); at = 0; }
  }
  for (const row of source.projection) for (const value of row) {
    view.setFloat64(at, value, true); at += 8;
    if (at === chunkBytes) { yield bytes; bytes = new ArrayBuffer(chunkBytes); view = new DataView(bytes); at = 0; }
  }
  if (at) yield bytes.slice(0, at);
}
