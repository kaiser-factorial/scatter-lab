'use client';

import { useEffect, useRef, useState } from 'react';
import { buildAnalysisRecord } from '@/lib/analysisRecord';

type Files = Awaited<ReturnType<typeof buildAnalysisRecord>>;

export function AnalysisRecordExport({ prepare, download }: { prepare: (includeMetadata: boolean) => Promise<Files>; download: (blob: Blob, filename: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const generation = useRef(0);
  const [files, setFiles] = useState<Files>([]);
  const [error, setError] = useState('');
  const [exact, setExact] = useState(false);
  const [approved, setApproved] = useState(false);
  useEffect(() => () => { generation.current++; }, []);
  async function preview(includeMetadata: boolean) {
    const token = ++generation.current;
    setExact(includeMetadata); setApproved(false); setFiles([]); setError('');
    if (!dialog.current?.open) dialog.current?.showModal();
    try { const result = await prepare(includeMetadata); if (token === generation.current) setFiles(result); }
    catch { if (token === generation.current) setError('Could not prepare checksums. Use a secure browser context (HTTPS or localhost) and retry.'); }
  }
  return <>
    <button type="button" className="scatterlab-action-button w-full border p-2 text-xs font-bold" onClick={() => void preview(false)}>Analysis record…</button>
    <dialog ref={dialog} aria-label="Analysis record privacy preview" className="m-auto max-h-[85vh] w-[38rem] max-w-[94vw] overflow-auto bg-[var(--background)] p-4 text-[var(--foreground)] backdrop:bg-black/50">
      <h2 className="font-bold">Analysis record · privacy preview</h2>
      <p className="my-2 text-sm">The default download is a masked summary. Include exact settings to help a teammate reproduce the analysis.</p>
      <label><input type="checkbox" checked={exact} onChange={ev => void preview(ev.target.checked)} /> Include exact settings and labels</label>
      {exact && <p className="my-2 text-sm">Review labels, filters, category order, recodes and legacy notes for identifying details.</p>}
      <details className="my-2 text-sm">
        <summary className="cursor-pointer">Privacy and checksum details</summary>
        <p>Both modes omit raw rows and chat. Counts, times and fingerprints can still identify a study.</p>
        <p>Keep a trusted copy of SHA256SUMS.txt separately to detect edits. Verification checks file integrity only.</p>
      </details>
      {!files.length && <p role="status">{error || 'Preparing record…'}</p>}
      {files.map(file => <div key={file.name} className="my-2 border p-2"><details><summary>Preview {file.name}</summary><pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs">{file.text}</pre></details>
        <button type="button" disabled={exact && !approved} className="underline disabled:opacity-40" onClick={() => download(new Blob([file.text], { type: file.mime }), file.name)}>Download {file.name}</button></div>)}
      {exact && files.length > 0 && <label className="my-2 block"><input type="checkbox" checked={approved} onChange={ev => setApproved(ev.target.checked)} /> I reviewed these files for sensitive metadata.</label>}
      <button type="button" autoFocus className="border px-3 py-1" onClick={() => dialog.current?.close()}>Close</button>
    </dialog>
  </>;
}
