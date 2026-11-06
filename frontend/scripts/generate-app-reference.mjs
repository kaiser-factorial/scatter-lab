import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync,
  readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REFERENCE_FORMAT = 'scatterlab-app-reference/1';
export const SOURCE_DIRECTORY = 'packages/statistics/src';
export const REFERENCE_DOCUMENTS = [
  'packages/statistics/README.md',
  'packages/statistics/PCA.md',
  'packages/statistics/EFA.md',
  'packages/statistics/VALIDATION.md',
  'packages/statistics/NOTICE.md',
];
export const REFERENCE_FILES = [...REFERENCE_DOCUMENTS];
export const MAX_REFERENCE_FILES = 500;

const excludedDirectories = new Set([
  'node_modules', 'dist', 'test', 'tests', '__tests__', 'fixtures', '__fixtures__', '__mocks__',
]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function readBoundedBytes(fd, maxBytes) {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let length = 0;
  while (length < buffer.length) {
    const count = readSync(fd, buffer, length, buffer.length - length, null);
    if (!count) break;
    length += count;
  }
  if (length > maxBytes) throw new Error(`Reference input exceeds ${maxBytes} bytes.`);
  return buffer.subarray(0, length);
}

function checkedPath(root, path) {
  if (isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Reference paths must be normalized repository-relative paths.');
  }
  const target = resolve(root, path);
  const inside = relative(root, target);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('Reference path escaped its root.');
  let cursor = root;
  for (const part of path.split('/')) {
    cursor = resolve(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Reference symlinks are not allowed: ${path}`);
  }
  if (realpathSync(target) !== target) throw new Error(`Reference path is not canonical: ${path}`);
  return target;
}

function readBoundedFile(root, path, maxBytes) {
  const target = checkedPath(root, path);
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Reference input is not a regular file: ${path}`);
    if (stat.size > maxBytes) throw new Error(`Reference file exceeds ${maxBytes} bytes: ${path}`);
    const bytes = readBoundedBytes(fd, maxBytes);
    // Preserve a UTF-8 BOM as a source character so hashing the emitted text
    // reproduces the exact original byte hash, including its line endings.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes('\0')) throw new Error(`Reference input contains binary data: ${path}`);
    return { text, sha256: hash(bytes) };
  } finally {
    closeSync(fd);
  }
}

function listSources(root, path = SOURCE_DIRECTORY, paths = []) {
  const directory = checkedPath(root, path);
  if (!lstatSync(directory).isDirectory()) throw new Error(`Reference source root is not a directory: ${path}`);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = `${path}/${entry.name}`;
    // Reject links before filtering their names. A reference source tree must
    // never silently start reading a dependency or another local directory.
    if (entry.isSymbolicLink()) throw new Error(`Reference symlinks are not allowed: ${child}`);
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) listSources(root, child, paths);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !/\.(?:test|spec)\.ts$/.test(entry.name)) {
      paths.push(child);
      if (paths.length + REFERENCE_FILES.length > MAX_REFERENCE_FILES) throw new Error(`Reference corpus exceeds ${MAX_REFERENCE_FILES} files.`);
    }
  }
  return paths;
}

function ensureOutputDirectory(root, path) {
  let cursor = root;
  for (const part of path.split('/')) {
    cursor = resolve(cursor, part);
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Reference output directory must be an ordinary directory.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      mkdirSync(cursor);
    }
  }
  return cursor;
}

