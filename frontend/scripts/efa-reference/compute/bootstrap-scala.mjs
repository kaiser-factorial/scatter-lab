// Local benchmark dependencies only: nothing is added to the app bundle.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
const directory = process.argv[2] ?? "/tmp/scatter-efa-scala";
const artifacts = [
  ...["scala-compiler", "scala-library", "scala-reflect"].map(name => `org/scala-lang/${name}/2.13.16/${name}-2.13.16.jar`),
  "dev/ludovic/netlib/blas/3.2.0/blas-3.2.0.jar",
  "net/sourceforge/f2j/arpack_combined_all/0.1/arpack_combined_all-0.1.jar",
];
await mkdir(directory, { recursive: true });
const manifest = [];
for (const artifact of artifacts) {
  const url = `https://repo.maven.apache.org/maven2/${artifact}`;
  const filename = path.join(directory, path.basename(artifact));
  const checksumResponse = await fetch(`${url}.sha1`);
  if (!checksumResponse.ok) throw new Error(`${url}: checksum ${checksumResponse.status}`);
  const expected = (await checksumResponse.text()).trim().split(/\s+/)[0];
  let data;
  try { data = await readFile(filename); } catch {}
  if (!data || createHash("sha1").update(data).digest("hex") !== expected) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    data = Buffer.from(await response.arrayBuffer());
    if (createHash("sha1").update(data).digest("hex") !== expected) throw new Error(`Checksum mismatch: ${url}`);
    await writeFile(filename, data);
  }
  manifest.push({ artifact, url, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex"), repositorySha1: expected });
}
await writeFile(path.join(directory, "dependencies.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ directory, artifacts: manifest }));
