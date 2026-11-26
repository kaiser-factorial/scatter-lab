import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { prepareEfa } from '../../../src/lib/efa/prepare';
import { correlate } from '../../../src/lib/efa/correlation';
import { fitEfa } from '../../../src/lib/efa/fit';
import { conditionalCompletion } from '../../../src/lib/efa/maximum-likelihood';
import { matchFactors } from '../../../src/lib/efa/compare';
import { runPCA, imputeIterativePCA } from '../../../src/lib/pca';
import type { DataTable } from '../../../src/lib/table';
import type { EfaSpec, EfaResult, EfaExtraction, Rotation } from '../../../src/lib/efa/types';

type Input = DataTable & { nFactors: number; ordinal: boolean; origin: string };
type ReferenceRotation = { pattern: number[][]; phi: number[][]; structure: number[][]; common: number[][]; converged?: boolean };
type Cell = { row: number; column: number; value: number };
type Reference = {
  status: 'ok' | 'error'; error?: string; warnings: string[]; seconds: number;
  rotations: Record<Rotation, ReferenceRotation>; correlation: number[][]; common: number[][]; objective: number;
  covariance: number[][]; means: number[]; residualVariances: number[]; logLikelihood: number; nRows: number; aic: number; bic: number; parameterCount: number; conditional: Cell[];
  eigenvalues: number[]; vectors: number[][]; scores: number[][]; scoreRows: number[]; imputed: Cell[] | null; converged?: boolean;
};
type Check = { metric: string; error: number; limit: number; passed: boolean };
type RecordResult = { dataset: string; method: string; missing: string; rotation?: Rotation; standardize?: boolean; status: 'passed' | 'mismatch' | 'native-error' | 'reference-error'; checks: Check[]; nativeMs: number; referenceSeconds: number; error?: string; convergence?: unknown; referenceWarnings?: string[] };
const folder = `${process.env.CONGRUENCE_FIXTURE_ROOT ?? 'src/lib/__tests__/fixtures'}/efa-congruence`;
const output = process.env.CONGRUENCE_OUTPUT ?? 'scripts/efa-reference/congruence/numerical-report.json';
const only = process.env.CONGRUENCE_CASES ? process.env.CONGRUENCE_CASES.split(',') : undefined;
const skipMl = process.env.CONGRUENCE_SKIP_ML === '1';
const results: RecordResult[] = [];
const max = (values: number[]) => values.length ? Math.max(...values) : 0;
const vectorError = (a: number[], b: number[]) => a.length === b.length ? max(a.map((v, i) => Math.abs(v - b[i]))) : Infinity;
const matrixError = (a: number[][], b: number[][]) => a.length === b.length ? max(a.map((row, i) => vectorError(row, b[i]))) : Infinity;
function check(metric: string, error: number, limit: number): Check { return { metric, error, limit, passed: Number.isFinite(error) && error <= limit }; }
function rotationChecks(result: EfaResult, reference: ReferenceRotation) {
  const { mapping, signs, congruence } = matchFactors(reference.pattern, result.rotation.pattern);
  const pattern = result.rotation.pattern.map(row => mapping.map((j, i) => row[j!] * signs[i]));
  const phi = mapping.map((i, a) => mapping.map((j, b) => result.rotation.phi[i!][j!] * signs[a] * signs[b]));
  return [check('common covariance max abs', matrixError(result.reproduced, reference.common), 1e-4),
    check('signed-permuted pattern max abs', matrixError(pattern, reference.pattern), 1e-3),
    check('signed-permuted Phi max abs', matrixError(phi, reference.phi), 1e-3),
    check('1 - minimum Tucker congruence', 1 - Math.min(...congruence.map(v => v ?? 0)), 1e-5),
    check('R rotation convergence', reference.converged === false ? 1 : 0, 0)];
}
function save() {
  const summary = { passed: results.filter(v => v.status === 'passed').length, mismatch: results.filter(v => v.status === 'mismatch').length, nativeError: results.filter(v => v.status === 'native-error').length, referenceError: results.filter(v => v.status === 'reference-error').length };
  const metricBounds = Object.fromEntries([...new Set(results.flatMap(r => r.checks.map(c => c.metric)))].map(metric => {
    const checks = results.flatMap(r => r.checks.filter(c => c.metric === metric).map(c => ({ dataset: r.dataset, method: r.method, missing: r.missing, rotation: r.rotation, ...c })));
    return [metric, { maximumObservedError: max(checks.map(c => c.error)), cases: checks.length, failures: checks.filter(c => !c.passed) }];
  }));
  writeFileSync(output, JSON.stringify({ recordedAt: new Date().toISOString(), scope: 'Finite independently generated R fixture agreement; no proof of general numerical or optimizer equivalence. Factor alignment is signed permutation only. Largest synthetic excluded.', runtime: process.version, summary, metricBounds, results }, null, 2) + '\n');
}
function record(base: Omit<RecordResult, 'status' | 'checks' | 'nativeMs' | 'referenceSeconds'>, reference: Reference, fn: () => { checks: Check[]; convergence?: unknown }) {
  const start = performance.now();
  try {
    if (reference.status !== 'ok') results.push({ ...base, status: 'reference-error', checks: [], nativeMs: 0, referenceSeconds: reference.seconds, error: reference.error });
    else {
      const value = fn();
      results.push({ ...base, ...value, status: value.checks.every(c => c.passed) ? 'passed' : 'mismatch', nativeMs: performance.now() - start, referenceSeconds: reference.seconds, referenceWarnings: reference.warnings });
    }
  } catch (error) { results.push({ ...base, status: 'native-error', checks: [], nativeMs: performance.now() - start, referenceSeconds: reference.seconds, error: error instanceof Error ? error.message : String(error) }); }
  const latest = results.at(-1)!;
  console.log(`${latest.status}: ${base.dataset} ${base.method} ${base.missing} ${base.rotation ?? base.standardize ?? ''}${latest.error ? `: ${latest.error}` : ''}`);
  save();
}
const names = readdirSync(folder).filter(n => n.endsWith('.input.json')).map(n => n.replace('.input.json', '')).filter(n => !only || only.includes(n));
for (const name of names) {
  const bytes = readFileSync(`${folder}/${name}.input.json`), input = JSON.parse(bytes.toString()) as Input;
  const refs = JSON.parse(readFileSync(`${folder}/${name}.reference.json`, 'utf8')) as { provenance: { inputSha256: string }; ml: Record<string, Reference>; minres: Record<string, Reference>; pca: Record<string, Reference> };
  if (createHash('sha256').update(bytes).digest('hex') !== refs.provenance.inputSha256) throw new Error(`Input hash mismatch: ${name}`);
  const items = input.columns.map(column => ({ column, reverse: false, measurement: input.ordinal ? 'ordinal' as const : 'continuous' as const, categories: input.ordinal ? [...new Set(input.data[column].filter((v): v is number => typeof v === 'number'))].sort((a, b) => a - b) : [] }));
  for (const method of (skipMl ? ['minres'] : ['minres', 'ml']) as ('minres' | 'ml')[]) {
    const policies = method === 'ml' ? ['complete', 'mean', 'median', 'fiml'] as const : ['complete', 'mean', 'median', 'pairwise'] as const;
    for (const policy of policies) {
      let extraction: EfaExtraction | undefined;
      for (const rotation of ['promax', 'oblimin', 'varimax'] as const) {
        const reference = refs[method][policy];
        record({ dataset: name, method, missing: policy, rotation }, reference, () => {
          const spec: EfaSpec = { items, correlation: 'pearson', extraction: method, missing: policy, nFactors: input.nFactors, rotation, seed: 73021, label: name, sample: { partition: 'all' } };
          const prepared = prepareEfa(input, spec, Array.from({ length: input.nRows }, (_, i) => i));
          const correlations = correlate(prepared);
          const fit = fitEfa(prepared, correlations, spec, undefined, extraction);
          extraction = fit.extraction;
          const checks = rotationChecks(fit, reference.rotations[rotation]);
          checks.push(check('native extractor convergence', fit.extraction.convergence.converged ? 0 : 1, 0));
          checks.push(check('native rotation convergence', fit.rotation.convergence.converged ? 0 : 1, 0));
          if (method === 'minres') {
            checks.push(check('correlation max abs', matrixError(correlations.matrix, reference.correlation), 1e-10));
            checks.push(check('MINRES objective abs', Math.abs(fit.extraction.convergence.objective - reference.objective), 1e-6));
          } else {
            const model = fit.likelihood!;
            checks.push(check('raw fitted covariance max abs', matrixError(model.covariance, reference.covariance), 2e-4));
            checks.push(check('fitted means max abs', vectorError(model.means, reference.means), 1e-4));
            checks.push(check('residual variances max abs', vectorError(model.residualVariances, reference.residualVariances), 2e-4));
            checks.push(check('log likelihood per row abs', Math.abs(model.logLikelihood - reference.logLikelihood) / reference.nRows, 1e-7));
            checks.push(check('AIC abs', Math.abs(model.aic - reference.aic), 1e-3));
            checks.push(check('BIC abs', Math.abs(model.bic - reference.bic), 1e-3));
            checks.push(check('parameter count', Math.abs(model.parameters - reference.parameterCount), 0));
            checks.push(check('R extractor convergence', reference.converged ? 0 : 1, 0));
            if (policy === 'fiml') {
              const completion = conditionalCompletion(input, spec, fit), rowIndices = new Map(completion.rows.map((row, i) => [row, i]));
              const error = max(reference.conditional.map(cell => Math.abs(completion.values[cell.column][rowIndices.get(cell.row)!]! - cell.value)));
              checks.push(check('conditional completion max abs', error, 5e-4));
            }
          }
          return { checks, convergence: { extraction: fit.extraction.convergence, rotation: fit.rotation.convergence, ...(fit.likelihood ? { starts: fit.likelihood.starts } : {}) } };
        });
      }
    }
  }
  if (process.env.CONGRUENCE_SKIP_PCA !== '1') for (const policy of ['complete', 'mean', 'median', 'pairwise', 'iterative'] as const) for (const standardize of [true, false]) {
    const reference = refs.pca[`${policy}-${standardize ? 'scaled' : 'raw'}`];
    record({ dataset: name, method: 'pca', missing: policy, standardize }, reference, () => {
      const result = runPCA(input, input.columns, { k: input.nFactors, standardize, missing: policy, measurements: Object.fromEntries(input.columns.map(c => [c, input.ordinal ? 'ordinal' : 'continuous'])) });
      const vectors = input.columns.map(column => result.columns.map(pc => result.loadings[pc].find(v => v.var === column)!.loading));
      const { mapping, signs } = matchFactors(reference.vectors, vectors);
      const aligned = vectors.map(row => mapping.map((j, i) => row[j!] * signs[i]));
      const scores = reference.scoreRows.map(row => mapping.map((j, i) => (result.table.data[result.columns[j!]][row] as number) * signs[i]));
      const checks = [check('PCA eigenvalues max abs', vectorError(result.eigenvalues, reference.eigenvalues), 1e-7),
        check('PCA displayed vector max abs (rounded .001)', matrixError(aligned, reference.vectors), .000501),
        check('PCA sampled scores max abs', matrixError(scores, reference.scores), 1e-6)];
      if (policy === 'iterative') {
        const filled = imputeIterativePCA(input.columns.map(c => input.data[c] as (number | null)[]), { rank: input.nFactors, standardize, maxIter: 200, tol: 1e-8 });
        checks.push(check('iterative PCA completion max abs', max((reference.imputed ?? []).map(cell => Math.abs(filled.columns[cell.column][cell.row] - cell.value))), 1e-5));
      }
      return { checks };
    });
  }
}
save();
if (results.some(r => r.status !== 'passed')) process.exitCode = 1;
