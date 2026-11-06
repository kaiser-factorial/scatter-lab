"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function DatasetDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => previous?.focus();
  }, []);
  return createPortal(<div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}
      className="dataset-dialog w-[440px] max-w-full max-h-[85vh] overflow-y-auto border-2 border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] p-4 space-y-4 text-xs"
      onClick={e => e.stopPropagation()} onKeyDown={e => {
        if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
        if (e.key !== 'Tab') return;
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]') ?? [])].filter(el => !!el.getClientRects().length);
        const first = items[0], last = items.at(-1);
        if (!first) { e.preventDefault(); return; }
        if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { e.preventDefault(); first.focus(); }
      }}>
      <h2 className="text-sm font-bold">{title}</h2>
      {children}
    </div>
  </div>, document.body);
}
