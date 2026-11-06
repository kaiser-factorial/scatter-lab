import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { Worker as NodeWorker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runPcaImputations } from '../pca-imputation';
import { mulberry32 } from '../random';
import type { DataTable } from '../table';

const directory = mkdtempSync(join(tmpdir(), 'pca-mice-worker-')), entry = join(directory, 'worker.mjs');
beforeAll(async () => {
  await build({ stdin: { contents: `import { parentPort } from 'node:worker_threads';
    globalThis.self = { postMessage: value => parentPort.postMessage(value) };
    await import(${JSON.stringify(resolve('src/lib/pca-imputation.worker.ts'))});
    parentPort.on('message', data => self.onmessage({ data }));`, resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'esm', outfile: entry });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const table = (): DataTable => {
  const random = mulberry32(73021), columns = ['a', 'b'];
  return { columns, nRows: 160, data: Object.fromEntries(columns.map((c, j) => [c,
    Array.from({ length: 160 }, (_, i) => (i + j) % 11 === 0 ? null : Math.floor(random() * 3) + 1),
  ])) };
};
function installWorkers() {
  let active = 0;
  class BrowserWorker {
    private worker = new NodeWorker(entry);
    private ended = false;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    constructor() {
      active++;
      this.worker.on('message', data => this.onmessage?.({ data }));
      this.worker.on('error', error => this.onerror?.({ message: error.message }));
    }
    postMessage(value: unknown) { this.worker.postMessage(value); }
    terminate() { if (!this.ended) { this.ended = true; active--; void this.worker.terminate(); } }
  }
  vi.stubGlobal('Worker', BrowserWorker);
  return () => active;
}
it('production PCA workers agree with serial separate fits and reconstruct only score columns', async () => {
  const t = table(), options = { k: 2, label: 'worker', imputations: 2, iterations: 2, seed: 491 };
  const serial = await runPcaImputations(t, t.columns, options);
  const active = installWorkers();
  const parallel = await runPcaImputations(t, t.columns, options);
  expect(parallel.provenance.execution).toBe('web-worker');
  expect(parallel.completed).toEqual(serial.completed);
  expect(parallel.failures).toEqual(serial.failures);
  expect(parallel.trace).toEqual(serial.trace);
  expect(parallel.completed).toHaveLength(2);
  expect(parallel.completed[0].result.table.data.a).toBe(t.data.a);
  expect(active()).toBe(0);
});
it('terminates the worker when cancellation occurs during a chain', async () => {
  const active = installWorkers(), control = new AbortController(), t = table();
  await expect(runPcaImputations(t, t.columns, { imputations: 20, iterations: 10, signal: control.signal,
    onProgress: () => control.abort(),
  })).rejects.toMatchObject({ name: 'AbortError' });
  expect(active()).toBe(0);
});
