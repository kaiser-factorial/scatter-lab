"use client";
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';

// Consent gate for starting the walkthrough over someone's own data.
//
// The walkthrough is the only part of the assistant panel that mutates the
// workbench without being asked turn by turn: it loads Iris, makes it active,
// adds PC1–PC3 and Cluster columns, and pins a view. Doing that to a loaded
// dataset without warning is the one genuinely destructive path in the feature,
// so it stops here — with the save offered inline, because "go save your work
// first" that costs you the dialog is advice nobody takes.
//
// A view-state snapshot is taken regardless and offered back on exit; this
// dialog exists for what a snapshot does not cover, which is the user's own
// uploaded data being displaced as the active dataset.
//
// Mounted only while it is open, so a second visit starts with an empty name
// field and no stale "saved" line rather than being reset in an effect.
export const WalkthroughStartDialog = ({
  theme,
  datasetNames,
  onSaveWorkspace,
  onStart,
  onCancel,
}: {
  theme?: string;
  datasetNames: string[];
  onSaveWorkspace: (name: string) => Promise<string>;
  onStart: () => void;
  onCancel: () => void;
}) => {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const startBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    startBtn.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  if (typeof document === 'undefined') return null;

  const bauhaus = theme === 'primary';
  const panelCls = bauhaus
    ? 'bg-white border-[3px] border-[#111111] shadow-[8px_8px_0px_#111111]'
    : 'bg-black border border-[var(--system-green)]/50';
  const inputCls = bauhaus
    ? 'bg-white border border-[#111111] text-[#111111]'
    : 'bg-[var(--input)] border border-[var(--border)] text-[var(--foreground)]';
  const primaryBtn = bauhaus
    ? 'bauhaus-btn bg-[var(--p-blue)] text-white'
    : 'border border-[var(--system-green)]/60 text-[var(--system-green)] hover:bg-[var(--system-green)]/10';

  const save = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      setSaved(await onSaveWorkspace(name.trim()));
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label="Start the guided walkthrough"
    >
      <div onClick={e => e.stopPropagation()} className={`w-full max-w-md max-h-full overflow-y-auto p-5 space-y-4 ${panelCls}`}>
        <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-widest">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" /> This will change your workspace
        </h2>

        <div className="text-xs leading-relaxed space-y-2">
          <p>
            The walkthrough runs on the built-in Iris demo. It loads that dataset, makes it the
            <strong> active</strong> one, and adds a PCA run, cluster labels and a pinned view.
          </p>
          <p className="opacity-80">
            {datasetNames.length === 1
              ? <>Your dataset <strong>{datasetNames[0]}</strong> stays loaded</>
              : <>Your {datasetNames.length} datasets stay loaded</>}
            {' '}and you can switch back from the Data section afterwards — but anything not saved
            to a workspace lives only in this tab.
          </p>
        </div>

        <div className={`p-3 space-y-2 ${bauhaus ? 'border border-[#111111]/30 bg-black/[0.03]' : 'border border-[var(--system-green)]/25 bg-[var(--system-green)]/5'}`}>
          <div className="text-[10px] font-bold uppercase tracking-wider opacity-60">
            Save a workspace first (recommended)
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={name}
              onChange={e => { setName(e.target.value); setSaved(''); }}
              onKeyDown={e => { if (e.key === 'Enter') void save(); }}
              placeholder="Workspace name"
              aria-label="Workspace name"
              className={`flex-1 min-w-0 px-2 py-1.5 text-xs outline-none ${inputCls}`}
            />
            <button
              onClick={() => void save()}
              disabled={!name.trim() || saving}
              className={`px-3 py-1.5 text-xs font-bold disabled:opacity-30 cursor-pointer ${primaryBtn}`}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
          {saved && <p className="text-[10px] leading-snug opacity-70">{saved}</p>}
        </div>

        <div className="flex gap-2 justify-end pt-1">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs underline-offset-2 hover:underline opacity-60 cursor-pointer"
          >
            Cancel
          </button>
          <button
            ref={startBtn}
            onClick={onStart}
            className={`px-3 py-1.5 text-xs font-bold cursor-pointer ${primaryBtn}`}
          >
            Start walkthrough
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
