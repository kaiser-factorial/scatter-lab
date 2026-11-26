'use client';

import { useId, useRef, useState, type CSSProperties } from 'react';
import { GripVertical } from 'lucide-react';

const positionKey = 'scatterlab.notes.verticalPosition';
const tabHeight = 76;
const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function NotesDrawer({ notes, onChange }: { notes: string; onChange: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(() => {
    try {
      const stored = localStorage.getItem(positionKey);
      if (stored && Number.isFinite(Number(stored))) return clamp(Number(stored));
    } catch { /* Browser storage is optional. */ }
    return 0.25;
  });
  const regionId = useId();
  const overlay = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ pointer: number; y: number; start: number; travel: number; latest: number } | null>(null);
  const travel = () => Math.max(1, (overlay.current?.clientHeight ?? tabHeight) - tabHeight);
  const remember = (value: number) => {
    try { localStorage.setItem(positionKey, String(value)); } catch { /* Keep the position in memory. */ }
  };

  return <div ref={overlay} className="notes-overlay"
    style={{ '--notes-tab-height': `${tabHeight}px`, '--notes-top': `calc(${position * 100}% - ${position * tabHeight}px)` } as CSSProperties}
    onKeyDown={event => {
      if (event.key === 'Escape' && open) {
        event.stopPropagation();
        setOpen(false);
        toggle.current?.focus();
      }
    }}>
    <div className="notes-anchor">
      <button ref={toggle} type="button" className="notes-tab"
        aria-label={`${open ? 'Collapse' : 'Expand'} Notes`} aria-expanded={open} aria-controls={regionId}
        title={open ? 'Close notes' : 'Open notes to add observations'} onClick={() => setOpen(value => !value)}>
        Notes <span className="notes-sign" aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      <div role="slider" tabIndex={0} aria-label="Move Notes" aria-orientation="vertical" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={Math.round(position * 100)} aria-valuetext={`${Math.round(position * 100)}% from the top`}
        className="notes-grip" title="Move Notes up or down. Use the arrow keys or drag."
        onPointerDown={event => {
          if (!event.isPrimary || event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { pointer: event.pointerId, y: event.clientY, start: position, travel: travel(), latest: position };
        }}
        onPointerMove={event => {
          const active = drag.current;
          if (active?.pointer !== event.pointerId) return;
          active.latest = clamp(active.start + (event.clientY - active.y) / active.travel);
          setPosition(active.latest);
        }}
        onLostPointerCapture={() => {
          if (drag.current) remember(drag.current.latest);
          drag.current = null;
        }}
        onKeyDown={event => {
          const next = { ArrowUp: position - 24 / travel(), ArrowDown: position + 24 / travel(), Home: 0, End: 1 }[event.key];
          if (next === undefined) return;
          event.preventDefault();
          const value = clamp(next);
          setPosition(value);
          remember(value);
        }}>
        <GripVertical size={14} aria-hidden="true" />
      </div>
    </div>
    <div className="notes-content" id={regionId} hidden={!open}>
      <textarea aria-label="Notes" placeholder="Add observations here..." value={notes}
        onChange={event => onChange(event.target.value)} />
    </div>
  </div>;
}
