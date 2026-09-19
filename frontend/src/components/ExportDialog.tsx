"use client";
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, X } from 'lucide-react';
import { DATA_FORMATS, type DataFormat, type ImageFormat } from '@/lib/export';

// One modal for both export kinds. It only collects choices; the page owns
// the export functions and the state they persist (title & legend lives in
// the workspace, so it is passed in and written back rather than kept here).
//
// Portalled to <body> and `fixed` for the same reason InfoDialog is: the
// sidebar is a positioned, scrolling stacking context over a WebGL canvas.

export type ImageExportOptions = {
  format: ImageFormat;
  title: boolean; legend: boolean;
  axes: boolean; grid: boolean; labels: boolean;
  scale: 1 | 2 | 4;
};
export type DataExportOptions = { format: DataFormat; rows: 'all' | 'visible'; includeDerived: boolean };

export type ExportDialogProps = {
  kind: 'image' | 'data' | null;
  onClose: () => void;
  theme?: string;
  viewMode: '2D' | '3D';
  /** Persisted title / legend chrome; the dialog edits it in place. */
  chrome: { title: boolean; legend: boolean };
  onChromeChange: (v: { title: boolean; legend: boolean }) => void;
  /** The plot's own axes toggle — the default for the three axis options. */
  axesOn: boolean;
  /** One frame with the given options, as a data URL (null = unavailable). */
  renderPreview: (opts: ImageExportOptions) => Promise<string | null>;
  nRows: number;
  filter: { description: string; shown: number } | null;
  hasDerived: boolean;
  busy: boolean;
  onExportImage: (opts: ImageExportOptions) => void;
  onExportData: (opts: DataExportOptions) => void;
};

const IMAGE_FORMATS: { id: ImageFormat; label: string; hint: string; only?: '2D' | '3D' }[] = [
  { id: 'png', label: 'PNG', hint: 'raster image of the view as framed on screen' },
  { id: 'svg', label: 'SVG', hint: 'vector image — 2D only', only: '2D' },
  { id: 'gif', label: 'GIF', hint: 'one full rotation of the 3D view — 3D only', only: '3D' },
  { id: 'html', label: 'HTML', hint: 'self-contained interactive file that works offline' },
];

