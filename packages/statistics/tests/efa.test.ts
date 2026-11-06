import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { bootstrapEfa, completeEfa, deserializeEfaModel, fitEfa, parallelAnalysis, rotateLoadings, scoreEfa, serializeEfaModel, type EfaOptions, type EfaModel } from '../src/efa';
import { materializeSelection, type InputTable } from '../src/data';
import { prepareEfa } from '../src/internal/efa/prepare';
import { correlate } from '../src/internal/efa/correlation';
import { fitEfa as kernelFit, scoreEfa as kernelScore } from '../src/internal/efa/fit';
import { conditionalCompletion } from '../src/internal/efa/maximum-likelihood';
import { parallelAnalysis as kernelParallel } from '../src/internal/efa/parallel';
import { rotate } from '../src/internal/efa/rotation';
import { bootstrapStability } from '../src/internal/efa/stability';
import type { EfaSpec } from '../src/internal/efa/types';

const fixture = (name: string): InputTable => JSON.parse(readFileSync(new URL(`../../../frontend/src/lib/__tests__/fixtures/efa-congruence/${name}.input.json`, import.meta.url), 'utf8'));
const input = fixture('normal-complete');
const base: EfaOptions = { items: input.columns.map((column, j) => ({ column, measurement: 'continuous', reverse: j === 1 })), factors: 2, correlation: 'pearson', rotation: 'promax', seed: 61001 };
function reference(table: InputTable, options: EfaOptions) {
  const selected = materializeSelection(table, { columns: options.items.map(item => item.column), rows: options.rows });
  const spec: EfaSpec = { items: options.items.map(item => ({ ...item, categories: [...item.categories ?? []], reverse: item.reverse ?? false })), nFactors: options.factors,
    correlation: options.correlation ?? 'auto', extraction: options.extraction ?? 'minres', rotation: options.rotation ?? 'promax', missing: options.missing ?? 'pairwise', seed: options.seed ?? 61001,
    ...(options.likelihood ? { likelihood: options.likelihood } : {}), label: 'reference', sample: { partition: 'all' } };
  const prepared = prepareEfa(selected.table, spec, Array.from({ length: selected.rows.length }, (_, i) => i));
  const result = kernelFit(prepared, correlate(prepared), spec);
  return { selected, spec, prepared, result };
}
function expectScores(actual: (number | null)[][], expected: (number | null)[][]) {
  expect(actual.length).toBe(expected.length);
  actual.forEach((row, i) => row.forEach((value, j) => value === null ? expect(expected[i][j]).toBeNull() : expect(value).toBeCloseTo(expected[i][j]!, 11)));
}

it('preserves kernel output, full precision, and arbitrary selected-row mapping', async () => {
  const rows = Array.from({ length: 180 }, (_, i) => 360 - i * 2), options = { ...base, rows, missing: 'complete' as const };
  const result = await fitEfa(input, options), ref = reference(input, options);
  expect(result.model.parameters.pattern).toEqual(ref.result.rotation.pattern);
  expect(result.model.parameters.weights).toEqual(ref.result.weights);
  expect(result.model.training.fittingRows).toEqual(rows);
  expectScores(result.scores.scores, kernelScore(ref.prepared, ref.result));
  expect(result.scores.rows).toEqual(rows);
  expect(result.model.parameters.pattern.flat().some(value => value !== Math.round(value * 1000) / 1000)).toBe(true);
  const restored = deserializeEfaModel(serializeEfaModel(result.model));
  const one: InputTable = { columns: input.columns, nRows: 1, data: Object.fromEntries(input.columns.map(column => [column, [input.data[column][rows[0]]]])) };
  expectScores(scoreEfa(restored, one).scores, [result.scores.scores[0]]);
});

