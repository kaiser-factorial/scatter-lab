import { useEffect, useRef, useState } from 'react';

const minimum = 240;
const maximum = 640;
const clamp = (width: number, limit: number) => Math.max(Math.min(minimum, limit), Math.min(width, limit));

export function useControlPanelWidth() {
  const [preferred, setPreferred] = useState(320);
  const [limit, setLimit] = useState(maximum);
  useEffect(() => {
    const resize = () => setLimit(Math.max(1, Math.min(maximum, document.documentElement.clientWidth - 54)));
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  return { width: clamp(preferred, limit), limit, onResize: (value: number) => setPreferred(clamp(value, limit)) };
}

export function ControlPanelDivider({ width, limit, onResize }: {
  width: number; limit: number; onResize: (width: number) => void;
}) {
  const drag = useRef<{ pointer: number; start: number; width: number } | null>(null);
  return <div role="separator" aria-label="Control panel width" aria-orientation="vertical"
    aria-controls="workbench-controls" aria-valuemin={Math.min(minimum, limit)} aria-valuemax={limit}
    aria-valuenow={width} aria-valuetext={`${width} pixels`} tabIndex={0}
    className="control-panel-divider" title="Drag to resize controls, or use the left and right arrow keys"
    onPointerDown={event => {
      if (event.button !== 0 || drag.current) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointer: event.pointerId, start: event.clientX, width };
    }}
    onPointerMove={event => {
      const active = drag.current;
      if (active?.pointer === event.pointerId) onResize(clamp(active.width + event.clientX - active.start, limit));
    }}
    onLostPointerCapture={() => { drag.current = null; }}
    onKeyDown={event => {
      const next = { ArrowLeft: width - 16, ArrowRight: width + 16, Home: minimum, End: limit }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      onResize(clamp(next, limit));
    }} />;
}
