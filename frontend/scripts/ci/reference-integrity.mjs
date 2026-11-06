import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const frontend = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const destination = new URL('./reference-fixtures.json', import.meta.url);
const directories = ['efa-congruence', 'efa-extensions', 'efa-weighted'];
const files = {};
const vendor = resolve(frontend, 'scripts/efa-reference/congruence/vendor');
for (const source of JSON.parse(readFileSync(resolve(vendor, 'sources.json'), 'utf8'))) for (const [name, expectedHash] of Object.entries(source.files)) {
  const actual = createHash('sha256').update(readFileSync(resolve(vendor, name))).digest('hex');
  if (actual !== expectedHash) throw new Error(`Pinned ${source.package} source hash differs: ${name}`);
}
for (const directory of directories) {
  const folder = resolve(frontend, 'src/lib/__tests__/fixtures', directory);
  for (const name of readdirSync(folder).sort()) if (name.endsWith('.input.json') || name.endsWith('.reference.json') || name.endsWith('.ordinal-reference.json') || name.includes('correlation.json')) {
    const path = resolve(folder, name);
    files[relative(frontend, path).replaceAll('\\','/')] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
}
for (const name of ['public.input.json', 'public.reference.json']) {
  const path = resolve(frontend, '../packages/statistics/test/fixtures', name);
  files[relative(frontend, path).replaceAll('\\', '/')] = createHash('sha256').update(readFileSync(path)).digest('hex');
}
if (process.argv.includes('--write')) {
  writeFileSync(destination, JSON.stringify({ schema: 1, scope: 'Exact retained public/synthetic fixture bytes only; does not assert current implementation or generator equals historical execution.', files }, null, 2) + '\n');
  console.log(`Recorded ${Object.keys(files).length} reference fixture hashes.`);
} else {
  const expected = JSON.parse(readFileSync(destination, 'utf8')).files;
  const changed = [...new Set([...Object.keys(files), ...Object.keys(expected)])].filter(name => files[name] !== expected[name]);
  if (changed.length) throw new Error(`Reference fixture integrity changed; review and explicitly refresh the manifest after regeneration: ${changed.join(', ')}`);
  console.log(`Verified ${Object.keys(files).length} retained reference fixture hashes.`);
}
