import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

// Start/reuse the app with `dev start frontend --detach --json --yes` first.
// Replay the real dispatcher with a scripted model: no API key or paid model
// request, and no dataset loading or analysis mutation is needed.
const base = new URL(process.argv[2] ?? 'http://localhost:3000');
if (!['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('Browser qualification is limited to a local app.');
const compiled = await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
  import { runAssistantTurn } from './src/lib/assistant';
  import { call, replayTransport, say } from './src/lib/replay';
  window.checkAppReference = async () => {
    let search, source, rejected, guide;
    const transport = replayTransport([
      ctx => { guide = ctx.system; return call('search_app_reference', { query: 'fitPca', kind: 'source' }); },
      ctx => { search = JSON.parse(ctx.lastObservation); return call('read_app_source', { path: 'packages/statistics/src/pca.ts', startLine: 1, lineCount: 35 }); },
      ctx => { source = JSON.parse(ctx.lastObservation); return call('read_app_source', { path: '../../.env.local' }); },
      ctx => { rejected = ctx.lastObservation; return say('Reference inspection complete.'); },
    ]);
    await runAssistantTurn('', '', 'scripted-browser-check', [], 'How does fitPca handle missing values?',
      window.__scatterlabBridge, { onText() {}, onToolUse() {} }, transport);
    return { search, source, rejected, autoGuide: guide.includes('Application reference selected automatically'),
      privateMode: guide.includes('never see raw data rows'), secureContext: window.isSecureContext };
  };
` }, bundle: true, format: 'iife', write: false });
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const page = await browser.newPage();
  const referenceRequests = [], externalRequests = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== base.origin) { externalRequests.push(url.origin); return route.abort(); }
    if (url.pathname.startsWith('/assistant-reference/')) referenceRequests.push(url.pathname);
    return route.continue();
  });
  await page.goto(base.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__scatterlabBridge?.current, {}, { timeout: 45_000 });
  assert.equal(referenceRequests.length, 0, 'The source corpus should not load with the initial page.');
  await page.addScriptTag({ content: compiled.outputFiles[0].text });
  const result = await page.evaluate(() => window.checkAppReference());
  assert.equal(result.search.status, 'ok');
  assert.ok(result.search.results.length > 0);
  assert.equal(result.source.path, 'packages/statistics/src/pca.ts');
  assert.equal(result.source.endLine, 35);
  assert.ok(result.source.text.startsWith('1: '));
  assert.ok(result.rejected.startsWith('Tool error:'));
  assert.equal(result.autoGuide, true);
  assert.equal(result.privateMode, true);
  assert.equal(result.secureContext, true);
  assert.equal(referenceRequests.length, 1, 'Search and read should reuse one verified source snapshot.');
  assert.deepEqual(externalRequests, [], 'Reference qualification should make no third-party requests.');
  assert.deepEqual(errors, [], 'The real app should have no browser errors during inspection.');
  console.log(JSON.stringify({ status: 'passed', snapshot: result.source.snapshot, source: result.source.path,
    automaticGuide: result.autoGuide, privateMode: result.privateMode, referenceRequests: referenceRequests.length,
    externalRequests: externalRequests.length, browserErrors: errors.length,
    scope: 'Real browser, app bridge, dispatcher and local HTTP source asset; scripted model, no live-model answer-quality claim.' }, null, 2));
} finally { await browser.close(); }
