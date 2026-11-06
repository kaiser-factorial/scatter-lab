import { describe, expect, it } from 'vitest';
import { pairwisePcaMatrix, runPCA } from '../pca';
import { runPcaImputations } from '../pca-imputation';
import { preparePcaMice, runPcaMiceChain, type PcaMiceSettings } from '../pca-imputation-core';
import { imputeMice } from '../efa/mice';
import { mulberry32 } from '../random';
import type { DataTable } from '../table';

describe('pairwise PCA', () => {
  const table: DataTable = { columns: ['a', 'b'], nRows: 6, data: {
    a: [1, 2, 3, 4, null, 6], b: [2, 1, 4, null, 5, 8],
  } };
  it('uses pair-specific means and scales with analytic two-variable eigenvalues', () => {
    const x = [1, 2, 3, 6], y = [2, 1, 4, 8], mx = 3, my = 3.75;
    const cross = x.reduce((sum, v, i) => sum + (v - mx) * (y[i] - my), 0);
    const rho = cross / Math.sqrt(x.reduce((sum, v) => sum + (v - mx) ** 2, 0) * y.reduce((sum, v) => sum + (v - my) ** 2, 0));
    const fit = runPCA(table, table.columns, { k: 2, missing: 'pairwise' });
    expect(fit.eigenvalues).toEqual([expect.closeTo(1 + rho, 12), expect.closeTo(1 - rho, 12)]);
    expect(fit.missing.pairCounts).toEqual([[5, 4], [4, 5]]);
    expect(fit.missing.imputedCells).toBe(0);
    expect(fit.missing.rowsScored).toBe(4);
    expect(fit.missing.rowsUsed).toBe(6);
    expect(fit.table.data.PC1[3]).toBeNull(); expect(fit.table.data.PC1[4]).toBeNull();
    expect(fit.eigenvalues).not.toEqual(runPCA(table, table.columns, { k: 2, missing: 'mean' }).eigenvalues);
  });
  it('uses pair-specific population covariance when standardization is off and preserves input', () => {
    const covarianceTable: DataTable = { ...table, data: { a: [1, 2, 3, 20, null, 6], b: [2, 1, 4, null, 20, 8] } };
    const before = structuredClone(covarianceTable), result = pairwisePcaMatrix([covarianceTable.data.a as (number | null)[], covarianceTable.data.b as (number | null)[]], covarianceTable.columns, false);
    expect(result.matrix[0][1]).toBeCloseTo(4.75, 12);
    runPCA(covarianceTable, covarianceTable.columns, { k: 2, missing: 'pairwise', standardize: false });
    expect(covarianceTable).toEqual(before);
  });
  it('can fit a valid matrix without inventing scores when no respondent is complete', () => {
    const t: DataTable = { columns: ['a', 'b', 'c'], nRows: 12, data: {
      a: [-1, -1, 1, 1, -1, -1, 1, 1, null, null, null, null],
      b: [-1, 1, -1, 1, null, null, null, null, -1, -1, 1, 1],
      c: [null, null, null, null, -1, 1, -1, 1, -1, 1, -1, 1],
    } };
    const fit = runPCA(t, t.columns, { k: 3, missing: 'pairwise' });
    expect(fit.eigenvalues).toEqual([1, 1, 1]);
    expect(fit.missing.rowsScored).toBe(0);
    expect(fit.table.data.PC1).toEqual(Array(12).fill(null));
  });
  it('rejects incompatible pairwise matrices instead of smoothing or clipping substantive negative eigenvalues', () => {
    const t: DataTable = { columns: ['a', 'b', 'c'], nRows: 6, data: {
      a: [0, 1, 0, 1, null, null], b: [0, 1, null, null, 0, 1], c: [null, null, 0, 1, 1, 0],
    } };
    expect(() => runPCA(t, t.columns, { missing: 'pairwise' })).toThrow(/not positive semidefinite/);
    expect(() => runPCA(table, table.columns, { missing: 'pairwise', minimumPairN: 5 })).toThrow(/Too few observed responses/);
  });
  it('does not overflow the product of large but finite pair variances', () => {
    const result = pairwisePcaMatrix([[1e150, 2e150, 3e150], [2e150, 4e150, 6e150]], ['a', 'b'], true);
    expect(result.matrix[0][1]).toBeCloseTo(1, 12);
  });
});