it('scores missing new rows with fitted numeric replacements and reverse offsets, without re-estimating preprocessing', async () => {
  const fit = await fitEfa(input, { ...base, rows: Array.from({ length: 150 }, (_, i) => i), missing: 'median' });
  const data = Object.fromEntries(input.columns.map(column => [column, [null, 1000, input.data[column][10]]])) as InputTable['data'];
  const holdout: InputTable = { columns: input.columns, data, nRows: 3 };
  const scored = scoreEfa(fit.model, holdout, { rows: [2, 0, 1] });
  expect(scored.rows).toEqual([2, 0, 1]);
  expectScores([scored.scores[0]], [fit.scores.scores[10]]);
  const z = fit.model.preprocessing.replacements!.map((value, j) => (value - fit.model.preprocessing.means[j]) / fit.model.preprocessing.scales[j]);
  const expected = Array.from({ length: 2 }, (_, f) => z.reduce((sum, value, j) => sum + value * fit.model.parameters.weights[j][f], 0));
  expectScores([scored.scores[1]], [expected]);
  expect(fit.model.preprocessing.reverseOffsets[1]).not.toBe(2000);
});

it.each(['minres', 'dwls', 'wlsmv'] as const)('retains ordinal category order and %s scores through serialization', async extraction => {
  const ordinal = fixture('ordinal-mcar');
  const columns = ordinal.columns.slice(0, 4), categories = [1, 2, 3, 4, 5];
  const options: EfaOptions = { items: columns.map((column, j) => ({ column, categories, reverse: j === 0, measurement: 'ordinal' })), factors: 1, correlation: 'polychoric', extraction, missing: 'median' };
  const result = await fitEfa(ordinal, options), ref = reference(ordinal, options);
  expect(result.model.parameters.pattern).toEqual(ref.result.rotation.pattern);
  expectScores(result.scores.scores, kernelScore(ref.prepared, ref.result));
  const restored = deserializeEfaModel(serializeEfaModel(result.model));
  const one = { columns, nRows: 1, data: Object.fromEntries(columns.map(column => [column, [null]])) };
  expect(scoreEfa(restored, one).scores[0].every(Number.isFinite)).toBe(true);
  expect(() => scoreEfa(restored, { ...one, data: { ...one.data, [columns[0]]: [99] } })).toThrow(/outside the fitted category/);
  if (extraction === 'wlsmv') expect(result.weighted?.robust?.test.statistic).not.toBeNull();
});

it('fits FIML, scores new partial rows, and guards completion by original selected content and missing mask', async () => {
  const raw = fixture('normal-mcar'), rows = Array.from({ length: 240 }, (_, i) => i + 10);
  const options: EfaOptions = { ...base, rows, extraction: 'ml', missing: 'fiml' };
  const fit = await fitEfa(raw, options), ref = reference(raw, options);
  expect(fit.model.status).toBe('converged');
  expect(fit.model.parameters.likelihood!.covariance).toEqual(ref.result.likelihood!.covariance);
  expectScores(fit.scores.scores, kernelScore(ref.prepared, ref.result));
  const restored = deserializeEfaModel(serializeEfaModel(fit.model));
  const completed = await completeEfa(restored, structuredClone(raw));
  const expected = conditionalCompletion(ref.selected.table, ref.spec, ref.result);
  expect(completed.rows).toEqual(expected.rows.map(row => rows[row]));
  expect(completed.values).toEqual(expected.values);
  expect(completed.filled).toEqual(expected.filled);
  for (const [j, column] of completed.columns.entries()) for (const [i, row] of completed.rows.entries()) if (!completed.filled[j][i]) expect(completed.values[j][i]).toBe(raw.data[column][row]);
  const changed = structuredClone(raw) as { columns: string[]; nRows: number; data: Record<string, (number | string | null)[]> };
  changed.data[raw.columns[0]][rows[0]] = 987;
  await expect(completeEfa(restored, changed)).rejects.toMatchObject({ code: 'completion-data' });
  const partial = { columns: raw.columns, nRows: 2, data: Object.fromEntries(raw.columns.map((column, j) => [column, [j === 0 ? raw.data[column][10] ?? 1 : null, null]])) };
  const scores = scoreEfa(restored, partial);
  expect(scores.scores[0].every(Number.isFinite)).toBe(true);
  expect(scores.scores[1]).toEqual([null, null]);
  expect(scores.unscoredRows).toEqual([1]);
});

