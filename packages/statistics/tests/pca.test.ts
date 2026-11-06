import { describe, expect, it } from 'vitest';
import { fitPca, transformPca, serializePcaModel, deserializePcaModel, validatePcaModel, type PcaModel } from '../src/pca';
import type { InputTable } from '../src/data';
import { runPCA } from '../src/internal/pca';
import { runPCA as baselinePca } from '../../../validation/library-migration/baseline/pca';

const small: InputTable = { columns: ['a', 'b'], nRows: 6, data: { a: [1, 2, 4, 5, 7, 8], b: [2, 1, 3, 6, 8, 7] } };
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const rowsEqual = (a: (number | null)[][], b: (number | null)[][], precision = 12) => {
  expect(a.length).toBe(b.length);
  a.forEach((row, i) => {
    expect(row.length).toBe(b[i].length);
    row.forEach((value, j) => value === null ? expect(b[i][j]).toBeNull() : expect(value).toBeCloseTo(b[i][j]!, precision));
  });
};
const damaged = { columns: ['a', 'b', 'c', 'd'], nRows: 16, data: Object.fromEntries(['a', 'b', 'c', 'd'].map((name, j) =>
  [name, Array.from({ length: 16 }, (_, i) => (i + j * 3) % 13 === 0 ? null : Math.sin(i * .8 + j) + j * 2 + i * .13)])) };

