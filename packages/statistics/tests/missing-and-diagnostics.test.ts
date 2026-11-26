import { expect, it } from 'vitest';
import { applyColumnImputer, deserializeImputer, fitColumnImputer, imputeOrdinal, serializeImputer } from '../src/missing';
import { analyzeItems } from '../src/diagnostics';
import { dbscan, kmeans } from '../src/cluster';
import type { InputTable } from '../src/data';

it('learns column replacements on the selected training rows and applies them unchanged to holdout', () => {
  const source = { columns: ['x', 'y'], nRows: 4, data: { x: [1, 3, 1000, null], y: [2, 6, 4000, null] } };
  const before = structuredClone(source);
  const model = fitColumnImputer(source, { method: 'mean', rows: [0, 1], measurements: { x: 'continuous', y: 'continuous' } });
  const result = applyColumnImputer(deserializeImputer(serializeImputer(model)), source, { rows: [2, 3] });
  expect(result.table.data).toEqual({ x: [1, 3, 1000, 2], y: [2, 6, 4000, 4] });
  expect(result.filled).toEqual({ x: [false, false, false, true], y: [false, false, false, true] });
  expect(result.filledCells).toBe(2); expect(source).toEqual(before);
});

it('preserves declared categorical median and nearest-category mean rules', () => {
  const source = { columns: ['rating'], nRows: 4, data: { rating: ['low', 'high', null, null] } };
  const common = { orders: { rating: ['low', 'middle', 'high'] }, measurements: { rating: 'ordinal' as const } };
  const median = fitColumnImputer(source, { ...common, method: 'median' });
  const mean = fitColumnImputer(source, { ...common, method: 'mean' });
  expect(applyColumnImputer(median, source).table.data.rating).toEqual(['low', 'high', 'low', 'low']);
  expect(applyColumnImputer(mean, source).table.data.rating).toEqual(['low', 'high', 'middle', 'middle']);
  expect(() => applyColumnImputer(mean, { ...source, data: { rating: ['low', 'new', null, null] } })).toThrow(/measurement scale/);
});

it('treats an explicit numeric order as ordinal and rejects contradictory or malformed declarations', () => {
  const source = { columns: ['a'], nRows: 3, data: { a: [1, 2, null] } };
  for (const measurements of [undefined, { a: 'auto' as const }]) {
    const model = fitColumnImputer(source, { method: 'mean', orders: { a: [1, 2] }, measurements });
    expect(model.replacements[0].kind).toBe('ordinal');
    expect(applyColumnImputer(model, source).table.data.a[2]).toBe(1);
  }
  expect(() => fitColumnImputer(source, { method: 'mean', orders: { a: [1, 2] }, measurements: { a: 'continuous' } })).toThrow(/both continuous/);
  expect(() => fitColumnImputer(source, { method: 'mean', measurements: { a: 'unknown' as 'auto' } })).toThrow(/Invalid measurement/);
  expect(() => fitColumnImputer(source, { method: 'mean', orders: { a: [1, 2, NaN] } })).toThrow(/finite numbers/);
});

it('rejects malformed or empty fitted imputers and undeclared nonnumeric values', () => {
  expect(() => fitColumnImputer({ columns: ['a'], nRows: 2, data: { a: [null, null] } }, { method: 'median' })).toThrow(/no observed/);
  expect(() => fitColumnImputer({ columns: ['a'], nRows: 2, data: { a: ['1', '2'] } }, { method: 'mean' })).toThrow(/explicit ordered/);
  expect(() => deserializeImputer('{"format":"wrong"}')).toThrow(/Invalid/);
  const model = fitColumnImputer({ columns: ['a'], nRows: 3, data: { a: [1, 2, null] } }, { method: 'mean' });
  expect(() => deserializeImputer(JSON.stringify({ ...model, replacements: [{ ...model.replacements[0], value: null }] }))).toThrow(/Invalid/);
  expect(() => applyColumnImputer(model, { columns: ['a'], nRows: 1, data: { a: [null] } }, { rows: [1] })).toThrow(/in-range/);
});

it('returns separate seeded ordinal MICE completions with original observations and source row mapping', () => {
  const source: InputTable = { columns: ['a', 'b'], nRows: 24, data: {
    a: Array.from({ length: 24 }, (_, i) => i === 2 ? null : i % 2),
    b: Array.from({ length: 24 }, (_, i) => i === 6 ? null : Math.floor(i / 2) % 2),
  } };
  const before = structuredClone(source);
  const options = { imputations: 2, iterations: 2, seed: 82, predictors: { a: [], b: [] },
    measurements: { a: 'ordinal' as const, b: 'ordinal' as const }, rows: Array.from({ length: 16 }, (_, i) => i + 1) };
  const result = imputeOrdinal(source, options);
  expect(result.completed).toHaveLength(2); expect(result.failures).toEqual([]);
  expect(result).toEqual(imputeOrdinal(source, options)); expect(result.rows).toEqual(options.rows);
  expect(result.convergence).toBe('not-assessed');
  for (const chain of result.completed) for (const column of source.columns) options.rows.forEach((row, i) => {
    const original = source.data[column][row];
    expect(chain.table.data[column][i]).not.toBeNull();
    if (original !== null) expect(chain.table.data[column][i]).toBe(original);
    expect(result.filled[column][i]).toBe(original === null);
  });
  expect(source).toEqual(before);
});

