// A deterministic kernel workload, not a fitted factor model. Use it to compare
// allocation/thread/transport changes after the complete baseline fits. The
// independent R fixtures still qualify the surrounding inference pipeline.
export function residentFixture({ rows = 20000, items = 500, factors = 5, seed = 20261101 } = {}) {
  if (!Number.isSafeInteger(rows) || rows < 512 || !Number.isSafeInteger(items) || items < 8 || !Number.isSafeInteger(factors) || factors < 1 || factors >= items) throw new Error('Invalid resident fixture shape');
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6D2B79F5) | 0;
    let t = state;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  const codes = new Uint16Array(rows * items), observed = new Uint8Array(rows * items);
  for (let i = 0; i < codes.length; i++) {
    codes[i] = Math.floor(random() * 5);
    observed[i] = random() >= 0.025 ? 1 : 0;
  }
  const pairs = [];
  for (let i = 0; i < items; i++) for (let j = i + 1; j < items; j++) pairs.push({
    i, j, columns: 5, values: Float64Array.from({ length: 25 }, () => (random() - 0.5) * 2),
  });
  const rootWeights = Float64Array.from({ length: pairs.length }, () => (0.5 + random()) / Math.sqrt(rows));
  const parameters = items * factors - factors * (factors - 1) / 2;
  const projection = Array.from({ length: rows }, () => Float64Array.from({ length: parameters }, () => (random() - 0.5) / Math.sqrt(rows)));
  const source = { nRows: rows, codes, observed, pairs, rootWeights, projection };
  const ranges = [
    [0, 0, 128, 128], [128, 0, 128, 128], [128, 128, 128, 128],
    [128, 256, 128, 128], [128, 384, 128, 128], [256, 0, 128, 128],
    [rows - 31, rows - 128, 31, 128], [rows - 31, rows - 31, 31, 31],
    // Revisit full blocks after ragged buffers to expose stale tails or strides.
    [128, 0, 128, 128], [0, 128, 128, 128],
  ];
  const materialize = (start, count) => Array.from({ length: count }, (_, offset) => Float64Array.from(pairs, (pair, index) => {
    const x = pair.i * rows + start + offset, y = pair.j * rows + start + offset;
    return observed[x] && observed[y] ? pair.values[codes[x] * pair.columns + codes[y]] * rootWeights[index] : 0;
  }));
  return {
    source,
    manifest: { schema: 1, seed, rows, items, factors, pairs: pairs.length, parameters, categories: 5, missingProbability: 0.025, ranges, scope: 'Synthetic ordinal-source kernel inputs with arbitrary influence lookups and projections; not a fitted EFA model or an independent R reference.' },
    blocks: ranges.map(([leftStart, rightStart, leftRows, rightRows]) => ({
      get left() { return materialize(leftStart, leftRows); },
      get right() { return materialize(rightStart, rightRows); },
      leftProjection: projection.slice(leftStart, leftStart + leftRows),
      rightProjection: projection.slice(rightStart, rightStart + rightRows),
      diagonal: leftStart === rightStart && leftRows === rightRows,
      ordinal: { source, leftStart, rightStart, leftRows, rightRows },
    })),
  };
}
