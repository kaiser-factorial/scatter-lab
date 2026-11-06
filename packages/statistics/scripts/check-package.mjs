import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';

const library = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(library, '../..');
const output = resolve(root, 'validation/library-migration/.artifacts');
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(join(output, 'consumer-'));
const consumer = join(directory, 'consumer');
mkdirSync(consumer);
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const run = (name, command, args, cwd = consumer) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 180000 });
  writeFileSync(join(directory, `${name}.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`);
  assert.equal(result.error, undefined, `${name}: ${result.error}`);
  assert.equal(result.status, 0, `${name} failed; see ${join(directory, `${name}.log`)}`);
  return result.stdout;
};
const walk = path => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)]);
const summary = { format: 'scatterlab-package-verification/1', date: new Date().toISOString(), runtime: process.version, status: 'running', checks: [], artifactDirectory: relative(root, directory) };
try {
  const manifest = JSON.parse(readFileSync(join(library, 'dist/build-manifest.json'), 'utf8'));
  const sources = walk(join(library, 'src')).filter(path => path.endsWith('.ts')).map(path => relative(library, path).replaceAll('\\', '/')).sort();
  assert.deepEqual(Object.keys(manifest.sourceHashes).sort(), sources, 'Build must include every current TypeScript source.');
  for (const [path, hash] of Object.entries(manifest.sourceHashes)) assert.equal(sha(join(library, path)), hash, `Stale built source: ${path}`);
  summary.checks.push('Current source hashes match the emitted build manifest.');
  const pack = JSON.parse(run('pack', 'npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], library))[0];
  const allowedDocs = ['package.json', 'README.md', 'PCA.md', 'EFA.md', 'VALIDATION.md', 'NOTICE.md'];
  assert(pack.files.every(file => file.path.startsWith('dist/') || allowedDocs.includes(file.path)), 'Tarball contains files outside the allowlist.');
  for (const document of allowedDocs) assert(pack.files.some(file => file.path === document), `Missing package document: ${document}`);
  assert(!pack.files.some(file => /(?:fixture|node_modules|\.ci-artifacts|\.env|\.R$|\.saw$)/i.test(file.path)));
  summary.tarball = { name: pack.filename, bytes: pack.size, unpackedBytes: pack.unpackedSize, sha256: sha(join(directory, pack.filename)), files: pack.files.length };
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'stats-consumer-check', private: true, type: 'module' }));
  // Offline is intentional: the core package and its installed dependency must
  // already be in the npm cache. Nothing in this test needs R or a web service.
  run('install', 'npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(directory, pack.filename)]);
  const installed = join(consumer, 'node_modules/@scatterlab/stats');
  for (const file of pack.files.filter(file => file.path.startsWith('dist/'))) assert.equal(sha(join(installed, file.path)), sha(join(library, file.path)), `Installed bytes differ: ${file.path}`);
  summary.checks.push('Actual npm tarball installed into an isolated consumer; emitted bytes match.');
  const fixture = JSON.parse(readFileSync(join(root, 'frontend/src/lib/__tests__/fixtures/efa-congruence/normal-mcar.input.json'), 'utf8'));
  writeFileSync(join(consumer, 'input.json'), JSON.stringify(fixture));
  writeFileSync(join(consumer, 'native.mjs'), `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as root from '@scatterlab/stats';
import * as data from '@scatterlab/stats/data';
import * as pca from '@scatterlab/stats/pca';
import * as efa from '@scatterlab/stats/efa';
import * as stats from '@scatterlab/stats/stats';
import * as missing from '@scatterlab/stats/missing';
import * as diagnostics from '@scatterlab/stats/diagnostics';
import * as cluster from '@scatterlab/stats/cluster';
globalThis.fetch = () => { throw new Error('The CPU library must not fetch resources.'); };
assert.equal(root.VERSION, '0.1.0'); assert.equal(root.pca.fitPca, pca.fitPca);
assert.equal(root.efa.fitEfa, efa.fitEfa);
const input = JSON.parse(readFileSync(new URL('./input.json', import.meta.url), 'utf8'));
const before = JSON.stringify(input);
const rows = Array.from({ length: 200 }, (_, i) => i);
const measurements = Object.fromEntries(input.columns.map(column => [column, 'continuous']));
const fit = pca.fitPca(input, { k: 2, rows, missing: 'median', measurements });
const model = pca.deserializePcaModel(pca.serializePcaModel(fit.model));
const scored = pca.transformPca(model, input, { rows: [1, 0] });
assert.deepEqual(scored.rows, [1, 0]); assert.deepEqual(scored.scores, [fit.scores[1], fit.scores[0]]);
const ef = await efa.fitEfa(input, { items: input.columns.map(column => ({ column, measurement: 'continuous' })), factors: 2, extraction: 'ml', missing: 'fiml', correlation: 'pearson', rows });
const efm = efa.deserializeEfaModel(efa.serializeEfaModel(ef.model));
assert.equal(efm.status, 'converged');
assert.deepEqual(efa.scoreEfa(efm, input, { rows: [2, 1] }).scores, [ef.scores.scores[2], ef.scores.scores[1]]);
const completed = await efa.completeEfa(efm, input);
assert(completed.filled.flat().some(Boolean));
for (let j = 0; j < completed.columns.length; j++) for (let i = 0; i < completed.rows.length; i++) if (!completed.filled[j][i]) assert.equal(completed.values[j][i], input.data[completed.columns[j]][completed.rows[i]]);
const imputer = missing.fitColumnImputer(input, { method: 'mean', measurements, rows });
assert(missing.applyColumnImputer(missing.deserializeImputer(missing.serializeImputer(imputer)), input).filledCells > 0);
assert.equal(stats.describeNumeric([1, 2, 3]).mean, 2);
assert.equal(diagnostics.analyzeItems(input, { rows }).sample.rows, rows.length);
assert.equal(data.materializeTable(input).nRows, input.nRows);
assert.equal(cluster.kmeans([[0], [1], [10], [11]], { k: 2 }).withinSumSquares, 1);
assert.equal(cluster.dbscan([[0], [0.1], [10]], { eps: 0.2, minSamples: 2 }).noise, 1);
assert.equal(JSON.stringify(input), before);
await assert.rejects(import('@scatterlab/stats/src/pca.ts'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
console.log('Native ESM: all public entry points, PCA/EFA saved-model scoring, FIML completion, imputation and source preservation passed.');
`);
  run('native-esm', process.execPath, ['native.mjs']);
  summary.checks.push('Native Node ESM imports and fitted PCA/EFA operations pass without app or R runtime.');
  writeFileSync(join(consumer, 'types.mts'), `
import { VERSION, pca, efa, missing, diagnostics, stats, cluster } from '@scatterlab/stats';
import type { InputTable } from '@scatterlab/stats/data';
const table: InputTable = { columns: ['a', 'b'], nRows: 3, data: { a: [1, 2, 3], b: [3, 1, 2] } };
const fit = pca.fitPca(table, { k: 1 });
const restored = pca.deserializePcaModel(pca.serializePcaModel(fit.model));
const scores: (number | null)[][] = pca.transformPca(restored, table).scores;
void scores; void VERSION; void stats.describeNumeric([1, 2]);
void missing.applyColumnImputer(missing.fitColumnImputer(table, { method: 'median' }), table);
void diagnostics.analyzeItems(table); void cluster.kmeans([[1], [2]], { k: 1 });
async function factor(table: InputTable) {
  const result = await efa.fitEfa(table, { items: table.columns.map(column => ({ column })), factors: 1 });
  return efa.scoreEfa(efa.deserializeEfaModel(efa.serializeEfaModel(result.model)), table);
}
void factor;
`);
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2022'], types: [], strict: true, skipLibCheck: false, noEmit: true }, files: ['types.mts'] }));
  run('declarations', process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json']);
  summary.checks.push('Published declarations type-check in a separate strict NodeNext consumer.');
  writeFileSync(join(consumer, 'browser.mjs'), `
import * as library from '@scatterlab/stats';
globalThis.statistics = library;
globalThis.browserFit = library.pca.fitPca({ columns: ['a', 'b'], nRows: 4, data: { a: [1, 2, 3, 5], b: [3, 1, 4, 2] } }, { k: 1, missing: 'complete' });
`);
  const bundle = buildSync({ absWorkingDir: consumer, entryPoints: ['browser.mjs'], bundle: true, platform: 'browser', format: 'iife', target: 'es2022', write: false, metafile: true });
  assert(Object.values(bundle.metafile.outputs).every(file => file.imports.length === 0), 'Browser bundle has external runtime imports.');
  assert(!Object.keys(bundle.metafile.inputs).some(path => /(?:^|\/)(?:react|next|openai)(?:\/|$)/.test(path)), 'UI/server runtime leaked into the CPU bundle.');
  const context = { crypto: globalThis.crypto, AbortController, TextEncoder, TextDecoder, structuredClone, console, fetch: () => { throw new Error('Unexpected network access.'); } };
  runInNewContext(bundle.outputFiles[0].text, context, { timeout: 10000 });
  assert.equal(context.browserFit.scores.length, 4); assert(Number.isFinite(context.browserFit.scores[0][0]));
  const browserEfa = await context.statistics.efa.fitEfa(fixture, { items: fixture.columns.map(column => ({ column, measurement: 'continuous' })), factors: 2, correlation: 'pearson', missing: 'median' });
  assert.equal(browserEfa.model.parameters.pattern.length, fixture.columns.length);
  writeFileSync(join(directory, 'browser-metafile.json'), JSON.stringify(bundle.metafile, null, 2));
  summary.browserBundleBytes = bundle.outputFiles[0].contents.length;
  summary.checks.push('Self-contained browser bundle executes PCA/EFA in a DOM-free VM; this is not browser interaction or layout testing.');
  // Do not leave dependency copies behind; receipts and exact tarball survive.
  rmSync(join(consumer, 'node_modules'), { recursive: true, force: true });
  summary.status = 'passed';
} catch (error) {
  summary.status = 'failed'; summary.error = String(error); process.exitCode = 1;
}
writeFileSync(join(output, 'package-verification.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