it('rejects missing predictor declarations and continuous inputs for ordinal MICE', () => {
  const table = { columns: ['a', 'b'], nRows: 6, data: { a: [1, 2, 1, 2, null, 1], b: [2, 1, 2, 1, 2, null] } };
  expect(() => imputeOrdinal(table, { imputations: 2, iterations: 2, seed: 1, predictors: { a: [] } })).toThrow(/every target/);
  expect(() => imputeOrdinal(table, { imputations: 2, iterations: 2, seed: 1, predictors: { a: [], b: [] }, measurements: { a: 'continuous' } })).toThrow(/ordered categories/);
});

it('uses declared noninteger numeric categories for MICE without separate measurement flags', () => {
  const source = { columns: ['a', 'b'], nRows: 24, data: {
    a: Array.from({ length: 24 }, (_, i) => i === 2 ? null : i % 2 ? 0.2 : 0.1),
    b: Array.from({ length: 24 }, (_, i) => i === 6 ? null : Math.floor(i / 2) % 2 ? 0.2 : 0.1),
  } };
  const options = { imputations: 2, iterations: 2, seed: 82, predictors: { a: [], b: [] }, orders: { a: [0.1, 0.2], b: [0.1, 0.2] } };
  const result = imputeOrdinal(source, options);
  expect(result.failures).toEqual([]); expect(result.completed).toHaveLength(2);
  for (const chain of result.completed) for (const column of source.columns) expect(chain.table.data[column].every(value => value === 0.1 || value === 0.2)).toBe(true);
  expect(() => imputeOrdinal(source, { ...options, orders: { ...options.orders, a: [0.1, 0.2, Infinity] } })).toThrow(/finite numbers/);
});

it('describes only explicitly selected rows and retains candidate status in public diagnostics', () => {
  const source = { columns: ['a', 'b'], nRows: 8, data: { a: [1, 2, 1, 2, 1, 2, null, null], b: [2, 1, 2, 1, 2, 1, null, null] } };
  const advice = analyzeItems(source, { rows: [0, 1, 2, 3, 4, 5], method: 'efa' });
  expect(advice.sample.rows).toBe(6); expect(advice.sample.missingCells).toBe(0);
  expect(advice.items[0].classification).toBe('ordinal-candidate');
});

it('returns numeric clustering labels and an auditable sum of squares without hidden preparation', () => {
  const rows = [[0, 0], [0, 1], [10, 10], [10, 11]], before = structuredClone(rows);
  const fit = kmeans(rows, { k: 2 });
  expect(fit.labels[0]).toBe(fit.labels[1]); expect(fit.labels[2]).toBe(fit.labels[3]); expect(fit.labels[0]).not.toBe(fit.labels[2]);
  expect(fit.withinSumSquares).toBeCloseTo(1, 14); expect(fit.counts).toEqual([2, 2]);
  expect(fit.convergence).toBe('not-reported'); expect(rows).toEqual(before);
  expect(() => kmeans([[1], [1]], { k: 2 })).toThrow(/distinct/);
  expect(() => kmeans([[1], [NaN]], { k: 1 })).toThrow(/finite/);
});

it('uses Euclidean DBSCAN with self-inclusive neighborhoods and explicit noise', () => {
  const fit = dbscan([[0], [0.2], [0.4], [10]], { eps: 0.3, minSamples: 2 });
  expect(fit.labels).toEqual([0, 0, 0, -1]); expect(fit.clusters).toBe(1); expect(fit.noise).toBe(1);
  expect(() => dbscan([[0]], { eps: -1, minSamples: 1 })).toThrow(/positive/);
});

it('rejects unsupported distance ranges instead of silently merging distant points or returning nonfinite fits', () => {
  expect(() => dbscan([[0], [1e308]], { eps: 1e200, minSamples: 2 })).toThrow(/supported numeric range/);
  expect(() => dbscan([[0], [1e-200]], { eps: 1e-300, minSamples: 2 })).toThrow(/supported numeric range/);
  expect(dbscan([[0], [1e308]], { eps: 1, minSamples: 2 }).labels).toEqual([-1, -1]);
  expect(() => kmeans([[1e308], [1e308]], { k: 1 })).toThrow(/supported numeric range/);
  expect(() => kmeans([[1e200], [-1e200]], { k: 1 })).toThrow(/supported numeric range/);
  expect(() => kmeans([[0], [1e-200]], { k: 1 })).toThrow(/supported numeric range/);
  const sparse = [[0], Array<number>(1), [10]];
  expect(() => kmeans(sparse, { k: 2 })).toThrow(/finite numeric rows/);
  expect(() => dbscan(sparse, { eps: 1, minSamples: 2 })).toThrow(/finite numeric rows/);
});
