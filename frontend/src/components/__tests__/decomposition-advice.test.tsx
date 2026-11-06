// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DecompositionAdvice } from '../DecompositionAdvice';
import { analyzeDecompositionItems, type DecompositionAdvice as Report } from '@/lib/decomposition-advice';
import { analyzeItemsAsync } from '@/lib/decomposition-advice-service';
vi.mock('@/lib/decomposition-advice-service', () => ({ analyzeItemsAsync: vi.fn() }));

const table = { columns: ['A', 'B', 'C', 'D'], nRows: 40, data: Object.fromEntries(['A', 'B', 'C', 'D'].map((c, j) => [c, Array.from({ length: 40 }, (_, i) => i % (j + 2))])) };
const columns = ['A', 'B', 'C'], options = { method: 'efa' as const, minimumPairN: 5 };
const report = analyzeDecompositionItems(table, columns, options);
let root: Root | undefined;
const onApply = vi.fn();
type Pending = { resolve: (report: Report) => void; reject: (error: Error) => void; signal?: AbortSignal };
let calls: Pending[];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); calls = []; onApply.mockReset();
  vi.mocked(analyzeItemsAsync).mockReset().mockImplementation((_table, _columns, _options, signal) => new Promise((resolve, reject) => calls.push({ resolve, reject, signal })));
});
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren(); vi.unstubAllGlobals(); });
const button = (text: string) => {
  const result = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === text);
  if (!result) throw new Error(`Missing button ${text}`); return result;
};
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function render(overrides: Partial<Parameters<typeof DecompositionAdvice>[0]> = {}) {
  if (!root) { const host = document.createElement('div'); document.body.append(host); root = createRoot(host); }
  await act(async () => root!.render(<DecompositionAdvice table={table} columns={columns} options={options} contextKey="filter-a" onApply={onApply} {...overrides} />));
}
async function finish(index = 0, value = report) { await act(async () => calls[index].resolve(value)); }

it('shows the primary candidate and its assumptions, and Apply only publishes a settings patch', async () => {
  await render(); expect(analyzeItemsAsync).not.toHaveBeenCalled();
  await click(button('Analyze selected items')); await finish();
  const primary = [...document.querySelectorAll('details')].find(details => details.querySelector('summary')?.textContent === 'Polychoric correlations + MINRES')!;
  expect(primary.open).toBe(true); expect(primary.textContent).toContain('Confirm that the categories are ordered responses');
  expect(onApply).not.toHaveBeenCalled(); await click(primary.querySelector('button')!);
  expect(onApply).toHaveBeenCalledExactlyOnceWith({ correlation: 'polychoric', extraction: 'minres' });
  expect(analyzeItemsAsync).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Review the setup before running');
});
it.each(['table', 'selection', 'filter', 'method'] as const)('invalidates completed advice when %s changes', async kind => {
  await render(); await click(button('Analyze selected items')); await finish();
  const overrides = kind === 'table' ? { table: structuredClone(table) } : kind === 'selection' ? { columns: ['A', 'B', 'D'] }
    : kind === 'filter' ? { contextKey: 'filter-b' } : { options: { ...options, method: 'pca' as const } };
  await render(overrides);
  expect(document.body.textContent).toContain('Analyze again for current guidance');
  expect([...document.querySelectorAll('button')].some(button => button.textContent === 'Apply these settings')).toBe(false);
  expect(onApply).not.toHaveBeenCalled();
});
it('aborts changed pending inputs and ignores the old worker result', async () => {
  await render(); await click(button('Analyze selected items'));
  await render({ columns: ['A', 'B', 'D'] }); expect(calls[0].signal?.aborted).toBe(true);
  await finish(); expect(document.querySelector('[aria-live="polite"]')).toBeNull();
  await click(button('Analyze selected items'));
  await finish(1, analyzeDecompositionItems(table, ['A', 'B', 'D'], options));
  expect(document.querySelector('[aria-live="polite"]')).not.toBeNull(); expect(onApply).not.toHaveBeenCalled();
});
it('cancel aborts the request, permits a new request and ignores cancellation errors', async () => {
  await render(); await click(button('Analyze selected items')); await click(button('Cancel'));
  expect(calls[0].signal?.aborted).toBe(true);
  await act(async () => calls[0].reject(new DOMException('Cancelled', 'AbortError')));
  expect(document.body.textContent).not.toContain('Cancelled'); expect(button('Analyze selected items').disabled).toBe(false);
  await click(button('Analyze selected items')); await finish(1);
  expect(document.body.textContent).toContain('Polychoric correlations + MINRES');
});
it('offers no Apply action for blocked item sets', async () => {
  const blockedTable = { ...table, data: { ...table.data, A: Array(40).fill(1) } };
  await render({ table: blockedTable }); await click(button('Analyze selected items'));
  await finish(0, analyzeDecompositionItems(blockedTable, columns, options));
  expect(document.body.textContent).toContain('Only one distinct observed value');
  expect([...document.querySelectorAll('button')].some(button => button.textContent === 'Apply these settings')).toBe(false);
});
