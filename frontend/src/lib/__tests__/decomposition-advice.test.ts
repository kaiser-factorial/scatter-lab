import { describe, expect, it } from 'vitest';
import { adviceForAssistant, analyzeDecompositionItems } from '../decomposition-advice';
import type { DataTable } from '../table';

const tableOf = (data: Record<string, (number | string | null)[]>): DataTable => ({ columns: Object.keys(data), data, nRows: Object.values(data)[0].length });
const continuous = (n = 80) => tableOf({ A: Array.from({ length: n }, (_, i) => i / 10 + Math.sin(i) / 100), B: Array.from({ length: n }, (_, i) => 5 + i / 8), C: Array.from({ length: n }, (_, i) => 20 - i / 13) });
const ordinal = () => tableOf({ A: Array.from({ length: 80 }, (_, i) => i % 5 + 1), B: Array.from({ length: 80 }, (_, i) => i % 4 + 1), C: Array.from({ length: 80 }, (_, i) => i % 3 + 1) });

describe('deterministic decomposition advice', () => {
  it('treats small repeated integers as candidates, never as confirmed measurement meaning', () => {
    const table = ordinal(), result = analyzeDecompositionItems(table, table.columns);
    expect(result.items.every(item => item.classification === 'ordinal-candidate' && !item.confirmed)).toBe(true);
    expect(result.recommendations[0].patch).toEqual({ correlation: 'polychoric', extraction: 'minres' });
    expect(result.recommendations[0].assumptions.join(' ')).toMatch(/Confirm/);
    expect(result.recommendations.some(r => r.patch.extraction === 'wlsmv')).toBe(true);
    expect(result.recommendations.every(r => !('measurements' in r.patch))).toBe(true);
    expect(result).toEqual(analyzeDecompositionItems(table, table.columns));
  });
  it('respects explicit continuous treatment of small integer-valued measurements', () => {
    const table = ordinal(), result = analyzeDecompositionItems(table, table.columns, { measurements: { A: 'continuous', B: 'continuous', C: 'continuous' } });
    expect(result.items.every(item => item.classification === 'continuous' && item.confirmed)).toBe(true);
    expect(result.recommendations[0].patch).toEqual({ correlation: 'pearson', extraction: 'ml', missing: 'complete' });
    expect(result.recommendations[0].assumptions.join(' ')).toMatch(/cannot establish multivariate normality/);
  });
  it('requires declared text order and never leaks category labels through the report', () => {
    const table = tableOf({ A: Array.from({ length: 80 }, (_, i) => i % 2 ? 'PRIVATE_ROW_CANARY' : 'other'), B: Array.from({ length: 80 }, (_, i) => i % 3), C: Array.from({ length: 80 }, (_, i) => i % 4) });
    const unknown = analyzeDecompositionItems(table, table.columns);
    expect(unknown.items[0].classification).toBe('nominal'); expect(unknown.recommendations).toEqual([]);
    const ordered = analyzeDecompositionItems(table, table.columns, { orders: { A: ['other', 'PRIVATE_ROW_CANARY'] } });
    expect(ordered.items[0]).toMatchObject({ classification: 'ordinal', confirmed: true });
    expect(JSON.stringify(ordered)).not.toContain('PRIVATE_ROW_CANARY');
    expect(JSON.stringify(adviceForAssistant(ordered))).not.toContain('PRIVATE_ROW_CANARY');
    const bad = analyzeDecompositionItems(table, table.columns, { orders: { A: ['other'] } });
    expect(bad.items[0].classification).toBe('invalid');
  });
  it('does not call unique integers ordinal or identifiers based on uniqueness alone', () => {
    const table = tableOf({ A: Array.from({ length: 80 }, (_, i) => i), B: Array.from({ length: 80 }, (_, i) => i + 10), C: Array.from({ length: 80 }, (_, i) => i * 2) });
    const result = analyzeDecompositionItems(table, table.columns);
    expect(result.items.every(item => item.classification === 'continuous-candidate' && !item.confirmed)).toBe(true);
  });
  it('normalizes finite numeric strings for diagnostics and marks the EFA storage conversion requirement', () => {
    const table = continuous(); table.data.A = table.data.A.map(String);
    const pca = analyzeDecompositionItems(table, table.columns, { method: 'pca' });
    expect(pca.items[0]).toMatchObject({ classification: 'continuous-candidate', numericStrings: 80 });
    expect(pca.issues.some(issue => issue.severity === 'blocker')).toBe(false);
    const efa = analyzeDecompositionItems(table, table.columns);
    expect(efa.issues.some(issue => issue.code === 'numeric-text-storage' && issue.severity === 'blocker')).toBe(true);
    expect(table.data.A[0]).toBe('0');
  });
  it('blocks identifiers, empty, constant and nonfinite columns without exposing their values', () => {
    const table = tableOf({ ResponseId: Array.from({ length: 30 }, (_, i) => i), empty: Array(30).fill(null), constant: Array(30).fill('SECRET_CONSTANT'), invalid: Array.from({ length: 30 }, (_, i) => i === 10 ? Infinity : i) });
    const result = analyzeDecompositionItems(table, table.columns);
    expect(result.items.map(item => item.classification)).toEqual(['identifier', 'empty', 'constant', 'invalid']);
    expect(result.recommendations).toEqual([]); expect(JSON.stringify(result)).not.toContain('SECRET_CONSTANT');
  });
  it('uses finite descriptive shape flags without claiming normality or inferring missingness mechanisms', () => {
    const table = continuous(); table.data.A[79] = 1e300; table.data.B[3] = null;
    const result = analyzeDecompositionItems(table, table.columns, { measurements: { A: 'continuous', B: 'continuous', C: 'continuous' } });
    expect(result.items[0].distribution).toMatchObject({ assessed: true, skewed: true, heavyTailed: true });
    expect(Number.isFinite(result.items[0].distribution!.skewness)).toBe(true);
    expect(result.recommendations[0].patch).toEqual({ correlation: 'pearson', extraction: 'minres' });
    const fiml = result.recommendations.find(r => r.patch.missing === 'fiml')!;
    expect(fiml.priority).toBe('conditional'); expect(fiml.assumptions.join(' ')).toMatch(/do not infer MAR or MCAR/);
    expect(result.diagnosticBasis.join(' ')).toMatch(/cannot determine MCAR, MAR or MNAR/);
  });
  it('keeps mixed measurement explicit and repairs incompatible missing policies only in the displayed patch', () => {
    const table = continuous(); table.data.A = ordinal().data.A;
    const result = analyzeDecompositionItems(table, table.columns, { missing: 'fiml' });
    expect(result.issues.some(issue => issue.code === 'mixed-measurement')).toBe(true);
    expect(result.recommendations[0]).toMatchObject({ priority: 'conditional', patch: { correlation: 'pearson', extraction: 'minres', missing: 'complete' } });
    expect(result.recommendations[0].assumptions.join(' ')).toMatch(/does not relabel/);
  });
  it('calculates exact observed pair support across bitset word boundaries and keeps zero as observed', () => {
    const table = ordinal(); table.data.A[0] = 0;
    for (const i of [1, 31, 32, 33, 65]) table.data.A[i] = null;
    for (const i of [2, 31, 34, 65, 79]) table.data.B[i] = null;
    const result = analyzeDecompositionItems(table, table.columns, { minimumPairN: 5 });
    expect(result.sample.minimumObservedPairN).toBe(72);
    expect(result.sample.completeRows).toBe(72); expect(result.sample.missingCells).toBe(10);
    expect(result.sample.missingnessPatternCount).toBe(4);
    expect(result.items[0].observed).toBe(75); expect(result.sample.pairSupportChecked).toBe(true);
  });
  it('marks the missing-pattern count as a lower bound when the storage cap is reached', () => {
    const n = 4097, table = tableOf(Object.fromEntries(Array.from({ length: 13 }, (_, j) => [`C${j}`, Array.from({ length: n }, (_, i) => i & (1 << j) ? null : i % 5)])));
    const result = analyzeDecompositionItems(table, table.columns);
    expect(result.sample.missingnessPatternCount).toBe(4096); expect(result.sample.missingnessPatternsTruncated).toBe(true);
    expect(result.sample.missingnessHistogram.reduce((sum, bin) => sum + bin.rows, 0)).toBe(n);
  });
  it('does not extrapolate a shape screen from fewer than twenty observed values', () => {
    const table = continuous(12), result = analyzeDecompositionItems(table, table.columns);
    expect(result.items[0].distribution?.assessed).toBe(false);
    expect(result.recommendations[0].patch.extraction).toBe('minres');
  });
  it('does not offer PCA of ordered text, or a fit with too few selected items', () => {
    const table = ordinal(); table.data.A = table.data.A.map(v => `level-${v}`);
    const result = analyzeDecompositionItems(table, table.columns, { method: 'pca', orders: { A: ['level-1', 'level-2', 'level-3', 'level-4', 'level-5'] } });
    expect(result.issues.some(issue => issue.code === 'pca-nonnumeric')).toBe(true); expect(result.recommendations).toEqual([]);
    expect(analyzeDecompositionItems(table, ['B'], { method: 'pca' }).recommendations).toEqual([]);
  });
  it('does not offer ordinal MICE when declared outcome categories are unobserved', () => {
    const table = ordinal(); table.data.A[1] = null;
    const report = analyzeDecompositionItems(table, table.columns, { orders: { A: [1, 2, 3, 4, 5, 6] } });
    expect(report.issues.some(issue => issue.code === 'unobserved-declared-categories')).toBe(true);
    expect(report.recommendations.some(rec => rec.patch.missing === 'mice')).toBe(false);
    expect(report.recommendations[0].patch.extraction).toBe('minres');
  });
  it('does not offer Pearson for mixed continuous and ordered-text items', () => {
    const table = continuous(); table.data.A = table.data.A.map((_, i) => i % 2 ? 'yes' : 'no');
    const report = analyzeDecompositionItems(table, table.columns, { orders: { A: ['no', 'yes'] } });
    expect(report.issues.some(issue => issue.code === 'mixed-text-measurement' && issue.severity === 'blocker')).toBe(true);
    expect(report.recommendations).toEqual([]);
  });
});