function existingBytes(path, maxBytes) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Reference output must be an ordinary file.');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return readBoundedBytes(fd, maxBytes); } finally { closeSync(fd); }
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function writeAtomic(path, bytes) {
  const temporary = resolve(dirname(path), `.reference-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, bytes, { flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function retiredSnapshots(directory, maxBytes) {
  const retired = [];
  for (const name of readdirSync(directory).sort()) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error(`Unrecognized public reference artifact: ${name}`);
    const path = resolve(directory, name);
    const bytes = existingBytes(path, maxBytes);
    if (!bytes || hash(bytes) !== name.slice(0, -5)) throw new Error('Existing content-addressed reference asset does not match its hash.');
    let corpus;
    try { corpus = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Error(`Unrecognized public reference snapshot: ${name}`); }
    if (corpus?.format !== REFERENCE_FORMAT || !Array.isArray(corpus.files)
      || !corpus.files.length || corpus.files.length > MAX_REFERENCE_FILES) {
      throw new Error(`Unrecognized public reference snapshot: ${name}`);
    }
    const paths = new Set();
    for (const file of corpus.files) {
      if (!file || typeof file.path !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(file.path)
        || file.path.split('/').some(part => !part || part.startsWith('.')) || paths.has(file.path)
        || !['source', 'documentation'].includes(file.kind) || typeof file.text !== 'string'
        || !/^[a-f0-9]{64}$/.test(file.sha256) || hash(Buffer.from(file.text)) !== file.sha256) {
        throw new Error(`Unrecognized public reference file record: ${name}`);
      }
      paths.add(file.path);
    }
    // Earlier package-only snapshots still support open tabs. A previous wider
    // publication scope must be withdrawn, not merely hidden by a new manifest.
    if (corpus.files.some(file => !file.path.startsWith('packages/statistics/'))) retired.push({ path, digest: name.slice(0, -5) });
  }
  return retired;
}

/**
 * Generate an immutable, public reference asset from a fixed source allowlist.
 * No uploaded data, environment files, dependency tree or arbitrary path can be
 * requested here. Root parameters exist for isolated build/tests, not for model
 * tool arguments. Earlier package-only assets remain available to open tabs;
 * verified older snapshots containing app/docs files are removed from public.
 */
export function generateAppReference({
  repoRoot,
  outputRoot = repoRoot,
  maxFileBytes = 512 * 1024,
  maxCorpusBytes = 4 * 1024 * 1024,
} = {}) {
  if (!repoRoot) throw new Error('A repository root is required.');
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || !Number.isSafeInteger(maxCorpusBytes) || maxCorpusBytes < 1) {
    throw new Error('Reference size limits must be positive safe integers.');
  }
  const sourceRoot = realpathSync(resolve(repoRoot));
  const destinationRoot = realpathSync(resolve(outputRoot));
  const selections = [
    ...listSources(sourceRoot).map(path => ({ path, kind: 'source' })),
    ...REFERENCE_DOCUMENTS.map(path => ({ path, kind: 'documentation' })),
  ].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (selections.length > MAX_REFERENCE_FILES) throw new Error(`Reference corpus exceeds ${MAX_REFERENCE_FILES} files.`);
  const files = [];
  let contentBytes = 0;
  for (const { path, kind } of selections) {
    const content = readBoundedFile(sourceRoot, path, maxFileBytes);
    contentBytes += Buffer.byteLength(content.text, 'utf8');
    if (contentBytes > maxCorpusBytes) throw new Error(`Reference corpus exceeds ${maxCorpusBytes} bytes.`);
    files.push({ path, kind, ...content });
  }
  if (!files.some(file => file.path.startsWith(`${SOURCE_DIRECTORY}/`))) throw new Error('Reference package has no TypeScript sources.');
  const bytes = Buffer.from(`${JSON.stringify({ format: REFERENCE_FORMAT, files })}\n`);
  if (bytes.byteLength > maxCorpusBytes) throw new Error(`Reference JSON exceeds ${maxCorpusBytes} bytes.`);
  const snapshot = hash(bytes);
  const assetPath = `/assistant-reference/${snapshot}.json`;
  const manifest = { format: REFERENCE_FORMAT, snapshot, assetPath, fileCount: files.length, bytes: bytes.byteLength };

  const assetDirectory = ensureOutputDirectory(destinationRoot, 'frontend/public/assistant-reference');
  const manifestDirectory = ensureOutputDirectory(destinationRoot, 'frontend/src/lib/generated');
  // Validate every existing artifact before making changes. Only recognized,
  // hash-verified snapshots may be removed; unfamiliar files stop the build.
  const retired = retiredSnapshots(assetDirectory, maxCorpusBytes);
  const assetFile = resolve(assetDirectory, `${snapshot}.json`);
  const previousAsset = existingBytes(assetFile, maxCorpusBytes);
  if (previousAsset && !previousAsset.equals(bytes)) throw new Error('Existing content-addressed reference asset does not match its hash.');
  if (!previousAsset) writeAtomic(assetFile, bytes);
  for (const artifact of retired) {
    const current = existingBytes(artifact.path, maxCorpusBytes);
    if (!current) continue; // Another build already withdrew this snapshot.
    if (hash(current) !== artifact.digest) throw new Error('Reference artifact changed before removal; refusing to delete it.');
    unlinkSync(artifact.path);
  }

  // Publish the manifest last: a browser can never observe a new manifest
  // before its content-addressed asset exists. Avoid unnecessary dev rebuilds.
  const manifestFile = resolve(manifestDirectory, 'app-reference-manifest.ts');
  const manifestBytes = Buffer.from(`// Generated by scripts/generate-app-reference.mjs. Do not edit.\nexport const APP_REFERENCE_MANIFEST = ${JSON.stringify(manifest, null, 2)} as const;\n`);
  const previousManifest = existingBytes(manifestFile, 4096);
  const changed = !previousManifest?.equals(manifestBytes);
  if (changed) writeAtomic(manifestFile, manifestBytes);
  return { ...manifest, changed, removedSnapshots: retired.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  try {
    const result = generateAppReference({ repoRoot });
    console.log(`App reference: ${result.fileCount} files, ${result.bytes} bytes, snapshot ${result.snapshot.slice(0, 12)}${result.changed ? '' : ' (unchanged)'}. Removed ${result.removedSnapshots} retired snapshots.`);
  } catch (error) {
    console.error(`App reference generation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