describe('PCA numerical boundary', () => {
  it('exposes full-precision orthonormal components, population scales and reproducible training scores', () => {
    const original = structuredClone(small), fit = fitPca(small, { k: 2, missing: 'complete' });
    fit.model.components[0].forEach(value => expect(Math.abs(value)).toBeCloseTo(Math.SQRT1_2, 14));
    expect(fit.model.components[0][0]).not.toBe(Math.round(fit.model.components[0][0] * 1000) / 1000);
    expect(dot(fit.model.components[0], fit.model.components[1])).toBeCloseTo(0, 14);
    expect(fit.model.means).toEqual([4.5, 4.5]);
    const popSd = Math.sqrt([1, 2, 4, 5, 7, 8].reduce((sum, v) => sum + (v - 4.5) ** 2, 0) / 6);
    expect(fit.model.scales[0]).toBe(popSd);
    rowsEqual(transformPca(fit.model, small).scores, fit.scores);
    expect(validatePcaModel(fit.model)).toEqual(fit.model);
    expect(small).toEqual(original);
    expect(fit.convergence).toEqual({ stage: 'not-applicable', converged: true });
  });

  it.each(['mean', 'median', 'complete', 'pairwise', 'iterative'] as const)('keeps the original workbench %s results and rejections exactly', missing => {
    for (const standardize of [true, false]) {
      const table = { ...damaged, columns: [...damaged.columns, 'PC1_Old', 'PC1_Current'],
        data: { ...damaged.data, PC1_Old: Array(16).fill(11), PC1_Current: Array(16).fill(12) } };
      const options = { missing, standardize, k: 2, label: 'Current', measurements: Object.fromEntries(damaged.columns.map(c => [c, 'continuous' as const])) };
      let baseline;
      try { baseline = baselinePca(table, damaged.columns, options); } catch (error) {
        // Pairwise covariances need not be PSD; the package must preserve that rejection.
        expect(missing).toBe('pairwise');
        expect(() => runPCA(table, damaged.columns, options)).toThrow((error as Error).message);
        expect(() => fitPca(table, { missing, standardize, k: 2, columns: damaged.columns })).toThrow((error as Error).message);
        continue;
      }
      expect(runPCA(table, damaged.columns, options)).toEqual(baseline);
      const fit = fitPca(table, { missing, standardize, k: 2, measurements: options.measurements, columns: damaged.columns });
      rowsEqual(fit.scores, Array.from({ length: table.nRows }, (_, row) => baseline.columns.map(column => baseline.table.data[column][row])));
      expect(fit.missing).toEqual(baseline.missing);
    }
  });

  it.each(['mean', 'median'] as const)('uses only training rows for %s fills and preserves requested row order', missing => {
    const input: InputTable = { columns: ['a', 'b'], nRows: 7,
      data: { a: [1, 3, 100000, 5, null, 9, -100000], b: [2, 6, -50000, 3, 7, 11, 50000] } };
    const rows = [5, 0, 4, 3, 1], fit = fitPca(input, { rows, missing, k: 2, measurements: { a: 'continuous', b: 'continuous' } });
    expect(fit.rows).toEqual(rows); expect(fit.fittingRows).toEqual(rows); expect(fit.model.training.selectedRows).toEqual(rows);
    expect(fit.model.missing.replacements[0]).toBe(missing === 'mean' ? 4.5 : 4);
    const next: InputTable = { columns: ['b', 'unused', 'a'], nRows: 3,
      data: { a: [null, 900000, 10], b: [4, -900000, 12], unused: [0, 0, 0] } };
    const before = structuredClone(fit.model), transformed = transformPca(fit.model, next, { rows: [2, 0] });
    const values = [[10, 12], [fit.model.missing.replacements[0]!, 4]];
    const expected = values.map(row => fit.model.components.map(component => dot(component, row.map((v, j) => (v - fit.model.means[j]) / fit.model.scales[j]))));
    rowsEqual(transformed.scores, expected);
    expect(transformed.rows).toEqual([2, 0]); expect(transformed.imputedCells).toBe(1);
    expect(fit.model).toEqual(before);
  });

  it.each(['complete', 'pairwise'] as const)('keeps incomplete transform rows unscored under %s', missing => {
    const fit = fitPca(small, { missing, k: 2 });
    const input: InputTable = { columns: ['a', 'b'], nRows: 4, data: { a: [2, null, 5, null], b: [4, 7, 9, null] } };
    const result = transformPca(fit.model, input, { rows: [3, 2, 1, 0] });
    expect(result.rows).toEqual([3, 2, 1, 0]); expect(result.scoredRows).toEqual([2, 0]); expect(result.unscoredRows).toEqual([3, 1]);
    expect(result.scores[0]).toEqual([null, null]); expect(result.scores[2]).toEqual([null, null]); expect(result.imputedCells).toBe(0);
  });

  it('reports complete-case versus pairwise fitting and scored membership separately', () => {
    const complete = fitPca(damaged, { missing: 'complete', rows: [8, 4, 1, 10, 3, 6, 2, 5, 7, 0, 9, 11, 12, 13, 14, 15], k: 2 });
    const expected = complete.rows.filter(row => damaged.columns.every(c => damaged.data[c][row] !== null));
    expect(complete.fittingRows).toEqual(expected); expect(complete.scoredRows).toEqual(expected);
    const pairwise = fitPca(damaged, { missing: 'pairwise', k: 2 });
    expect(pairwise.fittingRows).toEqual(Array.from({ length: damaged.nRows }, (_, i) => i));
    expect(pairwise.scoredRows.length).toBeLessThan(pairwise.fittingRows.length);
    expect(validatePcaModel(pairwise.model)).toEqual(pairwise.model);
  });

  it('surfaces capped iterative fits and requires explicit acceptance before new-data scoring', () => {
    const fit = fitPca(damaged, { missing: 'iterative', k: 2, iterative: { maxIterations: 1, tolerance: 1e-8, rank: 2 } });
    expect(fit.convergence.converged).toBe(false);
    expect(fit.convergence.issue).toMatchObject({ method: 'iterative-pca', reason: 'iteration-limit', iterations: 1, partialAvailable: true });
    const complete: InputTable = { columns: damaged.columns, nRows: 1, data: Object.fromEntries(damaged.columns.map(c => [c, [2]])) };
    expect(() => transformPca(fit.model, complete)).toThrow(/allowUnconverged/);
    expect(transformPca(fit.model, complete, { allowUnconverged: true }).scores[0]).toHaveLength(2);
    expect(() => transformPca(fit.model, damaged, { allowUnconverged: true })).toThrow(/incomplete new rows/);
    const restored = deserializePcaModel(serializePcaModel(fit.model));
    expect(restored).toEqual(fit.model);
    const converged = fitPca(small, { missing: 'iterative', k: 1 });
    expect(converged.convergence.converged).toBe(true);
    rowsEqual(transformPca(converged.model, small).scores, converged.scores);
  });

  it('retains categorical replacement and numeric-string coercion contracts', () => {
    const input: InputTable = { columns: ['a', 'b'], nRows: 6, data: { a: ['1', '1', '3', '3', null, null], b: [1, 2, 3, 4, 5, 6] } };
    const fit = fitPca(input, { missing: 'mean', measurements: { a: 'ordinal', b: 'continuous' }, k: 1 });
    expect(fit.model.missing.replacements[0]).toBe(1);
    expect(fit.missing.fillRules?.[0].rule).toBe('nearest-category-mean');
    const fromText = transformPca(fit.model, { columns: ['a', 'b'], nRows: 1, data: { a: ['2'], b: ['4'] } });
    const fromNumber = transformPca(fit.model, { columns: ['a', 'b'], nRows: 1, data: { a: [2], b: [4] } });
    expect(fromText).toEqual(fromNumber);
  });

  it('round-trips raw covariance models and rejects malformed or contradictory JSON', () => {
    const fit = fitPca(small, { standardize: false, missing: 'mean', k: 2 });
    expect(fit.model.scales).toEqual([1, 1]);
    const json = serializePcaModel(fit.model), model = deserializePcaModel(json);
    expect(model).toEqual(fit.model); expect(model).not.toBe(fit.model);
    expect(transformPca(model, small)).toEqual(transformPca(fit.model, small));
    const corruptions: ((m: PcaModel) => void)[] = [
      m => { m.components[0][0] += .05; }, m => { m.means[0] = NaN; }, m => { m.scales[0] = 0; },
      m => { m.k = 99; }, m => { m.schema = 'unknown' as never; }, m => { m.training.fittingRows.push(999); },
      m => { m.missing.replacements[0] = null; }, m => { m.spectrum[0] = .99; },
      m => { (m as unknown as Record<string, unknown>).unrecognized = true; }, m => { m.convergence.converged = false; },
      m => { delete m.means[0]; }, m => { delete m.variables[0]; }, m => { delete m.missing.replacements[0]; },
      m => { m.training.fittingRows.reverse(); },
    ];
    for (const corrupt of corruptions) {
      const bad = structuredClone(model); corrupt(bad);
      expect(() => validatePcaModel(bad)).toThrow();
      expect(() => deserializePcaModel(JSON.stringify(bad))).toThrow();
    }
    expect(() => deserializePcaModel('not JSON')).toThrow(/JSON/);
    expect(() => fitPca(small, { k: 1.5 })).toThrow(/k must/);
    expect(() => fitPca(small, { missing: 'mice' } as never)).toThrow(/separate operation/);
    expect(() => fitPca(small, { label: 'workbench' } as never)).toThrow(/settings fields/);
    expect(() => fitPca(small, { missing: 'mean', iterative: { rank: 1 } })).toThrow(/iterative missing-value/);
  });

  it('serializes zero-variance unstandardized models without inventing explained variance', () => {
    const table: InputTable = { columns: ['a', 'b'], nRows: 3, data: { a: [1, 1, 1], b: [2, 2, 2] } };
    const fit = fitPca(table, { missing: 'complete', standardize: false, k: 2 });
    expect(fit.model.eigenvalues).toEqual([0, 0]); expect(fit.model.spectrum).toEqual([0, 0]);
    const restored = deserializePcaModel(serializePcaModel(fit.model));
    expect(transformPca(restored, table).scores).toEqual([[0, 0], [0, 0], [0, 0]]);
  });

  it('keeps covariance eigenvectors and normalized eigenvalues invariant across tiny and large units', () => {
    const reference = fitPca(small, { missing: 'complete', standardize: false, k: 2 });
    for (const scale of [1e-150, 1e-100, 1e-10, 1e100]) {
      const rescaled: InputTable = { ...small, data: Object.fromEntries(small.columns.map(column =>
        [column, small.data[column].map(value => (value as number) * scale)])) };
      const fit = fitPca(rescaled, { missing: 'complete', standardize: false, k: 2 });
      rowsEqual(fit.model.components, reference.model.components);
      fit.model.eigenvalues.forEach((value, i) => expect(value / scale / scale).toBeCloseTo(reference.model.eigenvalues[i], 12));
      rowsEqual(fit.scores.map(row => row.map(value => value! / scale)), reference.scores);
      rowsEqual(transformPca(fit.model, rescaled).scores.map(row => row.map(value => value! / scale)), reference.scores);
    }
  });

  it('caps the public default rank at the actual complete-case sample and rejects excess requested components', () => {
    const table: InputTable = { columns: ['a', 'b', 'c', 'd'], nRows: 5,
      data: { a: [1, 2, 3, 4, 5], b: [1, 4, 2, null, null], c: [3, 2, 4, 5, 1], d: [5, 2, 4, 3, 9] } };
    const fit = fitPca(table, { missing: 'complete' });
    expect(fit.model.k).toBe(2);
    expect(fit.fittingRows).toEqual([0, 1, 2]);
    expect(fit.scores[3]).toEqual([null, null]);
    expect(() => fitPca(table, { missing: 'complete', k: 3 })).toThrow(/rank available after complete-case/);
  });
});
