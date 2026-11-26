import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dependencies, sha256 } from './runtime.mjs';
const cache = path.resolve(process.argv.find(a => a.startsWith('--cache='))?.slice(8) ?? '.efa-companion');
await mkdir(cache, { recursive: true });
for (const dependency of dependencies) {
  const file = path.join(cache, path.basename(dependency.artifact));
  try { if (sha256(await readFile(file)) === dependency.sha256) continue; } catch {}
  const response = await fetch(dependency.url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error('Pinned Maven download failed');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== dependency.bytes || sha256(bytes) !== dependency.sha256) throw new Error('Dependency hash mismatch');
  await writeFile(file, bytes);
}
console.log('Pinned Scala 2.13.16 / netlib BLAS 3.2.0 dependencies verified. Java 21+ and native BLAS are required.');
