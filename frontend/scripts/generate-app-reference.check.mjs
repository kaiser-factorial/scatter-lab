import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
// Run with node --test; keep outside Vitest's *.test.* discovery.
import { test } from 'node:test';
import { REFERENCE_DOCUMENTS, generateAppReference } from './generate-app-reference.mjs';

function fixture(t) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'scatter-reference-test-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const put = (path, contents = `// fixture ${path}\n`) => {
    mkdirSync(dirname(join(repoRoot, path)), { recursive: true });
    writeFileSync(join(repoRoot, path), contents);
  };
  for (const path of REFERENCE_DOCUMENTS) put(path);
  put('packages/statistics/src/pca.ts', 'export const pca = 1;\n');
  put('packages/statistics/src/internal/efa/fit.ts', 'export const fit = 2;\n');
  const generate = options => generateAppReference({ repoRoot, ...options });
  const asset = result => readFileSync(join(repoRoot, 'frontend/public', result.assetPath));
  return { repoRoot, put, generate, asset };
}

function writeSnapshot(repoRoot, corpus) {
  const bytes = Buffer.from(`${JSON.stringify(corpus)}\n`);
  const name = `${createHash('sha256').update(bytes).digest('hex')}.json`;
  const directory = join(repoRoot, 'frontend/public/assistant-reference');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), bytes);
  return name;
}

function referenceFile(path, text = 'previously published source\n', kind = 'source') {
  return { path, kind, text, sha256: createHash('sha256').update(text).digest('hex') };
}

