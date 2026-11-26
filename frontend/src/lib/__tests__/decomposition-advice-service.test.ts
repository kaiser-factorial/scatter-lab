import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { Worker as NodeWorker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { analyzeItemsAsync } from '../decomposition-advice-service';
import { analyzeDecompositionItems } from '../decomposition-advice';

const directory = mkdtempSync(join(tmpdir(), 'decomposition-advice-worker-'));
const entry = join(directory, 'worker.mjs');
const table = { columns: ['A', 'B', 'C', 'private'], nRows: 60, data: {
  A: Array.from({ length: 60 }, (_, i) => i % 5), B: Array.from({ length: 60 }, (_, i) => i % 4),
  C: Array.from({ length: 60 }, (_, i) => i % 3), private: Array(60).fill('UNSELECTED_ROW_CANARY'),
} };
const columns = ['A', 'B', 'C'];
let active = 0;
let dispatched: unknown;
class LocalWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  private worker: NodeWorker;
  private stopped = false;
  constructor() {
    active++; this.worker = new NodeWorker(entry);
    this.worker.on('message', data => this.onmessage?.({ data }));
    this.worker.on('error', () => this.onerror?.());
  }
  postMessage(value: unknown) { dispatched = value; this.worker.postMessage(value); }
  terminate() { if (!this.stopped) { this.stopped = true; active--; void this.worker.terminate(); } }
}
beforeAll(async () => {
  await build({ stdin: { contents: `import { parentPort } from 'node:worker_threads';
    globalThis.self = { postMessage: value => parentPort.postMessage(value) };
    await import(${JSON.stringify(resolve('src/lib/decomposition-advice.worker.ts'))});
    parentPort.on('message', data => self.onmessage({ data }));`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', outfile: entry });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it('runs the production worker and transports only selected columns, with exact serial report agreement', async () => {
  vi.stubGlobal('Worker', LocalWorker);
  const result = await analyzeItemsAsync(table, columns, { minimumPairN: 5 });
  expect(result).toEqual(analyzeDecompositionItems(table, columns, { minimumPairN: 5 }));
  expect(JSON.stringify(dispatched)).not.toContain('UNSELECTED_ROW_CANARY');
  expect(JSON.stringify(result)).not.toContain('UNSELECTED_ROW_CANARY'); expect(active).toBe(0);
});
it('terminates a real worker on abort without returning late advice', async () => {
  vi.stubGlobal('Worker', LocalWorker);
  const controller = new AbortController(), pending = analyzeItemsAsync(table, columns, {}, controller.signal);
  expect(active).toBe(1); controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); expect(active).toBe(0);
});
it('returns fixed worker error text without forwarding source values or arbitrary exception details', async () => {
  vi.stubGlobal('Worker', LocalWorker);
  const response = analyzeItemsAsync(table, ['UNSELECTED_ROW_CANARY'], {});
  await expect(response).rejects.toThrow('The selected items could not be assessed. Check the item types and declared category orders.');
  expect(active).toBe(0);
});
it('honors abort before starting and during the fallback microtask', async () => {
  vi.stubGlobal('Worker', undefined);
  const before = new AbortController(); before.abort();
  await expect(analyzeItemsAsync(table, columns, {}, before.signal)).rejects.toMatchObject({ name: 'AbortError' });
  const during = new AbortController(), pending = analyzeItemsAsync(table, columns, {}, during.signal); during.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});
