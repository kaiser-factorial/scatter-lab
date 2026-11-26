// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ControlPanelDivider } from '../ControlPanelDivider';

it('offers keyboard resizing with the same endpoints announced to assistive technology', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const resize = vi.fn();
  try {
    await act(() => root.render(<ControlPanelDivider width={320} limit={480} onResize={resize} />));
    const handle = host.querySelector('[role="separator"]')!;
    expect(handle.getAttribute('aria-valuenow')).toBe('320');
    for (const key of ['Home', 'ArrowLeft', 'ArrowRight', 'End', 'Enter']) {
      handle.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    }
    expect(resize.mock.calls.flat()).toEqual([240, 304, 336, 480]);
  } finally {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
