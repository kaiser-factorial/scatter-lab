// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ConvergenceDialog, type ConvergenceDialogProps } from '../ConvergenceDialog';
import type { ConvergenceIssue } from '../../lib/convergence';

let root: Root | undefined;
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren(); document.body.style.overflow = ''; vi.unstubAllGlobals(); });

const pca: ConvergenceIssue = { method: 'iterative-pca', reason: 'iteration-limit', settings: { maxIterations: 200, tolerance: 1e-8, rank: 2 },
  iterations: 200, objective: .018, criterion: 2e-6, partialAvailable: true };
const fiml: ConvergenceIssue = { method: 'fiml', reason: 'iteration-limit', settings: { maxIterations: 2000, tolerance: 1e-7, starts: 3, uniquenessFloor: 1e-6 },
  iterations: 2000, objective: 5.36, gradient: .00012, bestStart: 2, partialAvailable: false,
  starts: [1, 2, 3].map(start => ({ start, iterations: 2000, objective: 5.36, gradient: .00012, reason: 'iteration-limit' })) };

function button(label: string) {
  const found = [...document.querySelectorAll('button')].find(element => element.textContent === label);
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
function field(label: string) {
  const found = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!found) throw new Error(`Missing input ${label}`);
  return found;
}
async function edit(label: string, value: string) {
  const element = field(label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function render(props: Partial<ConvergenceDialogProps> = {}) {
  if (!root) { const host = document.createElement('div'); document.body.append(host); root = createRoot(host); }
  const full = { issue: pca, theme: 'primary', onRetry: vi.fn(), onKeep: vi.fn(), onDismiss: vi.fn(), ...props };
  await act(async () => root!.render(<ConvergenceDialog {...full} />));
  return full;
}

it('offers an explicit partial-result choice for PCA and preserves the requested tolerance on retry', async () => {
  const props = await render();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('has not been added to the dataset');
  expect(field('Retry iteration limit').valueAsNumber).toBe(1000);
  expect(field('Retry tolerance').valueAsNumber).toBe(1e-8);
  await click(button('Keep unconverged result'));
  expect(props.onKeep).toHaveBeenCalledOnce(); expect(props.onRetry).not.toHaveBeenCalled();
  await edit('Retry iteration limit', '1500'); await edit('Retry imputation rank', '3');
  await click(button('Retry with these settings'));
  expect(props.onRetry).toHaveBeenCalledWith({ maxIterations: 1500, tolerance: 1e-8, rank: 3 });
});

it('offers no partial FIML result and passes explicitly adjusted starts and floor to retry', async () => {
  const props = await render({ issue: fiml });
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('No fitted model was saved');
  expect(document.body.textContent).not.toContain('Keep unconverged result');
  expect(field('Retry iteration limit').valueAsNumber).toBe(4000);
  expect(field('Retry tolerance').valueAsNumber).toBe(1e-7);
  await edit('Retry starting points', '5'); await edit('Retry uniqueness floor', '0.00001');
  await click(button('Retry with these settings'));
  expect(props.onRetry).toHaveBeenCalledWith({ maxIterations: 4000, tolerance: 1e-7, starts: 5, uniquenessFloor: 1e-5 });
  expect(props.onKeep).not.toHaveBeenCalled();
});

it('distinguishes a line-search stop from a capped run and refuses invalid settings', async () => {
  const props = await render({ issue: { ...fiml, reason: 'line-search', iterations: 12 } });
  expect(document.body.textContent).toContain('could not find a further improving step');
  expect(field('Retry iteration limit').valueAsNumber).toBe(2000);
  await edit('Retry tolerance', '0');
  expect(button('Retry with these settings').disabled).toBe(true);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('tolerance');
  await click(button('Retry with these settings')); expect(props.onRetry).not.toHaveBeenCalled();
  await edit('Retry tolerance', '0.0000001'); await edit('Retry iteration limit', '2.5');
  expect(button('Retry with these settings').disabled).toBe(true);
});

it('portals an accessible modal, traps keyboard focus, handles Escape, and restores focus on close', async () => {
  const opener = document.createElement('button'); opener.textContent = 'Run PCA'; document.body.append(opener); opener.focus();
  const props = await render();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Iterative PCA did not converge');
  expect(document.activeElement).toBe(field('Retry iteration limit'));
  expect(document.body.style.overflow).toBe('hidden');
  const close = document.querySelector<HTMLButtonElement>('[aria-label="Close convergence dialog"]')!;
  const last = button('Retry with these settings'); last.focus();
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(close);
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(last);
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(props.onDismiss).toHaveBeenCalledOnce(); expect(props.onRetry).not.toHaveBeenCalled();
  await render({ ...props, issue: null });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(opener); expect(document.body.style.overflow).toBe('');
});

it('retains edited controls through parent renders and resets them only for a new failed attempt', async () => {
  const props = await render();
  await edit('Retry iteration limit', '1800'); field('Retry tolerance').focus();
  await render({ ...props, onDismiss: vi.fn() });
  expect(field('Retry iteration limit').valueAsNumber).toBe(1800);
  expect(document.activeElement).toBe(field('Retry tolerance'));
  await render({ ...props, issue: { ...pca, settings: { ...pca.settings, maxIterations: 1800 }, iterations: 1800, criterion: 1e-7 } });
  expect(field('Retry iteration limit').valueAsNumber).toBe(3600);
  expect(field('Retry tolerance').valueAsNumber).toBe(1e-8);
});

it('does not offer Keep when no finite partial result exists', async () => {
  await render({ issue: { ...pca, reason: 'non-finite', objective: null, partialAvailable: false } });
  expect(document.body.textContent).not.toContain('Keep unconverged result');
  expect(document.body.textContent).toContain('without a finite numerical solution');
});
