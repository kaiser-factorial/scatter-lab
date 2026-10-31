import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
const out = "public/efa-qualification";
await mkdir(out, { recursive: true });
await build({
  entryPoints: ["scripts/efa-reference/browser-benchmark.ts"],
  bundle: true,
  format: "esm",
  outfile: `${out}/main.js`,
});
await build({
  entryPoints: ["src/lib/efa/efa.worker.ts"],
  bundle: true,
  format: "esm",
  outfile: `${out}/worker.js`,
});
await writeFile(
  `${out}/index.html`,
  '<!doctype html><html lang="en"><meta charset="utf-8"><title>EFA numerical qualification</title><body><h1>EFA qualification — synthetic data only</h1><button id="run">Run 500 × 20,000</button><button id="cancel">Cancel</button><p>UI heartbeat: <span id="heartbeat">0</span></p><p>Cancellation ms: <span id="cancelTime"></span></p><pre id="stage"></pre><pre id="output"></pre><script type="module" src="/efa-qualification/main.js"></script></body></html>',
);
