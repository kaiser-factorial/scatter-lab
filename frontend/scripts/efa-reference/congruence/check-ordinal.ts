import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { prepareEfa } from '../../../src/lib/efa/prepare';
import { correlate } from '../../../src/lib/efa/correlation';
import { weightedMoments, influenceAt } from '../../../src/lib/efa/weighted-moments';
import { extractMinres } from '../../../src/lib/efa/extraction';
import { extractDwls } from '../../../src/lib/efa/dwls';
import { weightedInference } from '../../../src/lib/efa/weighted-inference';
import { rotate } from '../../../src/lib/efa/rotation';
import { matchFactors } from '../../../src/lib/efa/compare';
import { Matrix } from '../../../src/lib/efa/math';
import type { DataTable } from '../../../src/lib/table';
import type { EfaSpec, Rotation } from '../../../src/lib/efa/types';
type Input = DataTable & { nFactors: number };
type RotationRef = { pattern: number[][]; phi: number[][]; common: number[][]; converged: boolean };
type Ref = { status: string; error?: string; nRows: number; originalCounts: number[][]; correlation: number[][]; gamma: number[][]; minres: { common: number[][]; objective: number; rotations: Record<Rotation, RotationRef> }; weighted: { converged: boolean; common: number[][]; rotations: Record<Rotation, RotationRef>; test: { standard: { stat: number }; 'scaled.shifted': { stat: number; df: number; pvalue: number; 'trace.UGamma': number; 'trace.UGamma2': number; 'scaling.factor': number; 'shift.parameter': number } } } };
type Check = { metric: string; error: number; limit: number; passed: boolean };
const max = (values: number[]) => values.length ? Math.max(...values) : 0;
const diff = (a: number[][], b: number[][]) => max(a.flatMap((row, i) => row.map((value, j) => Math.abs(value - b[i][j]))));
const check = (metric: string, error: number, limit: number): Check => ({ metric, error, limit, passed: Number.isFinite(error) && error <= limit });
const output = process.env.CONGRUENCE_OUTPUT ?? 'scripts/efa-reference/congruence/ordinal-report.json';
const results: { dataset: string; missing: string; status: string; checks: Check[]; error?: string; nativeMs: number }[] = [];
function save() { writeFileSync(output, JSON.stringify({ recordedAt: new Date().toISOString(), scope: 'Raw ordinal inputs through native pair-margin polychorics and influence moments; independent R polycor/lavaan moments and supplied-moment DWLS/WLSMV. Signs/permutations only. No claim of equivalence to different raw-data lavaan threshold defaults.', summary: { passed: results.filter(r => r.status === 'passed').length, failed: results.filter(r => r.status !== 'passed').length }, results }, null, 2) + '\n'); }
for (const name of ['ordinal-mcar', 'bfi25-original']) {
  const path = `${process.env.CONGRUENCE_FIXTURE_ROOT ?? 'src/lib/__tests__/fixtures'}/efa-congruence/${name}`, bytes = readFileSync(`${path}.input.json`), input = JSON.parse(bytes.toString()) as Input;
  const reference = JSON.parse(readFileSync(`${path}.ordinal-reference.json`, 'utf8')) as { provenance: { inputSha256: string }; policies: Record<string, Ref> };
  if (createHash('sha256').update(bytes).digest('hex') !== reference.provenance.inputSha256) throw new Error(`Input hash mismatch ${name}`);
  for (const policy of ['pairwise', 'complete', 'mean', 'median'] as const) {
    const start = performance.now(), checks: Check[] = [];
    try {
      const ref = reference.policies[policy];
      if (ref.status !== 'ok') throw new Error(`R reference failed: ${ref.error}`);
      const spec: EfaSpec = { items: input.columns.map(column => ({ column, reverse: false, measurement: 'ordinal', categories: [...new Set(input.data[column].filter((v): v is number => typeof v === 'number'))].sort((a, b) => a - b) })), nFactors: input.nFactors, correlation: 'polychoric', extraction: 'wlsmv', missing: policy, rotation: 'promax', seed: 73021, label: name, sample: { partition: 'all' } };
      const data = prepareEfa(input, spec, Array.from({ length: input.nRows }, (_, i) => i)), cor = correlate(data), moments = weightedMoments(data, cor);
      checks.push(check('polychoric max abs', diff(cor.matrix, ref.correlation), 1e-5));
      checks.push(check('original observed pair counts', max(cor.pairs.map(pair => Math.abs(pair.n - ref.originalCounts[pair.i][pair.j]))), 0));
      const S = new Matrix(Array.from({ length: data.nRows }, (_, row) => moments.pairs.map(pair => influenceAt(data, pair, row))));
      const gamma = S.transpose().mmul(S).mul(1 / data.nRows).to2DArray();
      checks.push(check('influence Gamma max abs', diff(gamma, ref.gamma), 1e-4));
      for (const estimator of ['minres', 'dwls'] as const) {
        const extraction = estimator === 'minres' ? extractMinres(cor.matrix, input.nFactors) : extractDwls(cor.matrix, moments, input.nFactors);
        const expected = estimator === 'minres' ? ref.minres : ref.weighted;
        checks.push(check(`${estimator} native convergence`, extraction.convergence.converged ? 0 : 1, 0));
        if (estimator === 'minres') checks.push(check('MINRES objective abs', Math.abs(extraction.convergence.objective - ref.minres.objective), 1e-6));
        for (const method of ['promax', 'oblimin', 'varimax'] as const) {
          const actual = rotate(extraction.loadings, method, 73021, 4, estimator === 'dwls'), R = expected.rotations[method];
          const match = matchFactors(R.pattern, actual.pattern);
          const pattern = actual.pattern.map(row => match.mapping.map((j, i) => row[j!] * match.signs[i]));
          const phi = match.mapping.map((i, a) => match.mapping.map((j, b) => actual.phi[i!][j!] * match.signs[a] * match.signs[b]));
          const common = new Matrix(actual.pattern).mmul(new Matrix(actual.phi)).mmul(new Matrix(actual.pattern).transpose()).to2DArray();
          checks.push(check(`${estimator}/${method} common max abs`, diff(common, R.common), 1e-4));
          checks.push(check(`${estimator}/${method} pattern max abs`, diff(pattern, R.pattern), 1e-3));
          checks.push(check(`${estimator}/${method} Phi max abs`, diff(phi, R.phi), 1e-3));
          checks.push(check(`${estimator}/${method} R rotation convergence`, R.converged ? 0 : 1, 0));
          checks.push(check(`${estimator}/${method} native rotation convergence`, actual.convergence.converged ? 0 : 1, 0));
        }
        if (estimator === 'dwls') {
          const native = weightedInference(data, moments, extraction.loadings, extraction.convergence.objective).test, expectedTest = ref.weighted.test['scaled.shifted'];
          checks.push(check('R weighted convergence', ref.weighted.converged ? 0 : 1, 0));
          checks.push(check('raw weighted chi-square abs', Math.abs(native.rawStatistic - ref.weighted.test.standard.stat), 1e-4));
          checks.push(check('WLSMV df', Math.abs(native.df - expectedTest.df), 0));
          checks.push(check('WLSMV trace abs', Math.abs(native.trace! - expectedTest['trace.UGamma']), 1e-4));
          checks.push(check('WLSMV trace squared abs', Math.abs(native.traceSquared! - expectedTest['trace.UGamma2']), 1e-4));
          checks.push(check('WLSMV chi-square abs', Math.abs(native.statistic! - expectedTest.stat), 1e-4));
          checks.push(check('WLSMV p-value abs', Math.abs(native.pValue! - expectedTest.pvalue), 1e-5));
        }
      }
      results.push({ dataset: name, missing: policy, status: checks.every(c => c.passed) ? 'passed' : 'mismatch', checks, nativeMs: performance.now() - start });
    } catch (error) { results.push({ dataset: name, missing: policy, status: 'error', checks, error: error instanceof Error ? error.message : String(error), nativeMs: performance.now() - start }); }
    console.log(`${results.at(-1)!.status}: ${name} ${policy}${results.at(-1)!.error ? `: ${results.at(-1)!.error}` : ''}`); save();
  }
}
if (results.some(r => r.status !== 'passed')) process.exitCode = 1;
