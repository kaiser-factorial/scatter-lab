"use client";

import { useEffect, useId, useRef, useState } from 'react';
import { InfoTip } from './InfoTip';
import { PanelChoiceButton } from './PanelChoiceButton';

type Axis = 'x' | 'y' | 'z';
type Mode = '2D' | '3D';
type Aspect = 'cube' | 'data';

type Props = {
  mode: Mode;
  setMode: (mode: Mode) => void;
  aspect: Aspect;
  setAspect: (aspect: Aspect) => void;
  axesOn: boolean;
  toggleAxes: () => void;
  axes: Record<Axis, string | null>;
  labels: Record<Axis, string>;
  updateLabel: (axis: Axis, label: string) => void;
  rotating: boolean;
  toggleRotation: () => void;
  pin: () => void;
  pinning: boolean;
};

export function LiveViewControls({ mode, setMode, aspect, setAspect, axesOn, toggleAxes, axes, labels, updateLabel, rotating, toggleRotation, pin, pinning }: Props) {
  const [open, setOpen] = useState(false);
  const drawer = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const id = useId();
  const dimensions: Axis[] = mode === '3D' ? ['x', 'y', 'z'] : ['x', 'y'];
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const element = drawer.current;
      if (!element || !(event.target instanceof Element) || element.contains(event.target)) return;
      // The axis-scale help belongs to the drawer but renders in a body portal.
      const tooltip = event.target.closest('[role="tooltip"]');
      if (tooltip && element.querySelector('[aria-describedby]')?.getAttribute('aria-describedby') === tooltip.id) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside, true);
    return () => document.removeEventListener('pointerdown', closeOutside, true);
  }, [open]);

  return <div ref={drawer} className="live-view-drawer" onKeyDown={event => {
    if (open && event.key === 'Escape') {
      event.stopPropagation();
      setOpen(false);
      toggle.current?.focus();
    }
  }}>
    <button type="button" ref={toggle} data-guide="view" className="live-view-tab" aria-label={open ? 'Collapse View' : 'Expand View'}
      aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      View <span aria-hidden="true" className="notes-sign">{open ? '−' : '+'}</span>
    </button>
    <section id={id} aria-label="Live view settings" hidden={!open} className="live-view-settings space-y-2">
      <div className="flex gap-1" role="group" aria-label="View dimensions">
        <PanelChoiceButton selected={mode === '2D'} onClick={() => setMode('2D')}>2D</PanelChoiceButton>
        <PanelChoiceButton selected={mode === '3D'} onClick={() => setMode('3D')}>3D</PanelChoiceButton>
      </div>
      <div className="flex flex-wrap gap-1">
        <button type="button" className="live-view-action" aria-pressed={axesOn} onClick={toggleAxes}>Axes {axesOn ? 'on' : 'off'}</button>
        {mode === '3D' && <button type="button" className="live-view-action" aria-pressed={rotating} onClick={toggleRotation}>{rotating ? 'Stop rotation' : 'Start rotation'}</button>}
      </div>
      {mode === '3D' && <div className="flex items-center gap-1" role="group" aria-label="Axis scale">
        <PanelChoiceButton selected={aspect === 'cube'} onClick={() => setAspect('cube')}>Cube</PanelChoiceButton>
        <PanelChoiceButton selected={aspect === 'data'} onClick={() => setAspect('data')}>True scale</PanelChoiceButton>
        {open && <InfoTip topic="aspect_mode" />}
      </div>}
      <details>
        <summary className="cursor-pointer">Axis labels</summary>
        {dimensions.map(axis => <label key={axis} className="mt-1 flex items-center gap-1">
          <span className="w-4 uppercase">{axis}</span>
          <input className="min-w-0 flex-1 border border-[var(--border)] bg-[var(--input)] px-1 py-0.5" aria-label={`${axis.toUpperCase()} axis label`}
            title={axes[axis] ?? ''} placeholder={axes[axis] ?? ''} disabled={!axes[axis]} value={labels[axis]} onChange={event => updateLabel(axis, event.target.value)} />
        </label>)}
      </details>
      <button type="button" className="live-view-action w-full" disabled={pinning} onClick={pin}>{pinning ? 'Pinning…' : 'Pin view'}</button>
    </section>
  </div>;
}
