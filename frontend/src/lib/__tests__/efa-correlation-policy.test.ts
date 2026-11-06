import { describe, expect, it } from 'vitest';
import { prepareEfa } from '../efa/prepare';
import { correlate } from '../efa/correlation';
import { fitEfa, scoreEfa } from '../efa/fit';
import { weightedMoments, influenceAt } from '../efa/weighted-moments';
import { resampleData } from '../efa/stability';
import { parallelAnalysis } from '../efa/parallel';
import { imputationFitData } from '../efa/imputation-analysis';
import { validateEfaState } from '../efa/persistence';
import { mulberry32 } from '../random';
import type { EfaSpec, EfaRun } from '../efa/types';
import type { DataTable } from '../table';

const columns = ['a', 'b', 'c', 'd', 'e', 'f'];
const random = mulberry32(342);
const rows = Array.from({ length: 360 }, (_, i) => i);
const table: DataTable = { columns, nRows: rows.length, data: Object.fromEntries(columns.map(c => [c, []])) };
for (const i of rows) {
  const common = (random() + random() + random() - 1.5) * 1.5;
  columns.forEach((c, j) => {
    const x = common + random() + random() - 1;
    table.data[c].push((i + j * 3) % 29 === 0 ? null : x < -.35 ? 1 : x > .35 ? 4 : 2);
  });
}
const spec: EfaSpec = { items: columns.map(column => ({ column, categories: [1, 2, 4], reverse: false })),
  correlation: 'polychoric', missing: 'median', extraction: 'minres', nFactors: 1, rotation: 'varimax',
  seed: 321, label: 'Ordinal', sample: { partition: 'all' } };

