import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { prepareEfa } from '../efa/prepare';
import { correlate } from '../efa/correlation';
import { fitEfa } from '../efa/fit';
import { conditionalCompletion } from '../efa/maximum-likelihood';
import { matchFactors } from '../efa/compare';
import { imputeIterativePCA } from '../pca';
import type { DataTable } from '../table';
import type { EfaSpec, Rotation } from '../efa/types';

const folder = new URL('./fixtures/efa-congruence/', import.meta.url);
const read = (file: string) => JSON.parse(readFileSync(new URL(file, folder), 'utf8'));
const diff = (a: number[][], b: number[][]) => Math.max(0, ...a.flatMap((row, i) => row.map((v, j) => Math.abs(v - b[i][j]))));
type Input = DataTable & { nFactors: number; ordinal: boolean };
type Reference = { status: string; converged: boolean; nRows: number; logLikelihood: number; covariance: number[][]; means: number[]; conditional: { row: number; column: number; value: number }[]; rotations: Record<Rotation, { pattern: number[][]; phi: number[][] }> };

describe('independent lavaan ML/FIML public-data and synthetic references', () => {
  for (const name of ['normal-mcar', 'holzinger-mar', 'bfi25-original']) it(`${name}: observed likelihood, covariance, conditional completion and three rotations`, () => {
    const input = read(`${name}.input.json`) as Input, refs = read(`${name}.reference.json`) as { provenance: { inputSha256: string }; ml: { fiml: Reference } }, ref = refs.ml.fiml;
    expect(createHash('sha256').update(readFileSync(new URL(`${name}.input.json`, folder))).digest('hex')).toBe(refs.provenance.inputSha256);
    expect(ref.status).toBe('ok'); expect(ref.converged).toBe(true);
    const spec: EfaSpec = { items: input.columns.map(column => ({ column, reverse: false, measurement: input.ordinal ? 'ordinal' : 'continuous', categories: input.ordinal ? [...new Set(input.data[column].filter((v): v is number => typeof v === 'number'))].sort((a, b) => a - b) : [] })), extraction: 'ml', correlation: 'pearson', missing: 'fiml', rotation: 'promax', nFactors: input.nFactors, seed: 73021, label: name, sample: { partition: 'all' } }, data = prepareEfa(input, spec, Array.from({ length: input.nRows }, (_, i) => i)), cor = correlate(data), first = fitEfa(data, cor, spec);
    expect(first.extraction.convergence.converged).toBe(true);
    expect(diff(first.likelihood!.covariance, ref.covariance)).toBeLessThan(2e-4);
    expect(Math.abs(first.likelihood!.logLikelihood - ref.logLikelihood) / ref.nRows).toBeLessThan(1e-7);
    const completion = conditionalCompletion(input, spec, first), rowMap = new Map(completion.rows.map((row, i) => [row, i]));
    expect(Math.max(...ref.conditional.map(cell => Math.abs(completion.values[cell.column][rowMap.get(cell.row)!]! - cell.value)))).toBeLessThan(5e-4);
    for (const rotation of ['promax', 'oblimin', 'varimax'] as const) {
      const result = rotation === 'promax' ? first : fitEfa(data, cor, { ...spec, rotation }, undefined, first.extraction), expected = ref.rotations[rotation], match = matchFactors(expected.pattern, result.rotation.pattern);
      expect(result.rotation.convergence.converged).toBe(true);
      expect(diff(result.rotation.pattern.map(row => match.mapping.map((j, i) => row[j!] * match.signs[i])), expected.pattern)).toBeLessThan(1e-3);
      expect(diff(match.mapping.map((i, a) => match.mapping.map((j, b) => result.rotation.phi[i!][j!] * match.signs[a] * match.signs[b])), expected.phi)).toBeLessThan(1e-3);
    }
  });
});
it('preserves the missMDA finite-iteration completion contract on missing public data', () => {
  const name = 'holzinger-mcar', input = read(`${name}.input.json`) as Input;
  const refs = read(`${name}.reference.json`) as { pca: Record<string, { status: string; imputed: { row: number; column: number; value: number }[] }> };
  for (const standardize of [true, false]) {
    const reference = refs.pca[`iterative-${standardize ? 'scaled' : 'raw'}`];
    expect(reference.status).toBe('ok');
    const result = imputeIterativePCA(input.columns.map(column => input.data[column] as (number | null)[]), { rank: input.nFactors, standardize, maxIter: 200, tol: 1e-8 });
    expect(Math.max(...reference.imputed.map(cell => Math.abs(result.columns[cell.column][cell.row] - cell.value)))).toBeLessThan(1e-5);
  }
});
