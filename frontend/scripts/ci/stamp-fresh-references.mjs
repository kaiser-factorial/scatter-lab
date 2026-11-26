import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(process.argv[2]);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const stamped = [];
for (const name of ['normal','heavy-tail','skew','pairwise','complete']) {
  const path = join(root, 'efa-weighted', `${name}.reference.json`), original = readFileSync(path), reference = JSON.parse(original);
  reference.provenance.inputSha256 = sha(readFileSync(join(root, 'efa-weighted', `${name}.input.json`)));
  writeFileSync(path, JSON.stringify(reference, null, 2) + '\n');
  stamped.push({ path, originalRJsonSha256: sha(original), inputSha256: reference.provenance.inputSha256, stampedJsonSha256: sha(readFileSync(path)), transformation: 'Attach exact input-byte SHA256 and reserialize JSON; numerical values unchanged.' });
}
const files = {};
for (const folder of ['efa-congruence','efa-extensions','efa-weighted']) for (const name of readdirSync(join(root, folder)).sort()) files[`${folder}/${name}`] = sha(readFileSync(join(root, folder, name)));
writeFileSync(join(root, 'fresh-manifest.json'), JSON.stringify({ schema: 1, qualification: 'Freshly executed R fixtures for this CI run; not an assertion of historical byte equality or universal package-default equivalence.', stamped, files }, null, 2) + '\n');
