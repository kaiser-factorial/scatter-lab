'use client';

import { useId, useState, type ReactNode } from 'react';

export function TerminalDisclosure({ title, children, drawerWidth, initiallyOpen = true }: {
  title: string; children: ReactNode; drawerWidth?: number; initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const regionId = useId();
  const folded = drawerWidth !== undefined && !open;
  return <section className="border border-[var(--system-green)]/50 bg-[var(--background)] text-[var(--system-green)]"
    style={drawerWidth === undefined ? undefined : { width: folded ? 36 : drawerWidth }}>
    <header>
      <button type="button" className="flex min-h-9 w-full items-center justify-between gap-2 px-2 py-1 text-left font-mono text-xs font-bold hover:bg-[var(--system-green)]/10 focus-visible:outline-2"
        style={folded ? { writingMode: 'vertical-rl' } : undefined}
        aria-expanded={open} aria-controls={regionId} aria-label={`${open ? 'Collapse' : 'Expand'} ${title}`}
        onClick={() => setOpen(value => !value)}>
        {title}<span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
    </header>
    <div id={regionId} hidden={!open} className={drawerWidth === undefined ? 'px-2 pb-2' : undefined}>{open && children}</div>
  </section>;
}
