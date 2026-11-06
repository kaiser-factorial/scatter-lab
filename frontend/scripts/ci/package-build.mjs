import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const statisticsRoot = fileURLToPath(new URL('../../../packages/statistics/', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Bind the numerical run to current TypeScript as well as emitted JS. A successful
 * old build cannot stand in for a changed source tree. */
export function currentPackageBuild(root = statisticsRoot, relativeTo = process.cwd()) {
  const manifestPath = resolve(root, 'dist/build-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.format !== 'scatterlab-stats-build/1' || !manifest.sourceHashes ||
      Object.keys(manifest.sourceHashes).length === 0) throw new Error('Missing statistics source manifest. Run npm run build:stats from the repository root.');
  const hashes = { [relative(relativeTo, manifestPath)]: sha(readFileSync(manifestPath)) };
  for (const [path, expected] of Object.entries(manifest.sourceHashes)) {
    const absolute = resolve(root, path);
    if (!path.startsWith('src/') || !absolute.startsWith(resolve(root, 'src') + '/')) throw new Error(`Invalid statistics source path: ${path}`);
    const actual = sha(readFileSync(absolute));
    if (actual !== expected) throw new Error(`Statistics package build is stale: ${path}. Run npm run build:stats.`);
    hashes[relative(relativeTo, absolute)] = actual;
  }
  return hashes;
}
