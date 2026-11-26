import { readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
const folder = "src/lib/__tests__/fixtures/efa-weighted",
  sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const name of ["normal", "heavy-tail", "skew", "pairwise", "complete"]) {
  const file = `${folder}/${name}.reference.json`,
    ref = JSON.parse(await readFile(file, "utf8"));
  ref.provenance.inputSha256 = sha(
    await readFile(`${folder}/${name}.input.json`),
  );
  await writeFile(file, JSON.stringify(ref, null, 2) + "\n");
}
const fixtureHashes = {};
for (const file of (await readdir(folder))
  .filter((file) => file !== "manifest.json")
  .sort())
  fixtureHashes[file] = sha(await readFile(`${folder}/${file}`));
const sourceHashes = {};
for (const file of [
  "generate-weighted.R",
  "Dockerfile.weighted",
  "install-weighted.R",
  "weighted-package-pins.json",
])
  sourceHashes[file] = sha(await readFile(`scripts/efa-reference/${file}`));
await writeFile(
  `${folder}/manifest.json`,
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      fixtureHashes,
      sourceHashes,
      qualificationScope:
        "Independent pinned R pair-margin moments, DWLS, robust scaled/shifted tests, lavaan bordered SEs with explicit std.ov=FALSE, and full numDeriv rotation delta maps. Original default std.ov=TRUE SEs retained separately. No private data.",
      runtimeImage: "scatter-lab-efa-weighted:4.5.1",
    },
    null,
    2,
  ) + "\n",
);
