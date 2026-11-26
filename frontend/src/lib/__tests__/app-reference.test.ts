import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAppReferenceReader, type ReferenceManifest } from '../app-reference';
import { APP_REFERENCE_MANIFEST } from '../generated/app-reference-manifest';
import { buildSystemPrompt, MUTATING_TOOLS, runAssistantTurn, toolsFor, type AppBridge } from '../assistant';
import { policyFor } from '../dataPolicy';
import { call, replayTransport, say } from '../replay';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const examplePath = 'packages/statistics/src/pca.ts';
const fixture = (source = Array.from({ length: 260 }, (_, i) => i === 179 ? 'export function fitPca() { return "training scaling"; }' : `// source line ${i + 1}`).join('\n')) => {
  const body = JSON.stringify({ format: 'scatterlab-app-reference/1', files: [
    { path: examplePath, kind: 'source', sha256: sha(source), text: source },
    { path: 'packages/statistics/PCA.md', kind: 'documentation', sha256: sha('PCA coefficient vectors are unit eigenvectors.'), text: 'PCA coefficient vectors are unit eigenvectors.' },
  ] });
  const snapshot = sha(body);
  const manifest: ReferenceManifest = { format: 'scatterlab-app-reference/1', snapshot, assetPath: `/assistant-reference/${snapshot}.json`, fileCount: 2, bytes: Buffer.byteLength(body) };
  const fetcher = vi.fn(async () => new Response(body));
  return { body, manifest, fetcher, reader: createAppReferenceReader(manifest, fetcher) };
};
const bridge = { getState: () => ({ datasets: [{ name: 'private-data', nRows: 30, active: true, dataMode: 'private' }], columns: [],
  axes: { x: '', y: '', z: null }, colorBy: '', shapeBy: '', viewMode: '2D', pinnedViews: 0, rowFilter: null,
  clusterSettings: { method: 'NONE', eps: .5, minSamples: 5, k: 3, standardize: true },
  clusterBreakdown: { attribute: '', direction: 'cluster', palette: 'PrimaryBlue' }, pcaRuns: [] }) } as unknown as AppBridge;

afterEach(() => vi.unstubAllGlobals());

