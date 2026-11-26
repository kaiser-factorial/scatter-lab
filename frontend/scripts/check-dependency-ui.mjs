import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const label = process.argv[2] ?? 'after';
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Use a simple artifact label.');
const base = new URL(process.argv[3] ?? 'http://localhost:3000');
if (!['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('Local app only.');
const directory = resolve('.ci-artifacts/dependency-ui', label);
await mkdir(directory, { recursive: true });
const require = createRequire(import.meta.url);
const plotlyVersion = JSON.parse(await readFile(require.resolve('plotly.js-gl3d-dist-min/package.json'), 'utf8')).version;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const report = { label, status: 'running', themes: [], errors: [], externalRequests: [] };
try {
  for (const theme of ['primary', 'terminal']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(20_000);
    report.stage = `${theme}: load demo`;
    page.on('pageerror', error => report.errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== base.origin) { report.externalRequests.push(url.origin); return route.abort(); }
      return route.continue();
    });
    await page.addInitScript(value => localStorage.setItem('theme', value), theme);
    await page.goto(base.href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__scatterlabBridge?.current, {}, { timeout: 45_000 });
    await page.evaluate(() => window.__scatterlabBridge.current.loadDemoData('iris'));
    await page.waitForFunction(() => document.getElementById('active-plot')?._fullLayout?.scene);
    await page.evaluate(() => window.__scatterlabBridge.current.controlView({ rotation: 'stop' }));
    const original = await page.evaluate(() => {
      const graph = document.getElementById('active-plot');
      window.initialActivePlot = graph;
      return { theme: document.documentElement.dataset.theme, types: graph.data.map(trace => trace.type),
        points: graph.data.reduce((sum, trace) => sum + trace.x.length, 0), rows: window.__scatterlabBridge.current.getState().datasets[0].nRows, cloudUpload: graph._context.showSendToCloud };
    });
    assert.equal(original.theme, theme); assert.equal(original.rows, 150);
    assert.ok(original.types.includes('scatter3d')); assert.equal(original.cloudUpload, false);
    if (theme === 'terminal') {
      const section = page.locator('[data-scatter-section="data"] header button').first();
      await section.focus();
      await section.press('Enter');
      assert.equal(await section.getAttribute('aria-expanded'), 'false');
      await section.press('Space');
      assert.equal(await section.getAttribute('aria-expanded'), 'true');
      await page.getByRole('button', { name: 'Collapse Legend', exact: true }).click();
      await page.getByRole('button', { name: 'Expand Legend', exact: true }).press('Enter');
      await page.getByRole('button', { name: 'Expand Notes', exact: true }).click();
      const notes = page.getByPlaceholder('Add observations here...');
      await notes.fill('Synthetic QA note');
      await page.getByRole('button', { name: 'Collapse Notes', exact: true }).click();
      await page.getByRole('button', { name: 'Expand Notes', exact: true }).click();
      assert.equal(await notes.inputValue(), 'Synthetic QA note');
      await page.getByRole('button', { name: 'Collapse Notes', exact: true }).click();
    }
    await page.screenshot({ path: resolve(directory, `${theme}-3d.png`) });
    report.stage = `${theme}: 2D, pin and resize`;
    await page.evaluate(() => window.__scatterlabBridge.current.setPlot({ view_mode: '2D' }));
    await page.waitForFunction(() => document.getElementById('active-plot')?.data?.every(trace => trace.type === 'scatter'));
    await page.evaluate(() => window.__scatterlabBridge.current.pinView());
    await page.waitForFunction(() => document.querySelectorAll('.js-plotly-plot').length === 2);
    assert.ok(await page.evaluate(() => [...document.querySelectorAll('.js-plotly-plot')].every(graph => graph._context.showSendToCloud === false)));
    assert.equal(await page.evaluate(() => window.initialActivePlot === document.getElementById('active-plot')), true);
    await page.evaluate(() => window.__scatterlabBridge.current.controlView({ zoom: 1.5 }));
    await page.waitForFunction(() => document.getElementById('active-plot')?._fullLayout?.xaxis?.autorange === false);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForFunction(() => {
      const graph = document.getElementById('active-plot');
      return Math.abs(graph._fullLayout.width - graph.getBoundingClientRect().width) < 3;
    });
    await page.screenshot({ path: resolve(directory, `${theme}-2d-pinned.png`) });
    report.stage = `${theme}: remove pin`;
    await page.evaluate(() => window.__scatterlabBridge.current.removePin(1));
    await page.waitForFunction(() => document.querySelectorAll('.js-plotly-plot').length === 1);
    assert.equal(await page.evaluate(() => window.initialActivePlot === document.getElementById('active-plot')), true);
    report.stage = `${theme}: PCA`;
    const pca = await page.evaluate(() => window.__scatterlabBridge.current.runPCA({ n_components: 2, label: 'dependency-check' }));
    report.pcaMessage = pca;
    await page.waitForFunction(() => window.__scatterlabBridge.current.getState().pcaRuns.length === 1);
    report.stage = `${theme}: clustering`;
    const clustered = await page.evaluate(() => window.__scatterlabBridge.current.runClustering('KMEANS', { k: 3, standardize: false }));
    assert.ok(!/^error|failed/i.test(clustered));
    report.stage = `${theme}: exports`;
    const pngPromise = page.waitForEvent('download');
    await page.evaluate(() => window.__scatterlabBridge.current.saveActiveViewPng());
    const png = await pngPromise;
    const pngPath = resolve(directory, `${theme}-export.png`); await png.saveAs(pngPath);
    assert.ok((await stat(pngPath)).size > 1000);
    const htmlPromise = page.waitForEvent('download');
    await page.evaluate(() => window.__scatterlabBridge.current.saveInteractiveHtml());
    const html = await htmlPromise;
    const htmlPath = resolve(directory, `${theme}-export.html`); await html.saveAs(htmlPath);
    const document = await readFile(htmlPath, 'utf8');
    assert.ok(document.includes('Plotly.newPlot')); assert.ok(document.length > 100_000);
    const preview = await browser.newPage();
    preview.setDefaultTimeout(20_000);
    preview.on('pageerror', error => report.errors.push(error.message));
    await preview.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        report.externalRequests.push(url.origin); return route.abort();
      }
      return route.continue();
    });
    await preview.goto(pathToFileURL(htmlPath).href);
    await preview.waitForFunction(() => document.getElementById('plot')?._fullLayout);
    assert.equal(await preview.evaluate(() => window.Plotly.version), plotlyVersion);
    assert.equal(await preview.evaluate(() => document.getElementById('plot')._context.showSendToCloud), false);
    await preview.screenshot({ path: resolve(directory, `${theme}-export-preview.png`) });
    await preview.close();
    report.themes.push({ ...original, plotlyVersion, offlineHtmlRender: true, pinIdentityPreserved: true, resized: true, pca: true, clustering: true, pngBytes: (await stat(pngPath)).size, htmlBytes: document.length });
    await page.close();
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.externalRequests, []);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error); process.exitCode = 1; }
finally { await browser.close(); await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify(report, null, 2));
