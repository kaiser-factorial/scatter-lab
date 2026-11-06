// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AppBridge } from '../../lib/assistant';
import type { DataTable } from '../../lib/table';
import type { DecompositionAdvice } from '../../lib/decomposition-advice';
import type { ConvergenceIssue } from '../../lib/convergence';
import type { EfaSpec } from '../../lib/efa/types';

const captured = vi.hoisted(() => ({ bridgeRef: undefined as { current: AppBridge } | undefined, controller: undefined as EfaController | undefined }));
// Keep Home, shared setup, category editor, and aggregate projection real. Only
// the worker boundary is deferred so policy changes can occur during analysis.
vi.mock('next/dynamic', () => ({ default: (load: () => unknown) => {
  if (String(load).includes('AssistantPanel')) return function AssistantCapture(props: { bridgeRef: { current: AppBridge } }) {
    captured.bridgeRef = props.bridgeRef; return null;
  };
  if (String(load).includes('EfaPanel')) return function EfaControls(props: ComponentProps<typeof EfaPanel>) {
    return <EfaPanel {...props} />;
  };
  return () => null;
} }));
vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'primary', setTheme: vi.fn() }) }));
vi.mock('ccru/components', () => ({ CyberStackGroup: () => null, CyberContainer: () => null, CyberPanel: () => null }));
vi.mock('puxel', () => ({
  Accordion: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AccordionItem: ({ children }: { children: ReactNode }) => <div>{children}</div>, Separator: () => null,
}));
vi.mock('../../lib/assistant', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/assistant')>(), paintYield: async () => {},
}));
vi.mock('../../lib/parse', () => ({ readTable: vi.fn(), listSheets: vi.fn(async () => []) }));
vi.mock('../../lib/workspaces', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/workspaces')>(),
  loadSession: vi.fn(async () => null), listWorkspaces: vi.fn(async () => []),
  saveSession: vi.fn(async () => {}), saveWorkspace: vi.fn(async () => {}),
}));
vi.mock('../../lib/decomposition-advice-service', () => ({ analyzeItemsAsync: vi.fn() }));
vi.mock('../../lib/efa/controller', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/efa/controller')>();
  return { ...actual, EfaController: class CaptureController extends actual.EfaController {
    constructor(...args: ConstructorParameters<typeof actual.EfaController>) { super(...args); captured.controller = this; }
  } };
});

import Home from '../../app/page';
import { EfaPanel } from '../EfaPanel';
import { readTable } from '../../lib/parse';
import { analyzeItemsAsync } from '../../lib/decomposition-advice-service';
import { analyzeDecompositionItems, adviceForAssistant } from '../../lib/decomposition-advice';
import { EfaController } from '../../lib/efa/controller';

const table: DataTable = {
  columns: ['A', 'B', 'C'], nRows: 24,
  data: {
    A: Array.from({ length: 24 }, (_, i) => i === 1 ? null : i % 4 + 1),
    B: Array.from({ length: 24 }, (_, i) => Math.floor(i / 2) % 4 + 1),
    C: Array.from({ length: 24 }, (_, i) => (i * 3 + Math.floor(i / 4)) % 4 + 1),
  },
};
type Snapshot = { activeId: number; datasets: { id: number; table: DataTable; dataMode: 'open' | 'private' }[] };
let root: Root | undefined;
const bridge = () => captured.bridgeRef!.current;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key), clear: () => stored.clear(),
  });
  captured.bridgeRef = undefined;
  captured.controller = undefined;
  vi.mocked(readTable).mockResolvedValue({ table: structuredClone(table), warnings: [] });
  vi.mocked(analyzeItemsAsync).mockReset().mockImplementation(async (source, columns, options) => analyzeDecompositionItems(source, columns, options));
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren();
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
async function click(text: string) {
  const element = Array.from(document.querySelectorAll('button')).find(button => button.textContent?.trim() === text);
  if (!element) throw new Error(`Missing button: ${text}`);
  await act(async () => element.click());
}
async function choice(text: string) {
  const element = Array.from(document.querySelectorAll('label')).find(label => label.textContent?.includes(text))?.querySelector('input');
  if (!element) throw new Error(`Missing choice: ${text}`);
  await act(async () => element.click());
}
async function input(label: string, value: string) {
  const element = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function upload(open = false) {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<Home />));
  const file = document.querySelector<HTMLInputElement>('[data-guide="upload-dropzone"] input[type="file"]')!;
  Object.defineProperty(file, 'files', { configurable: true, value: [new File(['fixture'], 'responses.csv', { type: 'text/csv' })] });
  await act(async () => file.dispatchEvent(new Event('change', { bubbles: true })));
  if (open) { await choice('Public / open data'); await choice('I confirm this dataset contains no personal'); }
  await choice('Skip — my data has none'); await choice('No — use the full dataset'); await click('Add dataset');
  expect(captured.bridgeRef).toBeDefined();
}

