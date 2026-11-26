import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { prepareEfa } from '../../../src/lib/efa/prepare';
import { correlate } from '../../../src/lib/efa/correlation';
import { fitEfa } from '../../../src/lib/efa/fit';
import { augmentConditional, fitOrdinal, ordinalProbabilities, drawOrdinal, binaryConditionalDraw } from '../../../src/lib/efa/ordinal-regression';
import { ordinalContrasts, imputeMice, type MiceOptions, type MiceDrawRequest } from '../../../src/lib/efa/mice';
import { fitImputationChain, summarizeImputations } from '../../../src/lib/efa/imputation-analysis';
import { bootstrapStability, distribution, type AlignedReplica } from '../../../src/lib/efa/stability';
import { parallelObserved, summarizeParallel } from '../../../src/lib/efa/parallel';
import type { DataTable } from '../../../src/lib/table';
import type { EfaSpec } from '../../../src/lib/efa/types';

type Check = { metric: string; error: number; limit: number; passed: boolean };
type Result = { dataset: string; method: string; status: string; checks: Check[]; nativeMs: number; error?: string };
type Table = DataTable & { categories: number[][] };
const output = process.env.CONGRUENCE_OUTPUT ?? 'scripts/efa-reference/congruence/extensions-report.json';
const folder = `${process.env.CONGRUENCE_FIXTURE_ROOT ?? 'src/lib/__tests__/fixtures'}/efa-extensions`;
const hashes: Record<string, string> = {};
function read<T>(name: string): T { const file = `${folder}/${name}`, bytes = readFileSync(file); hashes[file] = createHash('sha256').update(bytes).digest('hex'); return JSON.parse(bytes.toString()) as T; }
const results: Result[] = [];
const referenceBoundaries: { dataset: string; metric: string; maximumDifference: number; casesAbove1e4: number; cases: number }[] = [];
const flat = (v: unknown): number[] => Array.isArray(v) ? v.flat(Infinity) : [v as number];
function diff(a: unknown, b: unknown) { const x = flat(a), y = flat(b); return x.length === y.length ? Math.max(0, ...x.map((v, i) => Math.abs(v - y[i]))) : Infinity; }
const check = (metric: string, error: number, limit: number): Check => ({ metric, error, limit, passed: Number.isFinite(error) && error <= limit });
function save() { writeFileSync(output, JSON.stringify({ recordedAt: new Date().toISOString(), scope: 'Pinned saved R reference fixtures; identical recorded random draws, null datasets, and bootstrap row indices. No shared-seed or general distributional equivalence claim.', fixtureHashes: hashes, summary: { passed: results.filter(r => r.status === 'passed').length, mismatch: results.filter(r => r.status === 'mismatch').length, nativeError: results.filter(r => r.status === 'native-error').length }, referenceBoundaries, results }, null, 2) + '\n'); }
function record(dataset: string, method: string, f: () => Check[]) { const start = performance.now(); try { const checks = f(); results.push({ dataset, method, checks, status: checks.every(c => c.passed) ? 'passed' : 'mismatch', nativeMs: performance.now() - start }); } catch (error) { results.push({ dataset, method, checks: [], status: 'native-error', nativeMs: performance.now() - start, error: String(error) }); } console.log(`${results.at(-1)!.status}: ${dataset} ${method}`); save(); }
const specFor = (table: Table, nFactors: number): EfaSpec => ({ items: table.columns.map((column, i) => ({ column, categories: table.categories[i], reverse: false })), nFactors, missing: 'pairwise', rotation: 'oblimin', seed: 50911, label: 'reference qualification', sample: { partition: 'all' } });
const rowsFor = (table: Table) => Array.from({ length: table.nRows }, (_, i) => i);