it('rejects incompatible configuration, workspace selection, malformed models, and cancellation', async () => {
  await expect(fitEfa(input, { ...base, extraction: 'minres', missing: 'fiml' })).rejects.toMatchObject({ code: 'likelihood-method' });
  await expect(fitEfa(input, { ...base, extraction: 'ml', missing: 'complete', likelihood: null } as unknown as EfaOptions)).rejects.toMatchObject({ code: 'likelihood-settings' });
  await expect(fitEfa(input, { ...base, sample: { partition: 'holdout' } } as EfaOptions)).rejects.toMatchObject({ code: 'options' });
  const controller = new AbortController(); controller.abort();
  await expect(fitEfa(input, base, { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
  const result = await fitEfa(input, base), bad = structuredClone(result.model);
  bad.preprocessing.scales[0] = 0;
  expect(() => deserializeEfaModel(JSON.stringify(bad))).toThrow(/preprocessing/);
  expect(() => deserializeEfaModel('{"format":"scatterlab-efa-model/2"}')).toThrow(/format/);
  expect(() => scoreEfa(result.model, { columns: input.columns, nRows: 1, data: Object.fromEntries(input.columns.map(column => [column, ['2']])) })).toThrow(/numeric strings/);
  await expect(completeEfa(result.model, input)).rejects.toMatchObject({ code: 'completion-method' });
  const finiteBad = structuredClone(result.model) as EfaModel;
  finiteBad.parameters.weights[0][0] = NaN;
  expect(() => serializeEfaModel(finiteBad)).toThrow(/dimensions/);
});

it('records complete-case deletion separately from requested rows and leaves incomplete respondents unscored', async () => {
  const raw = fixture('normal-mcar'), rows = Array.from({ length: 140 }, (_, i) => i * 2);
  const fit = await fitEfa(raw, { ...base, rows, missing: 'complete' });
  const complete = rows.filter(row => raw.columns.every(column => raw.data[column][row] !== null));
  expect(fit.model.training.rows).toEqual(rows);
  expect(fit.model.training.fittingRows).toEqual(complete);
  expect(fit.scores.unscoredRows).toEqual(rows.filter(row => !complete.includes(row)));
});

it('uses a copied training snapshot across asynchronous hashing and exposes structured ML nonconvergence', async () => {
  const original = structuredClone(input) as { columns: string[]; data: Record<string, (number | string | null)[]>; nRows: number };
  const pending = fitEfa(original, base);
  original.data[original.columns[0]][0] = 1e8;
  const fit = await pending;
  expectScores([fit.scores.scores[0]], scoreEfa(fit.model, input, { rows: [0] }).scores);
  await expect(fitEfa(input, { ...base, extraction: 'ml', missing: 'complete', likelihood: { maxIterations: 10, tolerance: 1e-10, starts: 1 } }))
    .rejects.toMatchObject({ code: 'ml-nonconvergence', convergenceIssue: { partialAvailable: false } });
});

it('requires explicit opt-in to score a serialized unconverged model', async () => {
  const fit = await fitEfa(input, base), model = structuredClone(fit.model);
  model.status = 'unconverged'; model.convergence.extraction.converged = false;
  const restored = deserializeEfaModel(serializeEfaModel(model));
  expect(() => scoreEfa(restored, input)).toThrow(/allowUnconverged/);
  expectScores(scoreEfa(restored, input, { allowUnconverged: true }).scores, fit.scores.scores);
  await expect(bootstrapEfa(restored, input, { replicates: 2 })).rejects.toMatchObject({ code: 'unconverged-model' });
});

it.each(['promax', 'oblimin', 'varimax'] as const)('exposes %s rotation without altering the extraction loadings', method => {
  const loadings = [[0.8, 0.1], [0.7, 0.2], [0.6, 0.15], [0.1, 0.8], [0.2, 0.7], [0.1, 0.6]], original = structuredClone(loadings);
  const rotated = rotateLoadings(loadings, { method, seed: 42, starts: 2 }), expected = rotate(loadings, method, 42, 2);
  expect(rotated.pattern).toEqual(expected.pattern); expect(rotated.phi).toEqual(expected.phi);
  expect(loadings).toEqual(original);
  rotated.structure.forEach((row, i) => row.forEach((value, j) => expect(value).toBeCloseTo(rotated.pattern[i].reduce((sum, loading, k) => sum + loading * rotated.phi[k][j], 0), 14)));
  expect(() => rotateLoadings([[NaN]], { method })).toThrow(/finite rectangular/);
});

it('preserves parallel-analysis kernel definitions and original complete-case membership', async () => {
  const raw = fixture('normal-mcar'), rows = Array.from({ length: 100 }, (_, i) => i * 2);
  const options = { items: base.items, rows, correlation: 'pearson' as const, missing: 'complete' as const, seed: 42, replicates: 2 };
  const result = await parallelAnalysis(raw, options), ref = reference(raw, { ...options, factors: 1 });
  const expected = kernelParallel(ref.prepared, 42, 2);
  expect(result.nullEigenvalues).toEqual(expected.nullEigenvalues);
  expect(result.reference).toEqual(expected.reference); expect(result.observed).toEqual(expected.observed);
  expect(result.fittingRows).toEqual(ref.prepared.rows.map(row => rows[row]));
  expect(result.provenance?.inputSha256).toMatch(/^[0-9a-f]{64}$/);
  await expect(parallelAnalysis(raw, { ...options, replicates: 0 })).rejects.toMatchObject({ code: 'replicates' });
});

it('bootstraps the saved training data and returns original row indices, including repetitions', async () => {
  const raw = fixture('normal-mcar'), rows = Array.from({ length: 150 }, (_, i) => 300 - i * 2);
  const fitOptions = { ...base, rows, missing: 'median' as const }, fit = await fitEfa(raw, fitOptions), ref = reference(raw, fitOptions);
  const options = { replicates: 2, seed: 4242, confidence: 0.9, crossLoadingThreshold: 0.25 };
  const expected = bootstrapStability(ref.prepared, ref.spec, ref.result, options), result = await bootstrapEfa(fit.model, raw, options);
  expect(result.pattern).toEqual(expected.pattern); expect(result.failures).toEqual(expected.failures);
  expect(result.sampleRows).toEqual(expected.samples.map(sample => sample.map(row => rows[ref.prepared.rows[row]])));
  expect(result.completed + result.failures.length).toBe(2);
  const groups = Array.from({ length: raw.nRows }, (_, row) => `group-${Math.floor(row / 40)}`);
  const clustered = await bootstrapEfa(fit.model, raw, { ...options, groups });
  for (const sample of clustered.sampleRows) {
    const counts = new Map<number, number>(); sample.forEach(row => counts.set(row, (counts.get(row) ?? 0) + 1));
    for (const group of new Set(rows.map(row => groups[row]))) {
      const members = rows.filter(row => groups[row] === group);
      expect(new Set(members.map(row => counts.get(row) ?? 0)).size).toBe(1);
    }
  }
  const changed = structuredClone(raw) as { columns: string[]; nRows: number; data: Record<string, (number | string | null)[]> };
  changed.data[raw.columns[0]][rows[0]] = 987;
  await expect(bootstrapEfa(fit.model, changed, options)).rejects.toMatchObject({ code: 'resampling-data' });
  await expect(bootstrapEfa(fit.model, raw, { ...options, groups: ['a'] })).rejects.toMatchObject({ code: 'resampling-groups' });
  const controller = new AbortController();
  await expect(bootstrapEfa(fit.model, raw, options, { signal: controller.signal, onProgress: () => controller.abort() })).rejects.toMatchObject({ code: 'cancelled' });
});
