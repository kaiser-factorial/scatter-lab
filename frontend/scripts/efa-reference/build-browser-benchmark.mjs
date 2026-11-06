import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
const out = process.argv[2] ?? "public/efa-qualification";
await mkdir(out, { recursive: true });
await build({
  entryPoints: ["scripts/efa-reference/large-imputation-benchmark.ts"],
  bundle: true,
  format: "esm",
  outfile: `${out}/large-imputation.js`,
});
await writeFile(
  `${out}/large-imputation.html`,
  '<!doctype html><html lang="en"><meta charset="utf-8"><title>Large MICE execution qualification</title><body><button id="run">Run large imputation</button><button id="cancel">Cancel</button><p id="heartbeat"></p><p id="cancelTime"></p><pre id="stage"></pre><pre id="output"></pre><script type="module" src="./large-imputation.js"></script></body></html>',
);
await build({
  entryPoints: ["scripts/efa-reference/extensions-benchmark.ts"],
  bundle: true,
  format: "esm",
  outfile: `${out}/extensions.js`,
});
await writeFile(
  `${out}/extensions.html`,
  '<!doctype html><html lang="en"><meta charset="utf-8"><title>EFA extensions qualification</title><body><button id="run">Run extensions</button><p id="heartbeat"></p><pre id="stage"></pre><pre id="output"></pre><script type="module" src="./extensions.js"></script></body></html>',
);
await build({
  entryPoints: ["scripts/efa-reference/parallel-benchmark.ts"],
  bundle: true,
  format: "esm",
  outfile: `${out}/parallel.js`,
});
await writeFile(
  `${out}/parallel.html`,
  '<!doctype html><html lang="en"><meta charset="utf-8"><title>EFA parallel qualification</title><body><button id="run">Run batch</button><button id="cancel">Cancel</button><p id="heartbeat"></p><p id="cancelTime"></p><pre id="stage"></pre><pre id="output"></pre><script type="module" src="./parallel.js"></script></body></html>',
);
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
  '<!doctype html><html lang="en"><meta charset="utf-8"><title>EFA numerical qualification</title><body><h1>EFA qualification — synthetic data only</h1><button id="run">Run 500 × 20,000</button><button id="cancel">Cancel</button><p>UI heartbeat: <span id="heartbeat">0</span></p><p>Cancellation ms: <span id="cancelTime"></span></p><pre id="stage"></pre><pre id="output"></pre><script type="module" src="./main.js"></script></body></html>',
);
