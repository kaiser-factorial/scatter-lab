import { describe, expect, it } from 'vitest';
import { convergenceIssueSummary, convergenceRetryError, iterativePcaSettings, type ConvergenceIssue } from '../convergence';
import { imputeIterativePCA, runPCA } from '../pca';
import { minimizeLikelihood, type LikelihoodProblem } from '../efa/maximum-likelihood';
import type { DataTable } from '../table';

const table: DataTable = { columns: ['a', 'b', 'c'], nRows: 8,
  data: { a: [1, 2, null, 4, 5, 6, 7, 8], b: [2, 4, 6, 8, null, 12, 14, 16], c: [1, 3, 5, 7, 9, 11, null, 15] } };

describe('iterative PCA convergence controls', () => {
  it('preserves defaults and records the actual resolved reconstruction rank and settings', () => {
    const implicit = runPCA(table, table.columns, { k: 2, missing: 'iterative' });
    const explicit = runPCA(table, table.columns, { k: 2, missing: 'iterative', iterative: { maxIterations: 200, tolerance: 1e-8 } });
    expect(explicit).toEqual(implicit);
    expect(implicit.missing.iterativeSettings).toEqual({ maxIterations: 200, tolerance: 1e-8, rank: 2 });
    expect(implicit.missing.converged).toBe(true); expect(implicit.missing.convergenceIssue).toBeUndefined();
    const changed = runPCA(table, table.columns, { k: 2, missing: 'iterative', iterative: { rank: 1 } });
    expect(changed.k).toBe(2);
    expect(changed.missing.iterativeSettings?.rank).toBe(1);
    expect(changed.eigenvalues).not.toEqual(implicit.eigenvalues);
  });
  it('returns a finite provisional result with a typed issue at the cap, then genuinely converges with a larger budget', () => {
    const before = structuredClone(table), stopped = runPCA(table, table.columns, { k: 2, missing: 'iterative', iterative: { maxIterations: 1 } });
    expect(stopped.missing.converged).toBe(false);
    expect(stopped.missing.convergenceIssue).toMatchObject({ method: 'iterative-pca', reason: 'iteration-limit', iterations: 1,
      criterion: 1, partialAvailable: true, settings: { maxIterations: 1, tolerance: 1e-8, rank: 2 } });
    expect(stopped.table.data.PC1.every(value => typeof value === 'number' && Number.isFinite(value))).toBe(true);
    const retried = runPCA(table, table.columns, { k: 2, missing: 'iterative', iterative: { maxIterations: 1000, tolerance: 1e-8, rank: 2 } });
    expect(retried.missing.converged).toBe(true); expect(retried.missing.convergenceIssue).toBeUndefined();
    expect(retried.missing.iterations).toBeGreaterThan(1);
    expect(table).toEqual(before);
    const raw = imputeIterativePCA(table.columns.map(column => table.data[column] as (number | null)[]), { rank: 2, maxIter: 1 });
    table.columns.forEach((column, j) => table.data[column].forEach((value, i) => { if (value !== null) expect(raw.columns[j][i]).toBe(value); }));
  });
  it('rejects invalid or inapplicable public settings before calculation', () => {
    for (const iterative of [{ maxIterations: 0 }, { maxIterations: 1.5 }, { maxIterations: 20001 }, { tolerance: NaN }, { tolerance: 0 }, { rank: 1.5 }, { rank: 0 }])
      expect(() => runPCA(table, table.columns, { missing: 'iterative', iterative })).toThrow(/Iterative PCA/);
    expect(() => runPCA(table, table.columns, { missing: 'median', iterative: { maxIterations: 1000 } })).toThrow(/require the iterative/);
    expect(iterativePcaSettings(undefined, 3)).toEqual({ maxIterations: 200, tolerance: 1e-8, rank: 3 });
  });
});

describe('likelihood stopping diagnostics', () => {
  const settings = { maxIterations: 10, tolerance: 1e-7, starts: 1, uniquenessFloor: 1e-6 };
  const problem = (objective: LikelihoodProblem['objective']): LikelihoodProblem => ({ p: 1, k: 1, nRows: 3, observedCells: 3, allMissingRows: 0,
    patterns: [], centers: [0], scales: [1], objective });
  it('distinguishes convergence, iteration limits, domain line-search failures, and unrepresentable parameter steps', () => {
    const quadratic = minimizeLikelihood(problem(x => ({ value: x[0] ** 2 / 2, gradient: [x[0], 0, 0] })), [1, 0, 0], settings);
    expect(quadratic).toMatchObject({ converged: true, reason: 'converged', gradient: 0 });
    const capped = minimizeLikelihood(problem(x => ({ value: Math.exp(x[0]), gradient: [Math.exp(x[0]), 0, 0] })), [1, 0, 0], { ...settings, maxIterations: 1 });
    expect(capped).toMatchObject({ converged: false, reason: 'iteration-limit', iterations: 1 });
    const domain = minimizeLikelihood(problem(x => ({ value: x[0] < 0 ? Infinity : x[0], gradient: [1, 0, 0] })), [0, 0, 0], settings);
    expect(domain).toMatchObject({ converged: false, reason: 'line-search', iterations: 0 });
    const stalled = minimizeLikelihood(problem(x => ({ value: x[0], gradient: [1, 0, 0] })), [1e20, 0, 0], settings);
    expect(stalled).toMatchObject({ converged: false, reason: 'stalled', iterations: 0 });
    const nonFinite = minimizeLikelihood(problem(() => ({ value: Infinity, gradient: [0, 0, 0] })), [0, 0, 0], settings);
    expect(nonFinite).toMatchObject({ converged: false, reason: 'non-finite' });
  });
  it('projects diagnostics to an aggregate whitelist and disallows keeping a failed likelihood fit', () => {
    const issue = { method: 'fiml', reason: 'iteration-limit', settings: { ...settings, rawValues: ['private-value'] },
      iterations: 10, objective: Infinity, gradient: NaN, partialAvailable: true, rawValues: ['private-value'],
      starts: [{ start: 1, iterations: 10, reason: 'iteration-limit', objective: Infinity, gradient: NaN, parameters: ['private-value'] }] };
    const safe = convergenceIssueSummary(issue as unknown as ConvergenceIssue);
    expect(JSON.stringify(safe)).not.toContain('private-value');
    expect(safe).toMatchObject({ objective: null, gradient: null, partialAvailable: false });
    expect(convergenceRetryError('fiml', settings)).toBeUndefined();
    expect(convergenceRetryError('fiml', { ...settings, tolerance: 1 })).toContain('tolerance');
  });
});