describe('independent EFA correlation and missing policies', () => {
  it('keeps category-valued medians and nearest-category means on the declared original order', () => {
    const small = { ...table, nRows: 6, data: Object.fromEntries(columns.map(c => [c, [1, 1, 4, 4, null, null]])) };
    const median = prepareEfa(small, { ...spec, items: spec.items.map((item, i) => ({ ...item, reverse: i === 0 })) }, [0, 1, 2, 3, 4, 5]);
    expect(median.numeric).toBeUndefined();
    expect(median.imputation?.kind).toBe('ordinal');
    expect(median.imputation?.values.slice(0, 2)).toEqual([3, 1]); // lower original category, then reverse
    expect(Array.from(median.observed.slice(0, 6))).toEqual([1, 1, 1, 1, 0, 0]);
    expect(Array.from(median.fittingObserved!)).toEqual(Array(36).fill(1));
    const mean = prepareEfa(small, { ...spec, missing: 'mean' }, [0, 1, 2, 3, 4, 5]);
    expect(mean.imputation?.values).toEqual(Array(6).fill(2)); // raw mean2.5 maps to category2
    expect(mean.imputation?.rules).toEqual(Array(6).fill('nearest-category-mean'));
    expect(small.data.a).toEqual([1, 1, 4, 4, null, null]);
  });
  it('infers correlation from measurement, independently of mean/median, and honors continuous overrides', () => {
    const automatic = prepareEfa(table, { ...spec, correlation: 'auto' }, rows);
    expect(automatic.numeric).toBeUndefined();
    const continuous = prepareEfa(table, { ...spec, correlation: 'auto', items: spec.items.map(item => ({ ...item, measurement: 'continuous' })) }, rows);
    expect(continuous.numeric).toBeInstanceOf(Float64Array);
    expect(continuous.imputation?.rules).toEqual(Array(6).fill('numeric-median'));
    expect(() => prepareEfa(table, { ...spec, correlation: 'auto', extraction: 'dwls', items: spec.items.map(item => ({ ...item, measurement: 'continuous' })) }, rows)).toThrow(/Pearson correlations use MINRES/);
    // Legacy implicit mean/median runs keep their numeric behavior.
    expect(prepareEfa(table, { ...spec, correlation: undefined }, rows).numeric).toBeInstanceOf(Float64Array);
  });
  it('keeps ordinal column replacements in a mixed numeric Pearson analysis', () => {
    const mixed = structuredClone(table); mixed.data.f = rows.map(i => i === 0 ? null : i / 7.3);
    const data = prepareEfa(mixed, { ...spec, correlation: 'auto' }, rows);
    expect(data.numeric).toBeInstanceOf(Float64Array);
    expect(data.imputation?.rules?.slice(0, 5)).toEqual(Array(5).fill('category-median'));
    expect(data.imputation?.rules?.[5]).toBe('numeric-median');
  });
  it('computes completed ordinal correlations and DWLS uncertainty while retaining original support', () => {
    const data = prepareEfa(table, spec, rows), correlation = correlate(data);
    const completed: DataTable = { ...table, data: Object.fromEntries(columns.map((c, j) => [c, rows.map(i => spec.items[j].categories[data.codes[j * rows.length + i]])])) };
    const manual = prepareEfa(completed, { ...spec, missing: 'pairwise' }, rows), reference = correlate(manual);
    expect(correlation.matrix).toEqual(reference.matrix);
    expect(correlation.pairs[0].n).toBeLessThan(rows.length);
    expect(correlation.pairs[0].fittingN).toBe(rows.length);
    const actualMoments = weightedMoments(data, correlation), expectedMoments = weightedMoments(manual, reference);
    expect(Array.from(actualMoments.weights)).toEqual(Array.from(expectedMoments.weights));
    expect(influenceAt(data, actualMoments.pairs[0], 0)).toBe(influenceAt(manual, expectedMoments.pairs[0], 0));
    const fit = fitEfa(data, correlation, { ...spec, extraction: 'dwls' });
    expect(fit.correlationMethod).toBe('polychoric');
    expect(fit.weighted?.uncertaintyMethod).toContain('conditional on single-imputation');
    expect(fit.provenance.correlation).toContain('empirical lower category');
    expect(scoreEfa(data, fit)[0][0]).not.toBeNull();
    const run: EfaRun = { id: 'fit', spec: { ...spec, extraction: 'dwls' }, result: fit, revision: 1, createdAt: '2026-11-06', datasetRevision: 'test', eligibleRows: rows, kind: 'fit', reviews: {}, reasons: '', revisedAfterHoldout: false, scoreColumns: [] };
    expect(() => validateEfaState({ runs: [run], splits: [] }, table.nRows)).not.toThrow();
  });
  it('applies reverse keys after filling on the original scale for both median and tied mean', () => {
    const tied = structuredClone(table);
    tied.data.a = rows.map(i => i % 3 === 0 ? null : i % 3 === 1 ? 2 : 4);
    for (const missing of ['mean', 'median'] as const) for (const correlation of ['polychoric', 'pearson'] as const) {
      const base = { ...spec, missing, correlation }, normal = prepareEfa(tied, base, rows),
        reversed = prepareEfa(tied, { ...base, items: base.items.map((item, i) => ({ ...item, reverse: i === 0 })) }, rows);
      const a = correlate(normal), b = correlate(reversed);
      for (let j = 1; j < columns.length; j++) expect(b.matrix[0][j]).toBeCloseTo(-a.matrix[0][j], correlation === 'pearson' ? 12 : 5);
    }
  });
  it('supports true pairwise Pearson correlations and complete-case Pearson with no fills', () => {
    const data = prepareEfa(table, { ...spec, correlation: 'pearson', missing: 'pairwise' }, rows);
    expect(data.imputation).toBeUndefined();
    const pair = correlate(data).pairs[0];
    const x: number[] = [], y: number[] = [];
    rows.forEach(i => { if (table.data.a[i] != null && table.data.b[i] != null) { x.push(table.data.a[i] as number); y.push(table.data.b[i] as number); } });
    const mx = x.reduce((a, b) => a + b) / x.length, my = y.reduce((a, b) => a + b) / y.length;
    const r = x.reduce((sum, a, i) => sum + (a - mx) * (y[i] - my), 0) / Math.sqrt(x.reduce((sum, a) => sum + (a - mx) ** 2, 0) * y.reduce((sum, a) => sum + (a - my) ** 2, 0));
    expect(pair.rho).toBeCloseTo(r, 13); expect(pair.n).toBe(x.length);
    const complete = prepareEfa(table, { ...spec, correlation: 'pearson', missing: 'complete' }, rows);
    expect(complete.rows.length).toBeLessThan(rows.length);
    expect(complete.rows.every(row => columns.every(c => table.data[c][row] != null))).toBe(true);
    const large = { ...table, data: Object.fromEntries(columns.map(c => [c, table.data[c].map(value => value === null ? null : (value as number) * 1e100)])) };
    const scaled = correlate(prepareEfa(large, { ...spec, correlation: 'pearson', missing: 'pairwise', items: spec.items.map(item => ({ ...item, measurement: 'continuous' })) }, rows));
    expect(scaled.pairs[0].rho).toBeCloseTo(pair.rho, 12);
  });
  it('recomputes ordinal replacement within each bootstrap sample and keeps PA ordinal', () => {
    const data = prepareEfa(table, spec, rows), sample = resampleData(data, rows.slice(0, 100));
    expect(sample.fittingObserved?.length).toBe(600);
    expect(sample.imputation?.values.every(value => value >= 1 && value <= 3)).toBe(true);
    const pa = parallelAnalysis(data, 66, 2);
    expect(pa.provenance?.correlation).toContain('polychoric');
    expect(pa.completed + pa.failures.length).toBe(2);
  });
  it('can fit numeric Pearson to an ordinal MICE completion without changing the category chain', () => {
    const complete = prepareEfa({ ...table, data: Object.fromEntries(columns.map(c => [c, table.data[c].map(v => v ?? 2)])) }, { ...spec, missing: 'complete' }, rows);
    const numeric = imputationFitData(complete, { ...spec, correlation: 'pearson', missing: 'pairwise' });
    expect(numeric.numeric?.[1]).toBe(table.data.a[1]);
    expect(numeric.observed.every(Boolean)).toBe(true);
    expect(numeric.numeric).not.toBe(complete.codes);
    expect(numeric.rows).toEqual(complete.rows);
    expect(fitEfa(numeric, correlate(numeric), { ...spec, correlation: 'pearson', missing: 'pairwise' }).correlationMethod).toBe('pearson');
  });
});