it('rejects late open-policy advice when only the disclosure policy changes, then applies the private floor to a fresh request', async () => {
  await upload(true);
  expect(bridge().getState().datasets[0].dataMode).toBe('open');
  let resolve!: (report: DecompositionAdvice) => void;
  vi.mocked(analyzeItemsAsync).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const pending = bridge().analyzeDecomposition!({});
  const [source, columns, options] = vi.mocked(analyzeItemsAsync).mock.calls[0];
  expect(options).toMatchObject({ minimumPairN: 0 });
  const report = analyzeDecompositionItems(source, columns, options);
  expect(adviceForAssistant(report, 0).items[0].missing).toBe(1);

  // Dataset modes are immutable in the upload UI. Restore is the real host
  // state transition; preserving table/id/filter isolates the policy guard.
  const before = bridge().snapshot() as Snapshot;
  await act(async () => bridge().restore({ ...before, datasets: before.datasets.map(dataset => ({ ...dataset, dataMode: 'private' })) }));
  const after = bridge().snapshot() as Snapshot;
  expect(after.activeId).toBe(before.activeId);
  expect(after.datasets[0].table).toBe(before.datasets[0].table);
  expect(bridge().getState().rowFilter).toBeNull();
  expect(bridge().getState().datasets[0].dataMode).toBe('private');
  let late!: string;
  await act(async () => { resolve(report); late = await pending; });
  expect(JSON.parse(late)).toEqual({ error: 'The fitting dataset, filter or access policy changed. Analyze the current items again.' });

  const fresh = JSON.parse(await bridge().analyzeDecomposition!({}));
  expect(vi.mocked(analyzeItemsAsync).mock.calls[1][2]).toMatchObject({ minimumPairN: 5 });
  expect(fresh.items[0]).toMatchObject({ column: 'A', observed: 'withheld', missing: 'withheld' });
  expect(fresh.sample.missingCells).toBe('withheld');
});

it('defaults assistant advice to the current UI selection, measurement settings, and edited category order without returning category labels', async () => {
  const categories = ['quiet', 'moderate', 'strong'];
  vi.mocked(readTable).mockResolvedValue({ table: { ...table, columns: [...table.columns, 'Rating'], data: { ...table.data, Rating: Array.from({ length: 24 }, (_, i) => categories[i % 3]) } }, warnings: [] });
  await upload();
  await click('EFA');
  const checkbox = document.querySelector<HTMLInputElement>('input[aria-label="Select Rating"]')!;
  await act(async () => checkbox.click());
  const measurement = document.querySelector<HTMLSelectElement>('select[aria-label="Item type Rating"]')!;
  await act(async () => { measurement.value = 'ordinal'; measurement.dispatchEvent(new Event('change', { bubbles: true })); });
  await input('Category order Rating', JSON.stringify(categories));
  const response = await bridge().analyzeDecomposition!({});
  const [, columns, options] = vi.mocked(analyzeItemsAsync).mock.calls.at(-1)!;
  expect(columns).toEqual(['A', 'B', 'C', 'Rating']);
  expect(options).toMatchObject({ method: 'efa', measurements: { Rating: 'ordinal' }, orders: { Rating: categories }, missing: 'median', minimumPairN: 5 });
  expect(JSON.parse(response).items.find((item: { column: string }) => item.column === 'Rating')).toMatchObject({ classification: 'ordinal', confirmed: true });
  for (const category of categories) {
    expect(response).not.toContain(`"${category}"`);
    expect(JSON.stringify(bridge().getState().analysisSetup)).not.toContain(`"${category}"`);
  }
  const override = { Rating: categories.slice().reverse() };
  await bridge().analyzeDecomposition!({ orders: override });
  expect(vi.mocked(analyzeItemsAsync).mock.calls.at(-1)![2]?.orders).toEqual(override);
});

const retrySpec: EfaSpec = {
  items: ['C', 'A', 'B'].map(column => ({ column, categories: [], reverse: false, measurement: 'continuous' })),
  correlation: 'pearson', extraction: 'ml', missing: 'fiml', nFactors: 1, rotation: 'promax', seed: 41,
  label: 'captured retry', sample: { partition: 'all', fixedRows: Array.from({ length: 12 }, (_, i) => i * 2) },
  likelihood: { maxIterations: 10, tolerance: 1e-10, starts: 2, uniquenessFloor: 1e-5 },
};

it.each(['run_efa', 'impute_efa'])('preserves a plain-text %s controller rejection and keeps the shared run settings', async action => {
  await upload();
  await input('Run label', 'current settings');
  const message = 'EFA action failed (likelihood-method). Review the local EFA panel for details.';
  const tool = vi.spyOn(captured.controller!, 'tool').mockResolvedValueOnce(message);
  let response!: string;
  await act(async () => { response = await bridge().efa!(action, { spec: retrySpec }); });
  expect(response).toBe(message);
  expect(tool).toHaveBeenCalledWith(action, { spec: retrySpec });
  expect(document.querySelector<HTMLInputElement>('input[aria-label="Run label"]')!.value).toBe('current settings');
  expect(document.querySelector<HTMLSelectElement>('select[aria-label="Missing values"]')!.value).toBe('median');
  expect(bridge().getState().efaRuns).toEqual([]);
});