describe('build-bound source inspection', () => {
  it('searches actual text, reads surrounding numbered lines, and reuses one verified local asset', async () => {
    const { reader, fetcher, manifest } = fixture();
    const hits = JSON.parse(await reader.search({ query: 'fitPca', kind: 'source' }));
    expect(hits.results[0]).toMatchObject({ path: examplePath, line: 180 });
    const excerpt = JSON.parse(await reader.read({ path: hits.results[0].path, startLine: 175, lineCount: 12 }));
    expect(excerpt).toMatchObject({ startLine: 175, endLine: 186, nextStartLine: 187, snapshot: manifest.snapshot });
    expect(excerpt.text).toContain('180: export function fitPca()');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(manifest.assetPath, expect.objectContaining({ redirect: 'error', credentials: 'same-origin' }));
  });

  it('lists and paginates published files without interpreting user paths or URLs', async () => {
    const { reader, fetcher } = fixture();
    const first = JSON.parse(await reader.search({ query: '', limit: 1 }));
    const second = JSON.parse(await reader.search({ offset: first.nextOffset, limit: 1 }));
    expect(first.totalMatches).toBe(2);
    expect(first.results[0].path).not.toBe(second.results[0].path);
    expect(second.nextOffset).toBeNull();
    expect(JSON.parse(await reader.search({ query: 'nonexistentSymbol_zzq' })).results).toEqual([]);
    for (const path of ['../../.env', '/etc/passwd', 'https://example.com/secret', 'packages/statistics/src/%2e%2e/.env']) {
      await expect(reader.read({ path })).rejects.toThrow('exact relative');
    }
    await expect(reader.read({ path: 'frontend/.env.local' })).rejects.toThrow('exact relative');
    await expect(reader.read({ path: 'frontend/private.csv' })).rejects.toThrow('not included');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed arguments before fetching and enforces line/output budgets', async () => {
    const { reader, fetcher } = fixture();
    for (const args of [null, [], { query: {} }, { query: 'a'.repeat(241) }, { limit: 1000 }, { kind: 'everything' }])
      await expect(reader.search(args)).rejects.toThrow();
    for (const args of [{ path: examplePath, startLine: -1 }, { path: examplePath, startLine: 1.5 }, { path: examplePath, lineCount: 121 }])
      await expect(reader.read(args)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    const long = fixture(Array.from({ length: 120 }, () => 'a'.repeat(1000)).join('\n'));
    const excerpt = JSON.parse(await long.reader.read({ path: examplePath, lineCount: 120 }));
    expect(excerpt.truncated).toBe(true);
    expect(excerpt.text.length).toBeLessThanOrEqual(16_000);
    expect(excerpt.nextStartLine).toBe(excerpt.endLine + 1);
  });

  it('refuses mismatched, incomplete and oversized assets, then permits a successful retry', async () => {
    const { body, manifest } = fixture();
    for (const wrong of [body.replace('fitPca', 'fitBAD'), body.slice(0, -1), body + ' ']) {
      const fetcher = vi.fn().mockResolvedValueOnce(new Response(wrong)).mockResolvedValueOnce(new Response(body));
      const reader = createAppReferenceReader(manifest, fetcher);
      await expect(reader.search({})).rejects.toThrow(/match|incomplete|size/);
      expect(JSON.parse(await reader.search({})).totalMatches).toBe(2);
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });

  it('cannot fetch an external manifest URL and reports unavailable snapshots honestly', async () => {
    const { manifest, fetcher } = fixture();
    await expect(createAppReferenceReader({ ...manifest, assetPath: 'https://example.com/corpus.json' }, fetcher).search({})).rejects.toThrow('manifest');
    expect(fetcher).not.toHaveBeenCalled();
    await expect(createAppReferenceReader(manifest, async () => new Response('', { status: 404 })).search({})).rejects.toThrow('unavailable');
  });
});

describe('assistant app reference integration', () => {
  it('finds methodological terms without substring noise from unrelated long files', async () => {
    const asset = readFileSync(resolve(process.cwd(), 'public' + APP_REFERENCE_MANIFEST.assetPath), 'utf8');
    const reader = createAppReferenceReader(APP_REFERENCE_MANIFEST, async () => new Response(asset));
    const weighted = JSON.parse(await reader.search({ query: 'WLSMV standard errors' }));
    expect(weighted.results[0].path).not.toContain('/pca.ts');
    expect(weighted.results[0].excerpt.toLowerCase()).toContain('wlsmv');
    const ties = JSON.parse(await reader.search({ query: 'Chatterjee ties' }));
    expect(ties.results[0].path).not.toContain('/efa/');
    expect(ties.results[0].excerpt.toLowerCase()).toContain('chatterjee');
  });

  it('injects app guidance before the model chooses any tool and retains private data boundaries', () => {
    const prompt = buildSystemPrompt(bridge, 'Does MICE provide pooled standard errors?');
    expect(prompt).toContain('not Rubin-pooled');
    expect(prompt).toContain('read_app_source');
    expect(prompt).toContain('never see raw data rows');
    for (const mode of ['private', 'open'] as const) {
      const names = toolsFor(policyFor(mode)).map(t => t.type === 'function' ? t.function.name : '');
      expect(names).toContain('search_app_reference'); expect(names).toContain('read_app_source');
    }
    expect(MUTATING_TOOLS.has('search_app_reference')).toBe(false);
    expect(MUTATING_TOOLS.has('read_app_source')).toBe(false);
  });

  it('replays search and source reading through the real dispatcher against the generated package snapshot', async () => {
    const asset = readFileSync(resolve(process.cwd(), 'public' + APP_REFERENCE_MANIFEST.assetPath), 'utf8');
    const fetcher = vi.fn(async (url: string) => {
      expect(url).toBe(APP_REFERENCE_MANIFEST.assetPath);
      return new Response(asset);
    });
    vi.stubGlobal('fetch', fetcher);
    const transport = replayTransport([
      ctx => { expect(ctx.system).toContain('guide is injected automatically'); return call('search_app_reference', { query: 'fitPca', kind: 'source' }); },
      ctx => {
        const found = JSON.parse(ctx.lastObservation!);
        expect(found.snapshot).toBe(APP_REFERENCE_MANIFEST.snapshot);
        expect(found.results.some((r: { path: string }) => r.path.startsWith('packages/statistics/src/'))).toBe(true);
        return call('read_app_source', { path: examplePath, startLine: 1, lineCount: 30 });
      },
      ctx => { expect(JSON.parse(ctx.lastObservation!)).toMatchObject({ path: examplePath, startLine: 1, endLine: 30 }); return call('read_app_source', { path: '../../private.csv' }); },
      ctx => { expect(ctx.lastObservation).toContain('Tool error:'); return say('The source evidence is available.'); },
    ]);
    const history = await runAssistantTurn('', '', 'replay', [], 'How does fitPca work?', { current: bridge }, { onText() {}, onToolUse() {} }, transport);
    expect(history.filter(message => message.role === 'tool')).toHaveLength(3);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
