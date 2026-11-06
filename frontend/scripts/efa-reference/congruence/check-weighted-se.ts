import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { prepareEfa } from '../../../src/lib/efa/prepare';
import { correlate } from '../../../src/lib/efa/correlation';
import { weightedMoments, influenceAt } from '../../../src/lib/efa/weighted-moments';
import { extractDwls } from '../../../src/lib/efa/dwls';
import { weightedInference } from '../../../src/lib/efa/weighted-inference';
import { rotatedUncertainty } from '../../../src/lib/efa/weighted-rotation';
import { rotate } from '../../../src/lib/efa/rotation';
import { matchFactors } from '../../../src/lib/efa/compare';
import { Matrix } from '../../../src/lib/efa/math';
import type { DataTable } from '../../../src/lib/table';
import type { EfaSpec, Rotation } from '../../../src/lib/efa/types';
type ReferenceFit = { est: { lambda: number[][]; psi: number[][] }; se: { lambda: number[][]; psi: number[][] }; test: Record<string, Record<string, number>> };
type Reference = { provenance: { inputSha256: string }; gamma: number[][]; correlation: number[][]; scoreRows: number[][]; raw: null | { correlation: number[][]; gamma: number[][] }; fits: Record<Rotation, ReferenceFit>; delta: Record<Rotation, { pattern: number[][]; phi: number[][]; se: { pattern: number[][]; structure: number[][]; phi: number[][]; communalities: number[] } }> };
type Check = { metric: string; error: number; limit: number; passed: boolean };
const output = process.env.CONGRUENCE_OUTPUT ?? 'scripts/efa-reference/congruence/weighted-se-report.json';
const results: { dataset: string; method: string; status: string; checks: Check[]; nativeMs: number; error?: string }[] = [];
const hashes: Record<string, string> = {};
function read<T>(file: string): T { const bytes = readFileSync(file); hashes[file] = createHash('sha256').update(bytes).digest('hex'); return JSON.parse(bytes.toString()) as T; }
const diff = (a: number[][], b: number[][]) => Math.max(0, ...a.flatMap((row, i) => row.map((v, j) => Math.abs(v - b[i][j]))));
const check = (metric: string, error: number, limit: number): Check => ({ metric, error, limit, passed: Number.isFinite(error) && error <= limit });
for (const name of ['normal', 'heavy-tail', 'skew', 'pairwise', 'complete']) {
  const start = performance.now(), checks: Check[] = [];
  try {
    const path = `${process.env.CONGRUENCE_FIXTURE_ROOT ?? 'src/lib/__tests__/fixtures'}/efa-weighted/${name}`, input = read<DataTable & { categories: number[][]; reverse: number[]; missing: 'complete' | 'pairwise'; nFactors: number }>(`${path}.input.json`), ref = read<Reference>(`${path}.reference.json`);
    if (hashes[`${path}.input.json`] !== ref.provenance.inputSha256) throw new Error('Input hash mismatch');
    const spec: EfaSpec = { items: input.columns.map((column, i) => ({ column, categories: input.categories[i], reverse: input.reverse.includes(i) })), nFactors: input.nFactors, missing: input.missing, rotation: 'oblimin', seed: 73021, label: name, sample: { partition: 'all' } }, data = prepareEfa(input, spec, Array.from({ length: input.nRows }, (_, i) => i)), correlation = correlate(data), moments = weightedMoments(data, correlation), S = new Matrix(Array.from({ length: data.nRows }, (_, row) => moments.pairs.map(pair => influenceAt(data, pair, row)))), gamma = S.transpose().mmul(S).mul(1 / data.nRows).to2DArray();
    checks.push(check('weighted polychoric max abs', diff(correlation.matrix, ref.correlation), 1e-5), check('weighted Gamma max abs', diff(gamma, ref.gamma), 1e-4), check('weighted case influences max abs', diff(S.to2DArray().slice(0, ref.scoreRows.length), ref.scoreRows), 1e-4));
    if (ref.raw) checks.push(check('raw-data lavaan polychoric max abs', diff(correlation.matrix, ref.raw.correlation), 1e-4), check('raw-data lavaan Gamma max abs', diff(gamma, ref.raw.gamma), 1e-4));
    const fit = extractDwls(correlation.matrix, moments, input.nFactors), inference = weightedInference(data, moments, fit.loadings, fit.convergence.objective), test = inference.test, r = ref.fits.oblimin.test['scaled.shifted'];
    for (const [metric, error, limit] of [['WLSMV raw chi-square abs', Math.abs(test.rawStatistic - ref.fits.oblimin.test.standard.stat), 1e-4], ['WLSMV df difference', Math.abs(test.df - r.df), 0], ['WLSMV trace abs', Math.abs(test.trace! - r['trace.UGamma']), 1e-4], ['WLSMV trace squared abs', Math.abs(test.traceSquared! - r['trace.UGamma2']), 1e-4], ['WLSMV scaling abs', Math.abs(test.scalingFactor! - r['scaling.factor']), 1e-4], ['WLSMV shift abs', Math.abs(test.shift! - r['shift.parameter']), 1e-4], ['WLSMV chi-square abs', Math.abs(test.statistic! - r.stat), 1e-4], ['WLSMV p-value abs', Math.abs(test.pValue! - r.pvalue), 1e-5]] as [string, number, number][]) checks.push(check(metric, error, limit));
    for (const method of ['oblimin', 'varimax', 'promax'] as const) {
      const rotation = rotate(fit.loadings, method, 73021, 4, true), se = rotatedUncertainty(inference.identified, inference.covariance, rotation, method, 73021), delta = ref.delta[method], match = matchFactors(delta.pattern, rotation.pattern), alignedSE = (values: number[][]) => values.map(row => match.mapping.map(j => row[j!])), alignedPhiSE = match.mapping.map(i => match.mapping.map(j => se.phi[i!][j!]));
      checks.push(check(`${method} numerical-delta pattern max abs`, diff(rotation.pattern.map(row => match.mapping.map((j, i) => row[j!] * match.signs[i])), delta.pattern), 1e-3), check(`${method} numerical-delta loading SE max abs`, diff(alignedSE(se.pattern), delta.se.pattern), 1e-4), check(`${method} numerical-delta structure SE max abs`, diff(alignedSE(se.structure), delta.se.structure), 1e-4), check(`${method} numerical-delta Phi SE max abs`, diff(alignedPhiSE, delta.se.phi), 1e-4), check(`${method} numerical-delta uniqueness SE max abs`, Math.max(...se.uniquenesses.map((v, i) => Math.abs(v - delta.se.communalities[i]))), 1e-4));
      if (method !== 'promax') { const canonical = ref.fits[method], m = matchFactors(canonical.est.lambda, rotation.pattern); checks.push(check(`${method} lavaan loading SE max abs`, diff(se.pattern.map(row => m.mapping.map(j => row[j!])), canonical.se.lambda), 1e-4), check(`${method} lavaan Phi SE max abs`, diff(m.mapping.map(i => m.mapping.map(j => se.phi[i!][j!])), canonical.se.psi), 1e-4)); }
    }
    results.push({ dataset: name, method: 'weighted inference and rotated SE', status: checks.every(c => c.passed) ? 'passed' : 'mismatch', checks, nativeMs: performance.now() - start });
  } catch (error) { results.push({ dataset: name, method: 'weighted inference and rotated SE', status: 'native-error', checks, nativeMs: performance.now() - start, error: String(error) }); }
  console.log(`${results.at(-1)!.status}: ${name}`);
  writeFileSync(output, JSON.stringify({ recordedAt: new Date().toISOString(), scope: 'Pinned independent R lavaan and numDeriv rotated uncertainty references; exact source fixture bytes recorded.', fixtureHashes: hashes, summary: { passed: results.filter(r => r.status === 'passed').length, failed: results.filter(r => r.status !== 'passed').length }, results }, null, 2) + '\n');
}
if (results.some(r => r.status !== 'passed')) process.exitCode = 1;