it('captures accepted EFA retry metadata before dispatch consumes it and synchronizes shared and likelihood controls', async () => {
  vi.mocked(readTable).mockResolvedValue({ table: { ...table, columns: [...table.columns, 'D'], data: { ...table.data, D: table.data.B.slice() } }, warnings: [] });
  await upload();
  const issue: ConvergenceIssue = {
    method: 'fiml', reason: 'iteration-limit', settings: { ...retrySpec.likelihood! } as ConvergenceIssue['settings'],
    iterations: 10, objective: 4.7, gradient: .002, partialAvailable: false,
  };
  let saved: ReturnType<EfaController['convergenceRetry']> = { spec: retrySpec, issue, assistantSafe: true };
  const recovery = vi.spyOn(captured.controller!, 'convergenceRetry').mockImplementation(() => saved);
  const response = JSON.stringify({ jobId: 'accepted-retry', status: 'running' });
  const tool = vi.spyOn(captured.controller!, 'tool').mockImplementation(async () => { saved = undefined; return response; });
  const settings = { maxIterations: 1000, tolerance: 1e-8, starts: 4, uniquenessFloor: 1e-6 };
  let actual!: string;
  await act(async () => { actual = await bridge().efa!('retry_efa', { jobId: 'failed-original', settings }); });
  expect(actual).toBe(response);
  expect(recovery).toHaveBeenCalledWith('failed-original');
  expect(recovery.mock.invocationCallOrder[0]).toBeLessThan(tool.mock.invocationCallOrder[0]);
  expect(tool).toHaveBeenCalledWith('retry_efa', { jobId: 'failed-original', settings });
  expect(document.querySelector<HTMLInputElement>('input[aria-label="Run label"]')!.value).toBe('captured retry');
  expect(document.querySelector<HTMLInputElement>('input[aria-label="Select D"]')!.checked).toBe(false);
  expect(bridge().getState().analysisSetup).toEqual({
    method: 'efa', variables: ['C', 'A', 'B'], missing: 'fiml', measurements: { C: 'continuous', A: 'continuous', B: 'continuous' },
  });
  for (const [label, value] of [['ML maximum iterations', 1000], ['ML tolerance', 1e-8], ['ML starts', 4], ['ML uniqueness floor', 1e-6]] as const)
    expect(Number(document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!.value)).toBe(value);
  expect(bridge().getState().efaRuns).toEqual([]);
  const advice = JSON.parse(await bridge().analyzeDecomposition!({}));
  const [fittingTable, columns, options] = vi.mocked(analyzeItemsAsync).mock.calls.at(-1)!;
  expect(fittingTable.nRows).toBe(12);
  for (const column of table.columns)
    expect(fittingTable.data[column]).toEqual(retrySpec.sample.fixedRows!.map(row => table.data[column][row]));
  expect(columns).toEqual(['C', 'A', 'B']);
  expect(options).toMatchObject({ method: 'efa', missing: 'fiml', minimumPairN: 5 });
  expect(advice.sample.rows).toBe(12);
  expect(advice.sample.missingCells).toBe(0); // The only missing value belongs to excluded row 1.
  expect((bridge().snapshot() as Snapshot).datasets[0].table.nRows).toBe(24);
});

it('rejects pending advice when the saved EFA fitting rows change without changing the dataset or row filter', async () => {
  await upload();
  vi.spyOn(captured.controller!, 'tool').mockResolvedValue(JSON.stringify({ jobId: 'accepted-fit', status: 'running' }));
  await act(async () => { await bridge().efa!('run_efa', { spec: retrySpec }); });
  let resolve!: (report: DecompositionAdvice) => void;
  vi.mocked(analyzeItemsAsync).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const pending = bridge().analyzeDecomposition!({});
  const [source, columns, options] = vi.mocked(analyzeItemsAsync).mock.calls.at(-1)!;
  expect(source.nRows).toBe(12);
  expect(source.data.A).not.toContain(null);
  const before = bridge().snapshot() as Snapshot;
  const oddRows = Array.from({ length: 12 }, (_, i) => i * 2 + 1);
  const nextSpec = { ...retrySpec, sample: { partition: 'all' as const, fixedRows: oddRows } };
  await act(async () => { await bridge().efa!('run_efa', { spec: nextSpec }); });
  const after = bridge().snapshot() as Snapshot;
  expect(after.activeId).toBe(before.activeId);
  expect(after.datasets[0].table).toBe(before.datasets[0].table);
  expect(bridge().getState().rowFilter).toBeNull();
  let late!: string;
  await act(async () => { resolve(analyzeDecompositionItems(source, columns, options)); late = await pending; });
  expect(JSON.parse(late)).toEqual({ error: 'The fitting dataset, filter or access policy changed. Analyze the current items again.' });
  await bridge().analyzeDecomposition!({});
  const [current] = vi.mocked(analyzeItemsAsync).mock.calls.at(-1)!;
  expect(current.nRows).toBe(12);
  for (const column of table.columns) expect(current.data[column]).toEqual(oddRows.map(row => table.data[column][row]));
  expect(current.data.A).toContain(null);
});
