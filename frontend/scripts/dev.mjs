import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { generateAppReference, REFERENCE_FILES } from './generate-app-reference.mjs';
import { currentPackageBuild } from './ci/package-build.mjs';

// Launched by `dev start frontend`, after predev builds the library once.
// Next watches emitted ESM; this small companion keeps it current when the
// numerical TypeScript sources change, without restarting a healthy server.
const frontend = fileURLToPath(new URL('..', import.meta.url));
const library = new URL('../../packages/statistics/', import.meta.url);
const repository = fileURLToPath(new URL('../..', import.meta.url));
let builder, timer, referenceTimer, pending = false, closing = false;
function refreshReference() {
  if (closing || builder || pending) return;
  try {
    currentPackageBuild();
    const result = generateAppReference({ repoRoot: repository });
    if (result.changed) console.log(`[reference] Updated ${result.fileCount} source and documentation files.`);
  } catch (error) { console.error('[reference] Generation failed; the previous snapshot remains available:', error.message); }
}
function rebuild() {
  if (closing) return;
  if (builder) { pending = true; return; }
  console.log('[statistics] Rebuilding changed library sources…');
  builder = spawn(process.execPath, [fileURLToPath(new URL('scripts/build.mjs', library))], { cwd: frontend, stdio: 'inherit' });
  builder.on('error', error => console.error('[statistics]', error));
  builder.on('exit', code => {
    builder = undefined;
    if (code && !closing) console.error('[statistics] Build failed; fix the reported source errors. The previous successful build remains available.');
    if (pending) { pending = false; rebuild(); }
    else if (code === 0) refreshReference();
  });
}
function changed() { clearTimeout(timer); timer = setTimeout(rebuild, 250); }
const watchers = [watch(new URL('src/', library), { recursive: true }, changed), watch(new URL('tsconfig.json', library), changed)];
// Watch parent directories so editors that replace files atomically are covered.
// Only explicitly published package documents trigger a refresh; generated output
// and user data never enter the corpus or cause a rebuild loop.
const referenceDirectories = new Map();
for (const path of REFERENCE_FILES) {
  const directory = path.slice(0, path.lastIndexOf('/'));
  const names = referenceDirectories.get(directory) ?? new Set();
  names.add(path.slice(path.lastIndexOf('/') + 1));
  referenceDirectories.set(directory, names);
}
for (const [directory, names] of referenceDirectories) watchers.push(watch(resolve(repository, directory), (_event, filename) => {
  if (filename && !names.has(String(filename))) return;
  clearTimeout(referenceTimer); referenceTimer = setTimeout(refreshReference, 250);
}));
const next = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/next/dist/bin/next', import.meta.url)), 'dev', ...process.argv.slice(2)], { cwd: frontend, stdio: 'inherit' });
function close(signal = 'SIGTERM') {
  if (closing) return;
  closing = true; clearTimeout(timer); clearTimeout(referenceTimer); watchers.forEach(watcher => watcher.close());
  builder?.kill(signal); next.kill(signal);
}
process.on('SIGINT', () => close('SIGINT'));
process.on('SIGTERM', () => close());
next.on('error', error => { console.error(error); close(); process.exitCode = 1; });
next.on('exit', code => { close(); process.exitCode = code ?? 0; });
