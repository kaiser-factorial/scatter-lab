import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
const out = "public/efa-qualification/weighted";
await mkdir(out, { recursive: true });
for (const [source, name] of [
  ["weighted-benchmark.ts", "main"],
  ["weighted-benchmark.worker.ts", "weighted-worker"],
])
  await build({
    entryPoints: [`scripts/efa-reference/${source}`],
    bundle: true,
    format: "esm",
    outfile: `${out}/${name}.js`,
  });
await writeFile(
  `${out}/index.html`,
  '<!doctype html><html lang="en"><meta charset="utf-8"><title>Weighted EFA numerical qualification</title><body><button id="run">Run weighted benchmark</button><button id="cancel">Cancel</button><p id="heartbeat"></p><p id="cancelTime"></p><pre id="stage"></pre><pre id="output"></pre><script type="module" src="./main.js"></script></body></html>',
);