// Fresh defaults each time it opens: the form is keyed on everything its
// defaults depend on, so React re-mounts it instead of an effect resetting
// state — the axes toggle follows the plot, the rows choice follows whether a
// filter is active, and an unavailable format (GIF in 2D) is never selected.
export const ExportDialog = (props: ExportDialogProps) => {
  const { kind, onClose, viewMode, axesOn, filter } = props;
  useEffect(() => {
    if (!kind) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [kind, onClose]);
  if (!kind || typeof document === 'undefined') return null;
  return <ExportForm key={`${kind}|${viewMode}|${axesOn}|${filter?.description ?? ''}`} {...props} kind={kind} />;
};

const ExportForm = ({
  kind, onClose, theme, viewMode, chrome, onChromeChange, axesOn, renderPreview, nRows, filter, hasDerived, busy, onExportImage, onExportData,
}: ExportDialogProps & { kind: 'image' | 'data' }) => {
  const [imageFormat, setImageFormat] = useState<ImageFormat>('png');
  const [axes, setAxes] = useState(axesOn);
  const [grid, setGrid] = useState(axesOn);
  const [labels, setLabels] = useState(axesOn);
  // The frame last rendered and the options it was rendered for; it is
  // stale whenever the current options differ (no state write in the effect).
  const [preview, setPreview] = useState<{ src: string | null; key: string }>({ src: null, key: '' });
  const [scale, setScale] = useState<1 | 2 | 4>(2);
  const [dataFormat, setDataFormat] = useState<DataFormat>('csv');
  const [rows, setRows] = useState<'all' | 'visible'>(filter ? 'visible' : 'all');
  const [includeDerived, setIncludeDerived] = useState(true);
  const panel = useRef<HTMLDivElement>(null);
  const isImage = kind === 'image';

  // Preview: one frame, re-rendered a beat after the last change. A render
  // that finishes after a newer one started is dropped.
  const previewKey = `${chrome.title}|${chrome.legend}|${axes}|${grid}|${labels}`;
  useEffect(() => {
    if (!isImage) return;
    let live = true;
    const t = window.setTimeout(() => {
      renderPreview({ format: 'png', title: chrome.title, legend: chrome.legend, axes, grid, labels, scale: 1 })
        .then(src => { if (live) setPreview({ src, key: previewKey }); });
    }, 250);
    return () => { live = false; window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isImage, previewKey]);

  const bauhaus = theme === 'primary';
  const accent = bauhaus ? 'var(--p-blue)' : 'var(--system-green)';
  const rule = bauhaus ? 'var(--border)' : 'color-mix(in srgb, var(--system-green) 40%, transparent)';
  const heading = (text: string) => (
    <h3 className="text-[11px] font-bold uppercase tracking-wide pb-1 border-b" style={{ color: accent, borderColor: rule }}>{text}</h3>
  );
  const option = (
    id: string, name: string, checked: boolean, disabled: boolean, onPick: () => void, label: string, hint: string, autoFocus = false,
  ) => (
    <label key={id} className={`flex items-start gap-2 py-1 ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}>
      <input type="radio" name={name} className="mt-[3px] shrink-0" checked={checked} disabled={disabled} onChange={onPick} autoFocus={autoFocus} />
      <span className="min-w-0"><b>{label}</b><span className="block opacity-60 text-[11px] leading-snug">{hint}</span></span>
    </label>
  );
  const check = (checked: boolean, onChange: (v: boolean) => void, label: string, hint?: string) => (
    <label className="flex items-start gap-2 py-1 cursor-pointer min-w-0">
      <input type="checkbox" className="mt-[3px] shrink-0" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span className="min-w-0"><b>{label}</b>{hint && <span className="block opacity-60 text-[11px] leading-snug">{hint}</span>}</span>
    </label>
  );

  const rowCount = rows === 'visible' && filter ? filter.shown : nRows;
  const imageOpts: ImageExportOptions = { format: imageFormat, title: chrome.title, legend: chrome.legend, axes, grid, labels, scale };
  const submit = () => {
    if (isImage) onExportImage(imageOpts);
    else onExportData({ format: dataFormat, rows: filter ? rows : 'all', includeDerived });
  };

  return createPortal(
    <div
      role="dialog" aria-modal="true" aria-label={isImage ? 'Export image' : 'Export data'}
      className="fixed inset-0 z-[300] flex items-center justify-center overflow-y-auto bg-black/60 p-4"
      onMouseDown={e => { if (!panel.current?.contains(e.target as Node)) onClose(); }}
    >
      <div ref={panel} className={`w-full ${isImage ? 'max-w-4xl' : 'max-w-lg'} border bg-[var(--card)] text-[var(--foreground)] ${bauhaus ? 'border-[3px] border-[var(--border)]' : 'border-[var(--border)]'}`}>
        <header className={`flex items-center justify-between gap-3 px-4 py-3 border-b ${bauhaus ? 'bg-[var(--p-blue)] text-white border-[var(--border)]' : 'bg-[var(--system-green)]/15 border-[var(--system-green)] text-[var(--system-green)]'}`}>
          <h2 className="text-sm font-bold uppercase tracking-wide">{isImage ? 'Export image' : 'Export data'}</h2>
          <button onClick={onClose} aria-label="Close" className={`cursor-pointer transition-all duration-150 ${bauhaus ? 'flex items-center justify-center w-6 h-6 border-2 border-[var(--border)] bg-[var(--p-red)] text-white hover:bg-[var(--p-yellow)] hover:text-[#111111]' : 'text-[var(--system-green)]/70 hover:text-[var(--system-green)] hover:scale-125'}`}>
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="px-4 py-4 space-y-4 text-[12px] leading-relaxed">
          {isImage ? (
            <div className="grid gap-5 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <section className="space-y-1 min-w-0">
                {heading('Preview')}
                <div className="relative w-full aspect-[4/3] border overflow-hidden bg-white" style={{ borderColor: rule }}>
                  {/* A data URL from Plotly — not something next/image can optimise. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {preview.src && <img src={preview.src} alt="Export preview" className={`w-full h-full object-contain ${preview.key !== previewKey ? 'opacity-50' : ''}`} />}
                  {(!preview.src || preview.key !== previewKey) && (
                    <span className="absolute inset-0 flex items-center justify-center text-[11px] text-[#666666]">{preview.src ? 'Updating…' : 'Rendering preview…'}</span>
                  )}
                </div>
                <p className="opacity-60 text-[11px]">{imageFormat === 'gif' ? 'One frame of the rotation, as it will be dressed.' : imageFormat === 'html' ? 'The starting frame of the interactive file.' : 'As it will be saved, at reduced size.'}</p>
              </section>
              <div className="space-y-4 min-w-0">
                <section className="space-y-1">
                  {heading('Format')}
                  {IMAGE_FORMATS.map((f, i) => {
                    const unavailable = !!f.only && f.only !== viewMode;
                    return option(f.id, 'image-format', imageFormat === f.id, unavailable, () => setImageFormat(f.id), f.label, f.hint, i === 0);
                  })}
                </section>
                <section className="space-y-1">
                  {heading('Chrome')}
                  <div className="grid grid-cols-2 gap-x-3">
                    {check(chrome.title, v => onChromeChange({ ...chrome, title: v }), 'Title')}
                    {check(chrome.legend, v => onChromeChange({ ...chrome, legend: v }), 'Legend')}
                  </div>
                </section>
                <section className="space-y-1">
                  {heading('Axes')}
                  <div className="grid grid-cols-2 gap-x-3">
                    {check(axes, setAxes, 'Lines & ticks')}
                    {check(grid, setGrid, 'Gridlines')}
                    {check(labels, setLabels, 'Axis titles')}
                  </div>
                </section>
                {imageFormat === 'png' && (
                  <section className="space-y-1">
                    {heading('Resolution')}
                    <div className="flex gap-2">
                      {([1, 2, 4] as const).map(sc => (
                        <button key={sc} type="button" onClick={() => setScale(sc)}
                          className={`px-3 py-1 text-[11px] font-bold border cursor-pointer ${scale === sc ? (bauhaus ? 'bg-[var(--p-yellow)] text-[#111111] border-[var(--border)]' : 'bg-[var(--system-green)] text-black border-[var(--system-green)]') : (bauhaus ? 'border-[var(--border)] opacity-60 hover:opacity-100' : 'border-[var(--system-green)]/40 text-[var(--system-green)]/70 hover:text-[var(--system-green)]')}`}>
                          {sc}×
                        </button>
                      ))}
                    </div>
                  </section>
                )}
              </div>
            </div>
          ) : (
            <>
              <section className="space-y-1">
                {heading('Format')}
                {DATA_FORMATS.map((f, i) => option(f.id, 'data-format', dataFormat === f.id, false, () => setDataFormat(f.id), f.label, f.hint, i === 0))}
              </section>
              <section className="space-y-1">
                {heading('Rows')}
                {filter
                  ? (<>
                      {option('visible', 'rows', rows === 'visible', false, () => setRows('visible'), `Visible rows only (${filter.shown})`, `filter: ${filter.description}`)}
                      {option('all', 'rows', rows === 'all', false, () => setRows('all'), `All rows (${nRows})`, 'ignores the active filter')}
                    </>)
                  : <p className="opacity-70 py-1">All {nRows} rows — no row filter is active.</p>}
              </section>
              <section className="space-y-1">
                {heading('Columns')}
                {hasDerived
                  ? check(includeDerived, setIncludeDerived, 'Include derived columns', 'PC scores, composites and cluster labels this app added')
                  : <p className="opacity-70 py-1">All columns — nothing derived has been added yet.</p>}
              </section>
            </>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 px-4 py-3 border-t" style={{ borderColor: rule }}>
          <span className="opacity-60 text-[11px]">{isImage ? `${imageFormat.toUpperCase()} of the ${viewMode} view` : `${rowCount} row${rowCount === 1 ? '' : 's'} as ${dataFormat.toUpperCase()}`}</span>
          <button type="button" onClick={submit} disabled={busy}
            className={`scatterlab-action-button flex items-center gap-2 px-4 py-2 text-sm font-bold disabled:opacity-40 cursor-pointer ${bauhaus ? 'bauhaus-btn bg-[var(--p-blue)] text-white' : 'bg-[var(--system-green)] border border-[var(--system-green)] text-black'}`}>
            <Download className="w-4 h-4" /> {busy ? 'Working…' : 'Export'}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
};
