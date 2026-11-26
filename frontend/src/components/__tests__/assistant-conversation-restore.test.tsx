// @vitest-environment happy-dom
import { act, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AssistantPanel, type ConversationBridge } from '../AssistantPanel';
import type { AppBridge } from '../../lib/assistant';
import type { Conversation } from '../../lib/workspaces';

it('queues restores during an uncommitted render and exposes only mounted panel commands', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const convRef: { current: ConversationBridge } = { current: { handle: null } };
  const askRef = { current: null };
  const exitWalkthroughRef = { current: null };
  const bridgeRef = { current: { getState: () => ({ datasets: [] }) } as unknown as AppBridge };
  const pending = new Promise<void>(() => {});
  function DelayCommit({ wait }: { wait: boolean }) {
    if (wait) throw pending;
    return null;
  }
  function renderPanel(wait: boolean) {
    return act(async () => root.render(<StrictMode><Suspense fallback="Loading panel">
      <AssistantPanel bridgeRef={bridgeRef} convRef={convRef} askRef={askRef} exitWalkthroughRef={exitWalkthroughRef}
        theme="primary" dock="right" onDockChange={() => {}} />
      <DelayCommit wait={wait} />
    </Suspense></StrictMode>));
  }
  const saved: Conversation = { entries: [{ kind: 'user', text: 'Recovered question' }], history: [{ role: 'user', content: 'Recovered question' }] };
  try {
    await renderPanel(true);
    expect(host.textContent).toBe('Loading panel');
    expect(convRef.current.handle).toBeNull();
    expect(askRef.current).toBeNull();
    expect(exitWalkthroughRef.current).toBeNull();
    convRef.current.pending = saved;
    await renderPanel(false);
    expect(convRef.current.pending).toBeUndefined();
    expect(convRef.current.handle!.get()).toEqual(saved);
    expect(askRef.current).toEqual(expect.any(Function));
    await act(async () => {
      convRef.current.handle!.set(null);
      expect(convRef.current.handle!.get()).toEqual({ entries: [], history: [] });
    });
    await act(async () => convRef.current.handle!.set(saved));
    await act(async () => root.render(null));
    expect(convRef.current.handle).toBeNull();
    expect(askRef.current).toBeNull();
    expect(exitWalkthroughRef.current).toBeNull();
    expect(convRef.current.pending).toEqual(saved);
    convRef.current.pending = null;
    await renderPanel(false);
    expect(convRef.current.handle!.get()).toEqual({ entries: [], history: [] });
    expect(convRef.current.pending).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
