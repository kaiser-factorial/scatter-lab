import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
await build({ entryPoints: ['scripts/efa-companion/large-transport.worker.mjs'], bundle: true, format: 'esm', outfile: 'public/efa-qualification/workflow/large.js' });
const pairing = JSON.parse(await readFile('/tmp/scatter-efa-companion-pairing.json', 'utf8'));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage(), results = [];
  await page.exposeFunction('reportStage', stage => console.log(JSON.stringify({ stage })));
  await page.goto('http://localhost:3000/efa-qualification/workflow/index.html');
  for (const backend of ['webgpu', 'scala']) {
    await page.evaluate(({ backend, pairing }) => {
      window.largeResult = undefined;
      window.largeWorker = new Worker('./large.js', { type: 'module' });
      window.largeWorker.onmessage = ({ data }) => { if (data.stage && window.lastStage !== data.stage) { window.lastStage = data.stage; void window.reportStage(data.stage); } if (data.result || data.error) window.largeResult = data; };
      window.largeWorker.onerror = e => window.largeResult = { error: e.message };
      window.largeWorker.postMessage({ backend, pairing });
    }, { backend, pairing });
    await page.waitForFunction(() => window.largeResult, {}, { timeout: 300000 });
    const result = await page.evaluate(() => window.largeResult);
    if (result.error) throw new Error(result.error);
    results.push(result.result);
    console.log(JSON.stringify({ backend, status: result.result.status, elapsedMs: result.result.elapsedMs }));
    await page.waitForTimeout(1000);
    await page.evaluate(() => window.largeWorker.terminate());
  }
  await writeFile('scripts/efa-companion/evidence/large-transport.json', JSON.stringify({ recordedAt: new Date().toISOString(), browser: browser.version(), results }, null, 2) + '\n');
} finally { await browser.close(); }
