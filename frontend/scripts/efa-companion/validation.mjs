import { setImmediate } from 'node:timers/promises';
export const MAX_SOURCE = 512 * 1024 ** 2;
export async function validateSource(bytes, live) {
  if (bytes.length < 24 || bytes.readUInt32LE(0) !== 0x45464132) throw new Error('source');
  const [n, cells, pairs, q, entries] = [4, 8, 12, 16, 20].map(i => bytes.readUInt32LE(i)), p = cells / n;
  if (n < 3 || n > 1000000 || !Number.isInteger(p) || p < 3 || p > 500 || pairs !== p * (p - 1) / 2 || q < 1 || q > pairs || entries < pairs * 4 || bytes.length !== 24 + cells * 2 + pairs * 16 + entries * 8 + n * q * 8) throw new Error('source');
  const max = new Uint32Array(p);
  for (let i = 0; i < cells; i++) {
    const code = bytes.readUInt16LE(24 + i * 2);
    if (code !== 65535) max[Math.floor(i / n)] = Math.max(max[Math.floor(i / n)], code);
    if (i % 1000000 === 0) { await setImmediate(); if (!live()) throw new Error('cancelled'); }
  }
  const meta = 24 + cells * 2;
  let previous = 0, index = 0;
  for (let i = 0; i < p; i++) for (let j = i + 1; j < p; j++, index++) {
    const at = meta + index * 16, a = bytes.readUInt32LE(at), b = bytes.readUInt32LE(at + 4), columns = bytes.readUInt32LE(at + 8), offset = bytes.readUInt32LE(at + 12);
    const end = index + 1 < pairs ? bytes.readUInt32LE(at + 28) : entries;
    if (a !== i * n || b !== j * n || columns < 2 || columns > 65535 || max[j] >= columns || offset !== previous || end <= offset || (end - offset) % columns || max[i] >= (end - offset) / columns) throw new Error('source');
    previous = end;
  }
  for (let at = meta + pairs * 16, i = 0; at < bytes.length; at += 8, i++) {
    if (!Number.isFinite(bytes.readDoubleLE(at))) throw new Error('source');
    if (i % 1000000 === 0) { await setImmediate(); if (!live()) throw new Error('cancelled'); }
  }
  return n;
}
export function validateRange(bytes, rows) {
  if (bytes.length !== 20 || bytes.readUInt32LE(0) !== 0x45464133 || !rows) throw new Error('range');
  const [left, right, n, m] = [4, 8, 12, 16].map(i => bytes.readUInt32LE(i));
  if (!n || !m || n > 256 || m > 256 || left + n > rows || right + m > rows) throw new Error('range');
  return 24 + n * m * 8;
}
