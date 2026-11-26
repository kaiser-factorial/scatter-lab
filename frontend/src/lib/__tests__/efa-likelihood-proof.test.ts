import { expect, it } from 'vitest';
import { Matrix, determinant, inverse } from 'ml-matrix';
import { conditionalCompletion, conditionalGaussianMean, createConditionalProjector, createLikelihoodProblem } from '../efa/maximum-likelihood';
import type { EfaPreparedData, EfaResult, EfaSpec } from '../efa/types';

const spec = { items: ['a', 'b', 'c'].map(column => ({ column, categories: [], reverse: false, measurement: 'continuous' })),
  nFactors: 1, extraction: 'ml', correlation: 'pearson', missing: 'fiml', rotation: 'promax', seed: 1, label: 'test', sample: { partition: 'all' } } as EfaSpec;
function sample(perPattern: number): EfaPreparedData {
  const n = perPattern * 2 + 1, numeric = new Float64Array(n * 3), observed = new Uint8Array(n * 3);
  for (let j = 0; j < 3; j++) for (let i = 0; i < n; i++) {
    numeric[j * n + i] = Math.sin(i * .71 + j) + j * .4 + i * .03;
    observed[j * n + i] = i === n - 1 || (j === 2 && i >= perPattern) ? 0 : 1;
  }
  return { items: spec.items, nRows: n, originalRowCount: n, rows: Array.from({ length: n }, (_, i) => i), numeric, observed,
    codes: new Uint16Array(n * 3), means: [0, 0, 0], sds: [1, 1, 1], counts: [], diagnostics: [] };
}
// Independent direct covariance inversion and rowwise objective, without the
// production Woodbury or sufficient-statistic path.
function reference(data: EfaPreparedData, theta: number[]) {
  const load = theta.slice(0, 3), psi = theta.slice(3, 6).map(Math.exp), mu = theta.slice(6);
  let sum = 0, n = 0;
  for (let row = 0; row < data.nRows; row++) {
    const indices = [0, 1, 2].filter(j => data.observed[j * data.nRows + row]);
    if (!indices.length) continue;
    const covariance = new Matrix(indices.map(i => indices.map(j => load[i] * load[j] + (i === j ? psi[i] : 0))));
    const inv = inverse(covariance), residual = indices.map(j => data.numeric![j * data.nRows + row] - mu[j]);
    let quadratic = 0;
    for (let i = 0; i < indices.length; i++) for (let j = 0; j < indices.length; j++) quadratic += residual[i] * inv.get(i, j) * residual[j];
    sum += (Math.log(determinant(covariance)) + quadratic + indices.length * Math.log(2 * Math.PI)) / 2; n++;
  }
  return sum / n;
}
it.each([3, 12])('matches independent row likelihood and finite-difference gradients with %i rows per pattern', perPattern => {
  const data = sample(perPattern), problem = createLikelihoodProblem(data, spec);
  const theta = [.6, -.3, .8, Math.log(.7), Math.log(1.2), Math.log(.4), .2, -.1, .4];
  const fitted = problem.objective(theta);
  expect(problem.allMissingRows).toBe(1); expect(problem.nRows).toBe(perPattern * 2);
  expect(fitted.value).toBeCloseTo(reference(data, theta), 11);
  theta.forEach((_, j) => {
    const delta = 1e-6, high = theta.slice(), low = theta.slice(); high[j] += delta; low[j] -= delta;
    const numerical = (reference(data, high) - reference(data, low)) / (2 * delta);
    expect(Math.abs(fitted.gradient[j] - numerical)).toBeLessThan(2e-7);
  });
});
it('conditional completion preserves observed zero and reverse-keyed originals, excludes nonfitting rows and leaves wholly missing rows unfilled', () => {
  const table = { columns: ['a', 'b'], nRows: 4, data: { a: [0, null, null, 99], b: [null, 4, null, 99] } };
  const fitSpec = { ...spec, items: [{ column: 'a', categories: [], reverse: false }, { column: 'b', categories: [], reverse: true }] };
  const result = { fittingRows: [0, 1, 2], originalRowCount: 4, numericReverseOffsets: [null, 10],
    sds: [1, 2], rotation: { phi: [[1]], pattern: [[.5], [.5]] },
    likelihood: { means: [2, 7], covariance: [[1, .5], [.5, 4]], residualVariances: [.75, 3] } } as unknown as EfaResult;
  const before = structuredClone(table), completed = conditionalCompletion(table, fitSpec, result);
  expect(completed.rows).toEqual([0, 1, 2]); expect(completed.values).toEqual([[0, 1.875, null], [4, 4, null]]);
  expect(completed.filled).toEqual([[false, true, false], [true, false, false]]);
  expect(completed.completedCells).toBe(2); expect(completed.uninformativeRows).toEqual([2]); expect(table).toEqual(before);
});
it('latent-space cached projections agree with direct Gaussian conditioning for every three-item observation mask', () => {
  const raw = [[.5, .2], [.1, .8], [.4, -.3]], phi = [[1, .25], [.25, 1]], residualVariances = [.7, .5, .9], means = [1, -2, .3];
  const covariance = raw.map((row, i) => raw.map((other, j) => row.reduce((sum, a, x) => sum + other.reduce((s, b, y) => s + a * phi[x][y] * b, 0), 0) + (i === j ? residualVariances[i] : 0)));
  const sds = covariance.map((row, j) => Math.sqrt(row[j]));
  const result = { sds, rotation: { phi, pattern: raw.map((row, j) => row.map(value => value / sds[j])) },
    likelihood: { means, covariance, residualVariances } } as unknown as EfaResult;
  const project = createConditionalProjector(result);
  for (let mask = 0; mask < 8; mask++) for (let offset = 0; offset < 2; offset++) {
    const values = [0, 2, -1].map((value, j) => mask & (1 << j) ? value + offset : null);
    const expected = conditionalGaussianMean(values, means, covariance), actual = project(values);
    if (!expected) expect(actual).toBeNull();
    else expected.forEach((value, j) => {
      expect(actual!.means[j]).toBeCloseTo(value, 12);
      if (values[j] !== null) expect(Object.is(actual!.means[j], values[j])).toBe(true);
    });
  }
});
