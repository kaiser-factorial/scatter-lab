import { expect, it } from 'vitest';
import { conditionalCompletion } from '../efa/maximum-likelihood';
import { addCompletionColumns, completionOperation, serializeCompletionCsv } from '../efa/completion';
import type { DataTable } from '../table';
import type { EfaResult, EfaRun, EfaSpec } from '../efa/types';

// Fixed Gaussian model gives independent, exact conditional-mean expectations.
const table: DataTable = { columns: ['A', 'B', 'C'], nRows: 4,
  data: { A: [0, null, 7, 99], B: [2, 4, null, 88], C: [1, 3, 5, 77] } };
const spec: EfaSpec = { items: table.columns.map(column => ({ column, categories: [], reverse: false })),
  extraction: 'ml', correlation: 'pearson', missing: 'fiml', nFactors: 1, rotation: 'promax', seed: 1, label: 'Test', sample: { partition: 'all' } };
const result = { likelihood: { means: [0, 0, 0], covariance: [[2, 1, 0], [1, 2, 0], [0, 0, 1]], residualVariances: [1, 1, 1], settings: {}, logLikelihood: -10 },
  rotation: { pattern: [[1 / Math.sqrt(2)], [1 / Math.sqrt(2)], [0]], phi: [[1]] }, sds: [Math.sqrt(2), Math.sqrt(2), 1],
  originalRowCount: 4, fittingRows: [0, 1, 2], provenance: { inputSha256: 'fixed-model-fixture', engine: 'test' } } as EfaResult;
const run = { id: 'fit', spec, result } as EfaRun;

it('adds completed copies with collision-safe names while preserving observed and excluded source cells', () => {
  const input = structuredClone(table);
  input.columns.push('A_completed_Test'); input.data.A_completed_Test = [1, 1, 1, 1];
  const completion = conditionalCompletion(input, spec, result);
  expect(completion.completedCells).toBe(2);
  expect(completion.values[0]).toEqual([0, expect.closeTo(2, 14), 7]);
  expect(completion.values[1]).toEqual([2, 4, expect.closeTo(3.5, 14)]);
  const added = addCompletionColumns(input, run, completion);
  expect(added.record.columns.A).toBe('A_completed_Test_2');
  expect(added.table.data.A_completed_Test_2).toEqual([0, expect.closeTo(2, 14), 7, 99]);
  expect(added.table.data.B_completed_Test).toEqual([2, 4, expect.closeTo(3.5, 14), 88]);
  expect(added.table.data.A).toEqual(table.data.A);
  expect(input.data.A).toEqual(table.data.A);
  expect(added.record).toMatchObject({ method: 'conditional-gaussian-mean', filledCells: 2, rows: [0, 1, 2], sourceFingerprint: 'fixed-model-fixture' });
});

it('exports only the fitted rows, original gaps, model settings and calculation masks', () => {
  const completion = conditionalCompletion(table, spec, result);
  const operation = completionOperation(table, run, completion);
  expect(operation.input).toEqual([[0, 2, 1], [null, 4, 3], [7, null, 5]]);
  expect(operation.completed).toEqual([[0, 2, 1], [expect.closeTo(2, 14), 4, 3], [7, expect.closeTo(3.5, 14), 5]]);
  expect(operation.filled).toEqual([[false, false, false], [true, false, false], [false, true, false]]);
  const csv = serializeCompletionCsv(completion).trim().split('\r\n');
  expect(csv[0]).toBe('source_row,A,B,C');
  expect(csv.slice(1).map(line => line.split(',').map(Number))).toEqual([[1, 0, 2, 1], [2, expect.closeTo(2, 14), 4, 3], [3, 7, expect.closeTo(3.5, 14), 5]]);
  expect(operation.rows).toEqual([0, 1, 2]);
});

it('refuses completion publication with different item or row membership', () => {
  const completion = conditionalCompletion(table, spec, result);
  expect(() => addCompletionColumns(table, run, { ...completion, rows: [0, 1, 3] })).toThrow(/match/);
  expect(() => addCompletionColumns(table, run, { ...completion, columns: ['B', 'A', 'C'] })).toThrow(/match/);
  expect(() => addCompletionColumns(table, run, { ...completion, values: [] })).toThrow(/match/);
  expect(() => addCompletionColumns(table, run, { ...completion, completedCells: 3 })).toThrow(/count/);
  completion.filled[0][0] = true;
  expect(() => addCompletionColumns(table, run, completion)).toThrow(/observed/);
});
