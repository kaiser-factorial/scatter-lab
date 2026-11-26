// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AnalysisRecordExport } from '../AnalysisRecordExport';

it('requires explicit disclosure and review, downloads the preview bytes, and resets on reopen', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const download = vi.fn();
  const prepare = vi.fn(async (exact: boolean) => [{ name:'analysis.jsonl',text:exact ? 'exact snapshot' : 'masked snapshot',mime:'application/x-ndjson' }]);
  try {
    await act(async () => root.render(<AnalysisRecordExport prepare={prepare} download={download} />));
    const click = async (selector: string) => { await act(async () => host.querySelector<HTMLElement>(selector)!.click()); };
    const downloadButton = () => host.querySelector<HTMLButtonElement>('details + button')!;
    await click('button');
    expect(host.querySelector('pre')?.textContent).toBe('masked snapshot');
    await click('input');
    expect(host.querySelector('pre')?.textContent).toBe('exact snapshot');
    expect(downloadButton().disabled).toBe(true);
    expect(download).not.toHaveBeenCalled();
    await click('label:has(+ button) input');
    await act(async () => downloadButton().click());
    expect(await download.mock.calls[0][0].text()).toBe('exact snapshot');
    expect(prepare).toHaveBeenCalledTimes(2);
    await click('dialog > button:last-child');
    await click('button');
    expect(host.querySelector('pre')?.textContent).toBe('masked snapshot');
    expect(host.querySelector<HTMLInputElement>('input')?.checked).toBe(false);
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
