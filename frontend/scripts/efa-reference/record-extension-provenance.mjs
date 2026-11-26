import { readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
const root = new URL(
  "../../src/lib/__tests__/fixtures/efa-extensions/",
  import.meta.url,
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonHash = (value) => sha(JSON.stringify(value));
const files = {};
for (const name of (await readdir(root))
  .filter((n) => n.endsWith(".reference.json"))
  .sort()) {
  const bytes = await readFile(new URL(name, root)),
    value = JSON.parse(bytes);
  const inputs =
    value.table ??
    value.input ??
    Object.fromEntries(
      Object.entries(value.cases ?? {}).map(([key, c]) => [
        key,
        c.table ?? {
          x: c.x,
          y: c.y,
          levels: c.levels,
          uniforms: c.uniforms,
          normals: c.normals,
        },
      ]),
    );
  files[name] = {
    sha256: sha(bytes),
    inputJsonSha256: jsonHash(inputs),
    ...(value.null
      ? { savedNullInputHashes: value.null.map((v) => jsonHash(v.data)) }
      : {}),
    provenance: value.provenance,
  };
}
const scripts = {};
for (const name of [
  "Dockerfile",
  "Dockerfile.extensions",
  "install.R",
  "generate-conditional.R",
  "generate-stability.R",
  "generate-large-null.R",
  "benchmark-data.ts",
])
  scripts[name] = sha(await readFile(new URL(name, import.meta.url)));
const correlation = await readFile(
  new URL("parallel-large-correlation.json", root),
);
await writeFile(
  new URL("manifest.json", root),
  JSON.stringify(
    {
      schema: 1,
      hashConvention:
        "SHA-256; reference/script hashes use exact bytes; input hashes use compact JSON.stringify of the specified input object",
      files,
      scripts,
      largeCorrelationSha256: sha(correlation),
      secondLargeCorrelationSha256: sha(
        await readFile(new URL("parallel-large-8802-correlation.json", root)),
      ),
      difficultStartCorrelationSha256: sha(
        await readFile(new URL("parallel-large-8804-correlation.json", root)),
      ),
    },
    null,
    2,
  ) + "\n",
);