describe('assistant advice disclosure', () => {
  it('withholds small whole fitting samples and per-item insufficient support', () => {
    const small = continuous(4), report = adviceForAssistant(analyzeDecompositionItems(small, small.columns));
    expect(report.withheld).toBe(true); expect(report.items).toEqual([]); expect(report.recommendations).toEqual([]); expect(report.sample.rows).toBe('withheld');
    const table = continuous(); table.data.A = table.data.A.map((v, i) => i < 3 ? v : null);
    const safe = adviceForAssistant(analyzeDecompositionItems(table, table.columns));
    expect(safe.items[0]).toMatchObject({ classification: 'withheld', observed: 'withheld', missing: 'withheld' });
    expect(safe.items[0].distribution).toBeUndefined(); expect(safe.sample.minimumObservedPairN).toBe('withheld');
  });
  it('suppresses complementary row counts and ratios that would reconstruct rare missing counts', () => {
    const table = continuous(); table.data.A[1] = null;
    const safe = adviceForAssistant(analyzeDecompositionItems(table, table.columns));
    expect(safe.items[0].observed).toBe('withheld'); expect(safe.items[0].missing).toBe('withheld');
    expect(safe.sample.completeRows).toBe('withheld'); expect(safe.sample.incompleteRows).toBe('withheld');
    expect(safe.sample.missingCells).toBe('withheld'); expect(safe.sample.missingRate).toBeNull();
    expect(safe.sample.missingnessHistogram).toEqual([]); expect(safe.sample.histogramWithheld).toBe(true);
  });
  it('bounds item and issue pages and rejects malformed inputs with data-independent errors', () => {
    const table = tableOf(Object.fromEntries(Array.from({ length: 30 }, (_, j) => [`C${j}`, Array.from({ length: 30 }, (_, i) => i / (j + 1))])));
    const report = analyzeDecompositionItems(table, table.columns), safe = adviceForAssistant(report);
    expect(safe.items).toHaveLength(20); expect(safe.nextOffset).toBe(20);
    expect(adviceForAssistant(report, 5, 20).items).toHaveLength(10);
    expect(() => adviceForAssistant(report, 5, 0, 50)).toThrow(/page size/);
    expect(() => analyzeDecompositionItems(table, ['secret-not-a-column'])).toThrow('Choose 1–500 distinct columns from a valid fitting table.');
  });
});