test('publishes only package implementation and package documentation, excluding all app and other local material', t => {
  const { repoRoot, put, generate, asset } = fixture(t);
  for (const path of [
    '.env', 'frontend/.env.local', 'private/respondents.csv', 'data/respondents.csv',
    'packages/statistics/node_modules/dependency/index.ts', 'packages/statistics/dist/pca.ts',
    'packages/statistics/src/.hidden/secret.ts', 'packages/statistics/src/test/private.ts',
    'packages/statistics/src/__tests__/data.ts', 'packages/statistics/src/fixtures/respondents.ts',
    'packages/statistics/src/node_modules/foreign.ts', 'packages/statistics/src/pca.test.ts',
    'packages/statistics/src/pca.spec.ts', 'packages/statistics/src/data.csv',
    'frontend/src/lib/assistant.ts', 'frontend/src/lib/app-guide.ts', 'docs/private.md',
    'docs/EFA.md', 'docs/DECOMPOSITION-GUIDANCE.md', 'docs/STATISTICS-LIBRARY.md',
    'frontend/src/lib/dataPolicy.ts', 'frontend/src/lib/aggregatePolicy.ts',
    'frontend/src/lib/disclosures.ts', 'frontend/src/lib/engine.ts',
    'frontend/src/lib/pca-tools.ts', 'frontend/src/lib/decomposition-tools.ts',
    'frontend/src/lib/efa/tools.ts', 'frontend/src/lib/efa/service.ts', 'frontend/src/lib/efa/controller.ts',
  ]) put(path, 'PRIVATE_CANARY_DO_NOT_PUBLISH');
  const result = generate();
  const bytes = asset(result);
  const corpus = JSON.parse(bytes);
  assert.equal(corpus.format, 'scatterlab-app-reference/1');
  assert.equal(result.fileCount, 7);
  assert.equal(result.bytes, bytes.byteLength);
  assert.equal(result.snapshot, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(bytes.includes('PRIVATE_CANARY_DO_NOT_PUBLISH'), false);
  assert.equal(bytes.includes(repoRoot), false);
  assert.deepEqual(corpus.files.map(file => file.path), corpus.files.map(file => file.path).sort());
  assert.ok(corpus.files.every(file => file.path.startsWith('packages/statistics/')));
  const fit = corpus.files.find(file => file.path === 'packages/statistics/src/internal/efa/fit.ts');
  assert.equal(fit.kind, 'source');
  assert.equal(fit.text, 'export const fit = 2;\n');
  assert.equal(fit.sha256, createHash('sha256').update(fit.text).digest('hex'));
  assert.equal(corpus.files.find(file => file.path === 'packages/statistics/EFA.md').kind, 'documentation');
  const manifestText = readFileSync(join(repoRoot, 'frontend/src/lib/generated/app-reference-manifest.ts'), 'utf8');
  assert.match(manifestText, /export const APP_REFERENCE_MANIFEST =/);
  assert.ok(manifestText.includes(result.snapshot));
  assert.equal(manifestText.includes(repoRoot), false);
});

test('is deterministic, avoids touching an unchanged manifest, and retains earlier assets after changes', t => {
  const { repoRoot, put, generate, asset } = fixture(t);
  const first = generate();
  const manifestPath = join(repoRoot, 'frontend/src/lib/generated/app-reference-manifest.ts');
  const oldTime = new Date('2001-01-01T00:00:00Z');
  utimesSync(manifestPath, oldTime, oldTime);
  const second = generate();
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(first.snapshot, second.snapshot);
  assert.equal(statSync(manifestPath).mtimeMs, oldTime.getTime());
  put('packages/statistics/src/pca.ts', 'export const pca = 42;\n');
  const third = generate();
  assert.notEqual(first.snapshot, third.snapshot);
  assert.equal(third.changed, true);
  assert.equal(JSON.parse(asset(first)).files.find(file => file.path.endsWith('/src/pca.ts')).text, 'export const pca = 1;\n');
  assert.equal(JSON.parse(asset(third)).files.find(file => file.path.endsWith('/src/pca.ts')).text, 'export const pca = 42;\n');
  assert.equal(readdirSync(join(repoRoot, 'frontend/public/assistant-reference')).length, 2);
});

test('withdraws verified older mixed snapshots while preserving package-only snapshots', t => {
  const { repoRoot, put, generate, asset } = fixture(t);
  const first = generate();
  put('packages/statistics/src/pca.ts', 'export const pca = 42;\n');
  const current = generate();
  const corpus = JSON.parse(asset(first));
  const oldApp = writeSnapshot(repoRoot, { ...corpus,
    files: [...corpus.files, referenceFile('frontend/src/lib/dataPolicy.ts')].sort((a, b) => a.path.localeCompare(b.path)),
  });
  const oldDocs = writeSnapshot(repoRoot, { ...corpus,
    files: [...corpus.files, referenceFile('docs/EFA.md', 'previous app documentation\n', 'documentation')].sort((a, b) => a.path.localeCompare(b.path)),
  });
  const result = generate();
  assert.equal(result.snapshot, current.snapshot);
  assert.equal(result.changed, false);
  assert.equal(result.removedSnapshots, 2);
  assert.doesNotThrow(() => asset(first));
  assert.doesNotThrow(() => asset(current));
  const remaining = readdirSync(join(repoRoot, 'frontend/public/assistant-reference'));
  assert.equal(remaining.length, 2);
  assert.equal(remaining.includes(oldApp), false);
  assert.equal(remaining.includes(oldDocs), false);
  for (const name of remaining) {
    const saved = JSON.parse(readFileSync(join(repoRoot, 'frontend/public/assistant-reference', name)));
    assert.ok(saved.files.every(file => file.path.startsWith('packages/statistics/')));
  }
});

test('fails on an unfamiliar public artifact without deleting it or partially retiring recognized snapshots', t => {
  const { repoRoot, put, generate, asset } = fixture(t);
  const first = generate();
  const corpus = JSON.parse(asset(first));
  const retiredName = writeSnapshot(repoRoot, { ...corpus,
    files: [...corpus.files, referenceFile('frontend/src/lib/engine.ts')],
  });
  put('frontend/public/assistant-reference/unowned.json', 'keep this unrelated file');
  const manifestPath = join(repoRoot, 'frontend/src/lib/generated/app-reference-manifest.ts');
  const before = readFileSync(manifestPath, 'utf8');
  assert.throws(() => generate(), /Unrecognized public reference artifact/);
  assert.equal(readFileSync(join(repoRoot, 'frontend/public/assistant-reference/unowned.json'), 'utf8'), 'keep this unrelated file');
  assert.doesNotThrow(() => readFileSync(join(repoRoot, 'frontend/public/assistant-reference', retiredName)));
  assert.equal(readFileSync(manifestPath, 'utf8'), before);
});

test('fails on hash-valid but unrecognized snapshot formats or invalid file provenance', t => {
  const { repoRoot, generate } = fixture(t);
  generate();
  const directory = join(repoRoot, 'frontend/public/assistant-reference');
  const unknown = writeSnapshot(repoRoot, { format: 'unrelated/1', files: [referenceFile('frontend/src/lib/engine.ts')] });
  assert.throws(() => generate(), /Unrecognized public reference snapshot/);
  assert.doesNotThrow(() => readFileSync(join(directory, unknown)));
  rmSync(join(directory, unknown));
  const tamperedFile = writeSnapshot(repoRoot, { format: 'scatterlab-app-reference/1',
    files: [{ ...referenceFile('frontend/src/lib/engine.ts'), text: 'changed bytes' }],
  });
  assert.throws(() => generate(), /Unrecognized public reference file record/);
  assert.doesNotThrow(() => readFileSync(join(directory, tamperedFile)));
  rmSync(join(directory, tamperedFile));
  const traversal = writeSnapshot(repoRoot, { format: 'scatterlab-app-reference/1', files: [referenceFile('packages/statistics/../../secret.ts')] });
  assert.throws(() => generate(), /Unrecognized public reference file record/);
  assert.doesNotThrow(() => readFileSync(join(directory, traversal)));
});

test('rejects a symlink file in the source tree before reading its target', t => {
  const { repoRoot, put, generate } = fixture(t);
  put('outside/private.ts', 'DO_NOT_READ');
  symlinkSync(join(repoRoot, 'outside/private.ts'), join(repoRoot, 'packages/statistics/src/linked.ts'));
  assert.throws(() => generate(), /symlinks are not allowed/);
});

test('rejects directory and explicit-document symlinks', t => {
  const { repoRoot, put, generate } = fixture(t);
  put('outside/private.ts', 'DO_NOT_READ');
  const linked = join(repoRoot, 'packages/statistics/src/linked');
  symlinkSync(join(repoRoot, 'outside'), linked);
  assert.throws(() => generate(), /symlinks are not allowed/);
  rmSync(linked);
  rmSync(join(repoRoot, 'packages/statistics/EFA.md'));
  symlinkSync(join(repoRoot, 'outside/private.ts'), join(repoRoot, 'packages/statistics/EFA.md'));
  assert.throws(() => generate(), /symlinks are not allowed/);
});

test('rejects symlinked parent and output directories', t => {
  const { repoRoot, put, generate } = fixture(t);
  put('outside/output.txt');
  mkdirSync(join(repoRoot, 'frontend/public'), { recursive: true });
  symlinkSync(join(repoRoot, 'outside'), join(repoRoot, 'frontend/public/assistant-reference'));
  assert.throws(() => generate(), /ordinary directory/);
  rmSync(join(repoRoot, 'frontend/public/assistant-reference'));
  rmSync(join(repoRoot, 'packages/statistics/src/internal'), { recursive: true });
  symlinkSync(join(repoRoot, 'outside'), join(repoRoot, 'packages/statistics/src/internal'));
  assert.throws(() => generate(), /symlinks are not allowed/);
});

test('rejects missing, oversized, binary or invalid UTF-8 source files and oversized corpus', t => {
  const { repoRoot, put, generate } = fixture(t);
  assert.throws(() => generate({ maxFileBytes: 8 }), /exceeds/);
  assert.throws(() => generate({ maxCorpusBytes: 100 }), /exceeds/);
  put('packages/statistics/src/pca.ts', Buffer.from([0xff]));
  assert.throws(() => generate(), /encoded data was not valid/);
  put('packages/statistics/src/pca.ts', '\0');
  assert.throws(() => generate(), /binary data/);
  put('packages/statistics/src/pca.ts');
  rmSync(join(repoRoot, 'packages/statistics/EFA.md'));
  assert.throws(() => generate(), /ENOENT/);
});

test('uses an isolated output root and refuses corrupt or symlinked existing assets', t => {
  const { repoRoot, generate } = fixture(t);
  const outputRoot = mkdtempSync(join(tmpdir(), 'scatter-reference-output-'));
  t.after(() => rmSync(outputRoot, { recursive: true, force: true }));
  const result = generate({ outputRoot });
  const assetFile = join(outputRoot, 'frontend/public', result.assetPath);
  writeFileSync(assetFile, 'corrupt');
  assert.throws(() => generate({ outputRoot }), /does not match its hash/);
  rmSync(assetFile);
  symlinkSync(join(repoRoot, 'packages/statistics/src/pca.ts'), assetFile);
  assert.throws(() => generate({ outputRoot }), /ordinary file/);
});

test('rejects an unexpectedly large source-file inventory', t => {
  const { put, generate } = fixture(t);
  for (let i = 0; i < 500; i++) put(`packages/statistics/src/generated/file-${i}.ts`, 'export {};');
  assert.throws(() => generate(), /exceeds 500 files/);
});

test('preserves exact UTF-8 source bytes including BOM, non-ASCII characters and CRLF', t => {
  const { put, generate, asset } = fixture(t);
  const source = '\ufeff// ΛΦ and β\r\nexport const variance = 1;\r\n';
  put('packages/statistics/src/pca.ts', source);
  const corpus = JSON.parse(asset(generate()));
  const file = corpus.files.find(file => file.path === 'packages/statistics/src/pca.ts');
  assert.equal(file.text, source);
  assert.equal(file.sha256, createHash('sha256').update(file.text).digest('hex'));
});
