// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EfaBackendControls } from '../EfaBackendControls';
import type { EfaComputeSettings } from '../../lib/efa/backends/types';

let root: Root | undefined;
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
async function mount(value: EfaComputeSettings) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const onChange = vi.fn();
  await act(async () => root!.render(<EfaBackendControls value={value} onChange={onChange} disabled={false} />));
  return { host, onChange };
}

it('offers only browser CPU and WebGPU without companion pairing controls', async () => {
  const { host } = await mount({ backend: 'cpu' });
  expect(Array.from(host.querySelectorAll('input[type="radio"]'), input => input.getAttribute('aria-label')))
    .toEqual(['EFA backend cpu', 'EFA backend webgpu']);
  expect(host.textContent).not.toMatch(/Scala|companion|pairing|JVM/i);
  expect(host.querySelector('input[type="password"]')).toBeNull();
});

it('shows an unsupported saved setting until the user explicitly selects a supported backend', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const { host, onChange } = await mount({ backend: 'scala' } as never);
  expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/no backend has been substituted/);
  expect(host.querySelector('input[type="radio"]:checked')).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
  await act(async () => (host.querySelector('[aria-label="EFA backend cpu"]') as HTMLInputElement).click());
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ backend: 'cpu' }));
  expect(fetch).not.toHaveBeenCalled();
});