describe('measurement-aware PCA column fills', () => {
  const table: DataTable = { columns: ['scale', 'value'], nRows: 5, data: {
    scale: [1, 1, 2, 2, null], value: [0.1, 0.5, 0.3, 0.8, 0.6],
  } };
  it.each(['mean', 'median'] as const)('keeps auto-detected ordinal %s fills in the observed categories', missing => {
    const result = runPCA(table, table.columns, { missing, k: 2 });
    expect(result.missing.fillRules?.[0]).toMatchObject({ variable: 'scale', measurement: 'ordinal', value: 1,
      rule: missing === 'mean' ? 'nearest-category-mean' : 'category-median' });
    const explicit = runPCA({ ...table, data: { ...table.data, scale: [1, 1, 2, 2, 1] } }, table.columns, { missing: 'complete', k: 2 });
    expect(result.table.data.PC1).toEqual(explicit.table.data.PC1);
    expect(table.data.scale[4]).toBeNull();
  });
  it('honors a continuous override and records fractional fills', () => {
    const result = runPCA(table, table.columns, { missing: 'median', measurements: { scale: 'continuous' } });
    expect(result.missing.fillRules?.[0]).toMatchObject({ measurement: 'continuous', value: 1.5, rule: 'numeric-median' });
  });
  it('ignores values beyond the declared fitting row set when detecting the scale', () => {
    const extended = { ...table, data: { ...table.data, scale: [...table.data.scale, 91.23, 109.72] } };
    expect(runPCA(extended, table.columns, { missing: 'mean' }).missing.fillRules).toEqual(runPCA(table, table.columns, { missing: 'mean' }).missing.fillRules);
  });
});

const miceTable = (): DataTable => {
  const random = mulberry32(27831), columns = ['a', 'b', 'c'];
  const data: DataTable['data'] = { a: [], b: [], c: [] };
  const levels = [[1, 4, 9], [0, 1], [1, 2, 3, 4]];
  for (let i = 0; i < 180; i++) for (let j = 0; j < columns.length; j++) {
    const value = levels[j][Math.floor(random() * levels[j].length)];
    data[columns[j]].push((i + j * 3) % 13 === 0 ? null : value);
  }
  return { columns, data, nRows: 180 };
};
const settings: PcaMiceSettings = { k: 2, standardize: true, label: 'mice_trial', imputations: 2, iterations: 2,
  seed: 18271, predictors: [[1, 2], [0, 2], [0, 1]], predictorEncoding: 'ordered-polynomial' };