const contrasts = read<{ cases: Record<string, number[][]> }>('ordinal-contrasts.reference.json');
for (const [levels, expected] of Object.entries(contrasts.cases)) record(`${levels} levels`, 'R contr.poly', () => [check('polynomial contrast max abs', diff(ordinalContrasts(Number(levels)), expected), 1e-10)]);
type ConditionalReference = { coefficients: number[]; thresholds: number[]; objective: number; probabilities: number[][] | number[]; draws: number[] | number; beta: number[]; covariance: number[][]; sampled: number[] };
type ConditionalCase = { name: string; x: number[][]; y: (number | null)[]; levels: number; uniforms: number[] | number; normals: number[]; augmented: number; expected: ConditionalReference; stableReference?: ConditionalReference };
for (const [name, c] of Object.entries(read<{ cases: Record<string, ConditionalCase> }>('conditional.reference.json').cases)) record(name, 'MICE conditional', () => {
  const uniforms = flat(c.uniforms), checks = [check('augmentation row count', Math.abs(augmentConditional(c.x, c.y, c.levels).augmented - c.augmented), 0)];
  if (c.levels === 2) { const r = binaryConditionalDraw(c.x, c.y, c.normals, uniforms); for (const metric of ['beta', 'covariance', 'sampled', 'probabilities'] as const) checks.push(check(`binary ${metric} max abs`, diff(r[metric], c.expected[metric]), 1e-5)); checks.push(check('conditional recorded-draw difference', diff(r.draws, c.expected.draws), 0)); }
  else { const r = fitOrdinal(c.x, c.y, c.levels), p = ordinalProbabilities(r, c.x.filter((_, i) => c.y[i] === null)), ref = c.stableReference ?? c.expected; checks.push(check('ordinal coefficients max abs', diff(r.coefficients, ref.coefficients), 1e-4), check('ordinal thresholds max abs', diff(r.thresholds, ref.thresholds), 1e-4), check('ordinal objective abs', Math.abs(r.objective - ref.objective), 1e-6), check('ordinal probabilities max abs', diff(p, ref.probabilities), 1e-5), check('conditional recorded-draw difference', diff(drawOrdinal(p, uniforms), c.expected.draws), 0)); }
  return checks;
});
type MiceFixture = { table: Table; options: MiceOptions; draws: (MiceDrawRequest & { values: number[] })[]; completed: number[][][]; trace: { mean: number; sd: number }[]; fits: { correlation: number[][]; pattern: number[][]; communalities: number[]; uniquenesses: number[]; rmsr: number }[] };
for (const family of ['heavy-tail', 'skew']) for (const encoding of ['rank', 'polynomial']) {
  const f = read<MiceFixture>(`mice-chain${encoding === 'polynomial' ? '-polynomial' : ''}${family === 'skew' ? '-skew' : ''}.reference.json`);
  record(`${family}/${encoding}`, 'MICE chains and pooled fits', () => {
    const spec = specFor(f.table, 1), data = prepareEfa(f.table, spec, rowsFor(f.table)), source = data.codes.slice(), draws = (r: MiceDrawRequest) => { const draw = f.draws.find(d => d.imputation === r.imputation && d.iteration === r.iteration && d.item === r.item && d.kind === r.kind); if (!draw) throw new Error('Missing saved draw'); return draw.values; };
    const result = imputeMice(data, f.options, undefined, draws), checks = [check('MICE failures', result.failures.length, 0), check('MICE completed chain count', Math.abs(result.completed.length - f.options.imputations), 0)];
    const completedErrors: number[] = [], observedErrors: number[] = [];
    for (const { imputation, data: complete } of result.completed) for (let j = 0; j < spec.items.length; j++) for (let i = 0; i < data.nRows; i++) { completedErrors.push(Math.abs(complete.codes[j * data.nRows + i] - f.completed[imputation][i][j])); if (data.observed[j * data.nRows + i]) observedErrors.push(Math.abs(complete.codes[j * data.nRows + i] - source[j * data.nRows + i])); }
    checks.push(check('MICE completed-cell code difference', Math.max(0, ...completedErrors), 0), check('MICE observed-cell difference', Math.max(0, ...observedErrors), 0), check('MICE trace mean max abs', diff(result.trace.map(t => t.mean), f.trace.map(t => t.mean)), 1e-12), check('MICE trace SD max abs', diff(result.trace.map(t => t.sd), f.trace.map(t => t.sd)), 1e-12));
    const chains = Array.from({ length: f.options.imputations }, (_, i) => fitImputationChain(data, spec, f.options, i, undefined, draws)), analysis = summarizeImputations(data, f.options, chains);
    checks.push(check('MICE fitted failures', analysis.failures.length, 0), check('MICE fitted completed count', Math.abs(analysis.completed - f.options.imputations), 0));
    analysis.fits.forEach((fit, i) => { const ref = f.fits[i], sign = fit.result.rotation.pattern[0][0] * ref.pattern[0][0] < 0 ? -1 : 1; checks.push(check('MICE correlation max abs', diff(fit.result.correlation.matrix, ref.correlation), 1e-5), check('MICE sign-aligned pattern max abs', diff(fit.result.rotation.pattern.map(row => row.map(v => v * sign)), ref.pattern), 1e-3), check('MICE communality max abs', diff(fit.result.communalities, ref.communalities), 1e-4), check('MICE replacement code difference', diff(fit.replacements, analysis.missingPositions.map(p => result.completed[i].data.codes[p])), 0)); });
    return checks;
  });
}
type StabilityFixture = { table: Table; baseline: AlignedReplica; samples: number[][]; replicas: AlignedReplica[] };
for (const [name, f] of Object.entries(read<{ cases: Record<string, StabilityFixture> }>('stability.reference.json').cases)) record(name, 'six saved bootstrap resamples', () => {
  const spec = specFor(f.table, 2), data = prepareEfa(f.table, spec, rowsFor(f.table)), baseline = fitEfa(data, correlate(data), spec), anchor = { ...baseline, rotation: { ...baseline.rotation, pattern: f.baseline.pattern, phi: f.baseline.phi } }, result = bootstrapStability(data, spec, anchor, { replicates: 6, seed: 50911, confidence: 0.95, crossLoadingThreshold: 0.3 }, undefined, f.samples), checks = [check('bootstrap failures', result.failures.length, 0), check('bootstrap completed count', Math.abs(result.completed - 6), 0)];
  result.replicas.forEach((r, i) => { const ref = f.replicas[i]; for (const key of ['pattern', 'structure', 'phi', 'communalities'] as const) checks.push(check(`bootstrap ${key} max abs`, diff(r[key], ref[key]), key === 'communalities' ? 1e-4 : 1e-3)); });
  const expected = distribution(f.replicas.map(r => r.pattern[0][0])); checks.push(check('bootstrap lower percentile abs', Math.abs(result.pattern[0][0].lower! - expected.lower!), 1e-3), check('bootstrap upper percentile abs', Math.abs(result.pattern[0][0].upper! - expected.upper!), 1e-3)); return checks;
});
type ParallelFixture = { input: Table; observed: number[]; null: { data: DataTable['data']; eigenvalues: number[]; psychEigenvalues: number[] }[]; failures: unknown[]; reference: number[] };
for (const name of ['normal', 'heavy-tail', 'skew']) record(name, '100 saved parallel-analysis permutations', () => {
  const f = read<ParallelFixture>(`parallel-${name}.reference.json`), spec = specFor(f.input, 1), rows = rowsFor(f.input), observed = parallelObserved(prepareEfa(f.input, spec, rows)), checks = [check('parallel R failures', f.failures.length, 0), check('parallel observed eigenvalues max abs', diff(observed, f.observed), 1e-4)];
  const nulls = f.null.map(entry => { const values = parallelObserved(prepareEfa({ ...f.input, data: entry.data }, spec, rows)); checks.push(check(`parallel null eigenvalues max abs`, diff(values, entry.eigenvalues), 1e-4)); return values; });
  const psychDifferences = nulls.map((values, i) => diff(values, f.null[i].psychEigenvalues));
  referenceBoundaries.push({ dataset: name, metric: 'native null eigenvalues versus psych default optimizer', maximumDifference: Math.max(...psychDifferences), casesAbove1e4: psychDifferences.filter(x => x > 1e-4).length, cases: psychDifferences.length });
  const result = summarizeParallel(observed, nulls, [], 73411, 100); checks.push(check('parallel 95th percentile max abs', diff(result.reference, f.reference), 1e-4), check('parallel completed count', Math.abs(result.completed - 100), 0)); return checks;
});
if (results.some(r => r.status !== 'passed')) process.exitCode = 1;
