// Reading Plotly's `plotly_relayout` payload.
//
// Plotly reports what changed as a flat bag of dotted keys, and the same event
// name carries four unrelated things: a 3D camera move, a 2D box-zoom/pan, a
// double-click reset (which sends `autorange` rather than a range pair), and a
// long tail of layout noise that must be ignored. The page has to answer one
// question — "what framing did this pane end up with?" — and route the answer
// to whichever pane fired it, so the reading is worth having on its own where
// the partial and malformed payloads can be pinned down in tests.
//
// It deliberately says nothing about WHICH pane: that is the caller's business.

export type Range2D = { x: [number, number]; y: [number, number] };

export type RelayoutIntent =
  /** A 3D scene camera moved. */
  | { kind: 'camera'; camera: unknown }
  /** A 2D viewport changed; `range: null` means reset to autorange. */
  | { kind: 'range2d'; range: Range2D | null }
  /** Nothing this app tracks. */
  | null;

export const readRelayout = (event: Record<string, unknown> | null | undefined): RelayoutIntent => {
  if (!event) return null;

  // Camera first: a scene event never also carries axis ranges.
  const camera = event['scene.camera'];
  if (camera != null) return { kind: 'camera', camera };

  // Double-click. Plotly may send one axis or both, and either as `true` or as
  // the string "true" depending on how the relayout was triggered.
  if (event['xaxis.autorange'] || event['yaxis.autorange']) return { kind: 'range2d', range: null };

  const x0 = event['xaxis.range[0]'], x1 = event['xaxis.range[1]'];
  const y0 = event['yaxis.range[0]'], y1 = event['yaxis.range[1]'];
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  // All four or nothing: a partial payload (a pan that moved only x, an
  // autoscale reporting one axis) would otherwise build a viewport half from
  // this event and half from `undefined`, and NaN ranges blank the plot.
  if (finite(x0) && finite(x1) && finite(y0) && finite(y1)) {
    return { kind: 'range2d', range: { x: [x0, x1], y: [y0, y1] } };
  }
  return null;
};
