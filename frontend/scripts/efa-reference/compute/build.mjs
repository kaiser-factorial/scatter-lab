import { build } from "esbuild";
import { mkdir, writeFile, cp } from "node:fs/promises";
const out = "public/efa-qualification/compute";
await mkdir(out, { recursive: true });
await build({ entryPoints: ["scripts/efa-reference/compute/browser.worker.mjs"], bundle: true, format: "esm", outfile: `${out}/worker.js` });
await build({ entryPoints: ["scripts/efa-reference/compute/pipeline.worker.mjs"], bundle: true, format: "esm", outfile: `${out}/pipeline-worker.js` });
await build({ entryPoints: ["scripts/efa-reference/compute/optimization.worker.mjs"], bundle: true, format: "esm", outfile: `${out}/optimization-worker.js` });
await build({ entryPoints: ["scripts/efa-reference/compute/rotation-worker.mjs"], bundle: true, format: "esm", outfile: `${out}/rotation-worker.js` });
await cp("src/lib/__tests__/fixtures/efa-weighted", `${out}/reference`, { recursive: true });
await build({ entryPoints: ["scripts/efa-reference/compute/generate-fixtures.ts"], bundle: true, format: "esm", platform: "node", outfile: "/tmp/scatter-compute-generate.mjs" });
await writeFile(`${out}/index.html`, `<!doctype html><html lang="en"><meta charset="utf-8"><title>EFA compute comparison</title><body><h1>Public/synthetic compute comparison</h1><button id="run">Run kernels</button><button id="cancel">Cancel</button><p id="heartbeat">0</p><p id="stage"></p><p id="cancel-time"></p><pre id="output"></pre><script type="module">
let worker, heartbeat = 0, last = performance.now();
window.maxHeartbeatGap = 0; window.partials = [];
setInterval(() => { const now = performance.now(); window.maxHeartbeatGap = Math.max(window.maxHeartbeatGap, now - last); last = now; document.querySelector('#heartbeat').textContent = ++heartbeat; }, 50);
document.querySelector('#run').onclick = () => {
  worker?.terminate(); document.querySelector('#output').textContent = 'running';
  const params = new URLSearchParams(location.search);
  worker = new Worker(params.has('optimization') ? './optimization-worker.js' : params.has('pipeline') ? './pipeline-worker.js' : './worker.js', { type: 'module' });
  worker.onmessage = ({data}) => { if(data.stage || data.progress) document.querySelector('#stage').textContent = data.stage || JSON.stringify(data.progress); if(data.partial) window.partials.push(data.partial); if(data.probeDispatched) window.probeDispatched = true; if(data.result) { document.querySelector('#output').textContent = JSON.stringify(data.result); if(!data.keepAlive) worker.terminate(); } };
  worker.onerror = event => document.querySelector('#output').textContent = JSON.stringify({status:'failed', error:event.message});
  worker.postMessage({ rotationWorkerSource: window.__rotationWorkerSource, backends: params.has('backend') ? [params.get('backend')] : undefined, fixtures: params.has('fixture') ? [params.get('fixture')] : undefined, n: Number(params.get('n') || 20000), p: Number(params.get('p') || 500), blockSize: params.has('block') ? Number(params.get('block')) : undefined, budgetBytes: params.has('budgetMiB') ? Number(params.get('budgetMiB')) * 1024 ** 2 : undefined, probeCancellation: params.has('probeCancellation'), experimentMode: params.get('mode') || undefined, strictMath: params.has('strictMath'), materializePanels: params.has('panels'), preSplit: params.has('preSplit'), dotChunkSize: params.has('chunk') ? Number(params.get('chunk')) : undefined, rotationWorkers: params.has('rotationWorkers') ? Number(params.get('rotationWorkers')) : undefined });
};
document.querySelector('#cancel').onclick = () => { const start = performance.now(); worker?.terminate(); document.querySelector('#cancel-time').textContent = performance.now() - start; document.querySelector('#output').textContent = 'cancelled'; };
</script></body></html>`);
