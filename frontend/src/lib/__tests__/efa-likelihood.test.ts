import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../random';
import type { DataTable } from '../table';
import { prepareEfa, validateSpec } from '../efa/prepare';
import { correlate } from '../efa/correlation';
import { fitEfa, scoreEfa } from '../efa/fit';
import { conditionalCompletion, conditionalCompletionPrepared, likelihoodSettings } from '../efa/maximum-likelihood';
import { EfaError, type EfaSpec } from '../efa/types';

function sample(missing = false) {
  const random = mulberry32(8134), normal = () => Math.sqrt(-2 * Math.log(Math.max(1e-12, random()))) * Math.cos(2 * Math.PI * random());
  const columns = Array.from({ length: 6 }, (_, j) => `item${j}`), nRows = 240;
  const data: DataTable['data'] = Object.fromEntries(columns.map(column => [column, []]));
  for (let i = 0; i < nRows; i++) {
    const factors = [normal(), normal()];
    columns.forEach((column, j) => data[column].push(missing && (i === nRows - 1 || random() < .18) ? null : (j + 1) * .7 + (j + 1) * (.7 * factors[Math.floor(j / 3)] + .25 * factors[1 - Math.floor(j / 3)] + .55 * normal())));
  }
  const table: DataTable = { columns, data, nRows };
  const spec: EfaSpec = { items: columns.map(column => ({ column, categories: [], reverse: false, measurement: 'continuous' })), nFactors: 2, seed: 19, rotation: 'oblimin', correlation: 'pearson', extraction: 'ml', missing: missing ? 'fiml' : 'complete', label: 'ML test', sample: { partition: 'all' }, likelihood: { starts: 1 } };
  return { table, spec };
}
function fit(table: DataTable, spec: EfaSpec) {
  const prepared = prepareEfa(table, spec, Array.from({ length: table.nRows }, (_, i) => i));
  return { prepared, result: fitEfa(prepared, correlate(prepared), spec) };
}

describe('Gaussian ML and FIML', () => {
  it('matches complete-data FIML and estimates population-denominator means and variances', () => {
    const { table, spec } = sample();
    const a = fit(table, spec).result, b = fit(table, { ...spec, missing: 'fiml' }).result;
    expect(a.extraction.estimator).toBe('ml');
    expect(a.likelihood?.logLikelihood).toBeCloseTo(b.likelihood!.logLikelihood, 8);
    expect(a.likelihood!.covariance).toEqual(b.likelihood!.covariance);
    table.columns.forEach((column, j) => {
      const values = table.data[column] as number[], mean = values.reduce((sum, x) => sum + x, 0) / table.nRows;
      const variance = values.reduce((sum, x) => sum + (x - mean) ** 2, 0) / table.nRows;
      expect(a.means[j]).toBeCloseTo(mean, 6);
      expect(a.likelihood!.covariance[j][j]).toBeCloseTo(variance, 4);
      expect(a.uniquenesses[j]).toBeCloseTo(a.likelihood!.residualVariances[j] / variance, 5);
    });
  });
  it('conditions on partial observations without filling inputs, and keeps uninformative rows empty', () => {
    const { table, spec } = sample(true), before = structuredClone(table);
    spec.items[2].reverse = true;
    const { prepared, result } = fit(table, spec), scores = scoreEfa(prepared, result);
    expect(result.likelihood!.allMissingRows).toBe(1);
    expect(result.likelihood!.nRows).toBe(table.nRows - 1);
    expect(result.likelihood!.patternCount).toBeGreaterThan(1);
    const incomplete = Array.from({ length: table.nRows - 1 }, (_, i) => i).find(i => table.columns.some(column => table.data[column][i] === null))!;
    expect(scores[incomplete].every(Number.isFinite)).toBe(true);
    expect(scores.at(-1)).toEqual([null, null]);
    const completed = conditionalCompletion(table, spec, result), worker = conditionalCompletionPrepared(prepared, result);
    expect(completed.completedCells).toBeGreaterThan(0);
    expect(worker.completedCells).toBe(completed.completedCells);
    expect(completed.uninformativeRows).toEqual([table.nRows - 1]);
    table.columns.forEach((column, j) => completed.rows.forEach((row, at) => {
      if (table.data[column][row] !== null) expect(completed.values[j][at]).toBe(table.data[column][row]);
      else if (row !== table.nRows - 1) expect(Number.isFinite(completed.values[j][at])).toBe(true);
      if (worker.values[j][at] !== null) expect(worker.values[j][at]).toBeCloseTo(completed.values[j][at]!, 12);
    }));
    expect(table).toEqual(before);
  });
  it('validates likelihood settings and rejects incompatible model combinations explicitly', () => {
    const { spec } = sample();
    expect(() => validateSpec({ ...spec, missing: 'pairwise' })).toThrow(/raw-data likelihood/);
    expect(() => validateSpec({ ...spec, missing: 'fiml', extraction: 'minres', likelihood: undefined })).toThrow(/FIML requires/);
    expect(() => validateSpec({ ...spec, correlation: 'polychoric' })).toThrow(/numeric responses/);
    expect(() => likelihoodSettings({ tolerance: NaN })).toThrow(/tolerance/);
    expect(() => likelihoodSettings({ starts: 0 })).toThrow(/starts/);
    expect(() => likelihoodSettings({ uniquenessFloor: 0 })).toThrow(/floor/);
  });
  it('rejects an unconverged FIML fit with structured aggregate diagnostics instead of a publishable model', () => {
    const { table, spec } = sample(true);
    spec.likelihood = { starts: 2, maxIterations: 10, tolerance: 1e-10 };
    let failure: unknown;
    try { fit(table, spec); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(EfaError);
    const error = failure as EfaError;
    expect(error.code).toBe('ml-nonconvergence');
    expect(error.convergenceIssue).toMatchObject({ method: 'fiml', reason: 'iteration-limit', partialAvailable: false,
      settings: { starts: 2, maxIterations: 10, tolerance: 1e-10, uniquenessFloor: 1e-6 } });
    expect(error.convergenceIssue?.starts).toHaveLength(2);
    expect(error.convergenceIssue?.starts?.every(start => start.reason === 'iteration-limit' && start.iterations === 10)).toBe(true);
    expect(JSON.stringify(error.convergenceIssue)).not.toContain('item0');
    expect(fit(table, { ...spec, likelihood: { ...spec.likelihood, maxIterations: 2000 } }).result.likelihood?.starts.some(start => start.converged)).toBe(true);
  });
});