describe('separate MICE PCA fits', () => {
  it('preserves observed input and missingness, retaining distinct reproducible fits and traces', async () => {
    const table = miceTable(), before = structuredClone(table);
    const batch = await runPcaImputations(table, table.columns, settings);
    const again = await runPcaImputations(table, table.columns, settings);
    expect(batch.completed).toHaveLength(2); expect(batch.failures).toEqual([]);
    expect(batch.completed.map(f => f.imputation)).toEqual([1, 2]);
    expect(batch.trace.length).toBe(12);
    expect(batch.completed).toEqual(again.completed);
    expect(batch.completed[0].result.table.data.PC1_mice_trial).not.toEqual(batch.completed[1].result.table.data.PC1_mice_trial);
    for (const { imputation, result } of batch.completed) {
      expect(result.missing.strategy).toBe('mice');
      expect(result.missing.imputation).toBe(imputation);
      expect(result.missing.imputedCells).toBeGreaterThan(0);
      for (const column of table.columns) expect(result.table.data[column]).toEqual(table.data[column]);
      expect(result.table.data.PC1_mice_trial.every(value => typeof value === 'number')).toBe(true);
    }
    expect(table).toEqual(before);
  });
  it('fits actual numeric category spacing rather than replacing completed values by ranks', () => {
    const table = miceTable(), source = preparePcaMice(table, table.columns);
    const completed = imputeMice(source, settings, undefined, undefined, [0]).completed[0].data;
    const completeTable: DataTable = { ...table, data: Object.fromEntries(source.items.map((item, j) => [item.column,
      Array.from({ length: table.nRows }, (_, i) => item.categories[completed.codes[j * table.nRows + i]]),
    ])) };
    const direct = runPCA(completeTable, table.columns, { ...settings, missing: 'complete' });
    const throughBatch = runPcaMiceChain(table, source, settings, 0).result!;
    expect(throughBatch.eigenvalues).toEqual(direct.eigenvalues);
    expect(throughBatch.table.data.PC1_mice_trial).toEqual(direct.table.data.PC1_mice_trial);
  });
  it('supports two-item PCA without inheriting EFA factor identification limits', async () => {
    const table = miceTable();
    const batch = await runPcaImputations(table, ['a', 'b'], { ...settings, predictors: [[1], [0]] });
    expect(batch.completed).toHaveLength(2);
    expect(batch.completed[0].result.variables).toEqual(['a', 'b']);
  });
  it('rejects a single-imputation disguise, continuous categories, and direct synchronous MICE', async () => {
    const table = miceTable();
    await expect(runPcaImputations(table, table.columns, { ...settings, imputations: 1 })).rejects.toThrow(/2–100/);
    expect(() => runPCA(table, table.columns, { missing: 'mice' })).toThrow(/separate PCA fits/);
    const continuous = { ...table, data: { ...table.data, a: Array.from({ length: 180 }, (_, i) => i / 10) } };
    await expect(runPcaImputations(continuous, continuous.columns, settings)).rejects.toThrow(/Ordinal MICE/);
    await expect(runPcaImputations(table, table.columns, { ...settings, minimumPairN: table.nRows })).rejects.toThrow(/observed pair support/);
  });
  it('honors continuous overrides and requires an ordinal override for noninteger categorical codes', async () => {
    const table = miceTable();
    await expect(runPcaImputations(table, table.columns, { ...settings, measurements: { a: 'continuous' } })).rejects.toThrow(/"a" is continuous/);
    table.data.a = table.data.a.map(value => value === null ? null : (value as number) / 10);
    expect(() => preparePcaMice(table, table.columns)).toThrow(/"a" is continuous/);
    const source = preparePcaMice(table, table.columns, { a: 'ordinal' });
    expect(source.items[0].categories).toEqual([0.1, 0.4, 0.9]);
    expect(source.items[0].measurement).toBe('ordinal');
  });
  it('retains failed fits instead of silently substituting or returning nonfinite PCA output', async () => {
    const table = miceTable();
    table.data.a = Array.from({ length: table.nRows }, (_, i) => i % 2 ? -1e308 : 1e308);
    const batch = await runPcaImputations(table, table.columns, { ...settings, predictors: [[], [], []] });
    expect(batch.completed).toHaveLength(0);
    expect(batch.failures).toHaveLength(2);
    expect(batch.failures.map(f => f.imputation)).toEqual([1, 2]);
    expect(batch.failures.every(f => f.stage === 'pca' && f.error.includes('numeric range'))).toBe(true);
  });
  it('can be cancelled before or between chains without publishing a partial batch as complete', async () => {
    const table = miceTable(), aborted = new AbortController(); aborted.abort();
    await expect(runPcaImputations(table, table.columns, { ...settings, signal: aborted.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const control = new AbortController();
    await expect(runPcaImputations(table, table.columns, { ...settings, signal: control.signal,
      onProgress: progress => { if (progress.stage === 'MICE + PCA') control.abort(); },
    })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
