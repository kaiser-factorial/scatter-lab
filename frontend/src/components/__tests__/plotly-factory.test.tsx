// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import createPlotlyComponent, { type PlotParams } from '../../../vendor/react-plotly-factory/factory.mjs';

type GraphDiv = HTMLDivElement & {
  data: unknown[]; layout: unknown; _transitionData: { _frames: unknown[] | null };
  on: (event: string, callback: (event?: unknown) => void) => void;
  removeListener: (event: string, callback: (event?: unknown) => void) => void;
};

function plotlyDouble() {
  const listeners = new Map<GraphDiv, Map<string, Set<(event?: unknown) => void>>>();
  function apply(element: GraphDiv, figure: PlotParams) {
    element.data = figure.data ?? []; element.layout = figure.layout;
    element._transitionData = { _frames: figure.frames ?? null };
    if (!listeners.has(element)) {
      const events = new Map<string, Set<(event?: unknown) => void>>();
      listeners.set(element, events);
      element.on = (event, callback) => {
        const callbacks = events.get(event) ?? new Set();
        callbacks.add(callback); events.set(event, callbacks);
      };
      element.removeListener = (event, callback) => { events.get(event)?.delete(callback); };
    }
    return element;
  }
  const plotly = {
    react: vi.fn(async (element: GraphDiv, figure: PlotParams) => apply(element, figure)),
    purge: vi.fn((element: GraphDiv) => { listeners.delete(element); }),
    Plots: { resize: vi.fn(async (element: GraphDiv) => { void element; }) },
  };
  return { plotly, apply,
    emit(element: GraphDiv, event: string, value?: unknown) {
      for (const callback of [...(listeners.get(element)?.get(event) ?? [])]) callback(value);
    },
  };
}

let root: Root | undefined;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const render = async (element: React.ReactNode) => { await act(async () => root!.render(element)); };

it('forwards the supplied Plotly instance, figure, graph ref, and DOM properties without replacing trace types', async () => {
  const { plotly } = plotlyDouble(); const Plot = createPlotlyComponent(plotly);
  const ref = createRef<HTMLDivElement>(); const onInitialized = vi.fn();
  const data = [{ type: 'scatter', x: [1, 2] }, { type: 'scatter3d', x: [1], y: [2], z: [3] }];
  const layout = { autosize: true, scene: { camera: { eye: { x: 1, y: 2, z: 3 } } } };
  const config = { responsive: true }; const frames = [{ name: 'frame-1' }];
  await render(<Plot ref={ref} data={data} layout={layout} config={config} frames={frames}
    divId="plot-under-test" className="figure" style={{ width: '100%', height: '240px' }} onInitialized={onInitialized} />);
  const graph = host.firstElementChild as GraphDiv;
  expect(ref.current).toBe(graph);
  expect(graph.id).toBe('plot-under-test'); expect(graph.className).toBe('figure'); expect(graph.style.height).toBe('240px');
  expect(plotly.react).toHaveBeenCalledExactlyOnceWith(graph, { data, layout, config, frames });
  expect(onInitialized).toHaveBeenCalledExactlyOnceWith({ data, layout, frames }, graph);
});

it('retains upstream identity, revision, and frame-count update triggers without replotting unchanged figures', async () => {
  const { plotly } = plotlyDouble(); const Plot = createPlotlyComponent(plotly);
  const data = [{ type: 'scatter' }], layout = { title: { text: 'Original' } }, config = { responsive: true };
  const onUpdate = vi.fn(); const props = { data, layout, config, revision: 0, onUpdate };
  await render(<Plot {...props} />);
  await render(<Plot {...props} className="changed-decoration" />);
  expect(plotly.react).toHaveBeenCalledTimes(1);
  await render(<Plot {...props} revision={1} />);
  expect(plotly.react).toHaveBeenCalledTimes(2);
  await render(<Plot {...props} revision={1} layout={{ ...layout }} />);
  expect(plotly.react).toHaveBeenCalledTimes(3);
  await render(<Plot {...props} revision={1} frames={[{ name: 'one' }]} />);
  expect(plotly.react).toHaveBeenCalledTimes(4);
  expect(onUpdate).toHaveBeenCalledTimes(3);
});

it('forwards relayout, selection, export and WebGL events and replaces callbacks after a figure update', async () => {
  const { plotly, emit } = plotlyDouble(); const Plot = createPlotlyComponent(plotly);
  const onRelayout = vi.fn(), onSelected = vi.fn(), onBeforeExport = vi.fn(), onAfterExport = vi.fn(), onWebGlContextLost = vi.fn();
  const onUpdate = vi.fn(); const data: unknown[] = []; const layout = { autosize: true };
  await render(<Plot data={data} layout={layout} revision={0} onRelayout={onRelayout} onSelected={onSelected}
    onBeforeExport={onBeforeExport} onAfterExport={onAfterExport} onWebGlContextLost={onWebGlContextLost} onUpdate={onUpdate} />);
  const graph = host.firstElementChild as GraphDiv;
  const camera = { 'scene.camera': { eye: { x: 2, y: 1, z: 1 } } };
  emit(graph, 'plotly_relayout', camera);
  expect(onRelayout).toHaveBeenCalledExactlyOnceWith(camera);
  expect(onUpdate).toHaveBeenCalledExactlyOnceWith({ data, layout, frames: null }, graph);
  for (const [name, handler] of [['plotly_selected', onSelected], ['plotly_beforeexport', onBeforeExport],
    ['plotly_afterexport', onAfterExport], ['plotly_webglcontextlost', onWebGlContextLost]] as const) {
    const event = { name }; emit(graph, name, event); expect(handler).toHaveBeenCalledExactlyOnceWith(event);
  }
  const replacement = vi.fn();
  await render(<Plot data={data} layout={layout} revision={1} onRelayout={replacement} onUpdate={onUpdate} />);
  emit(graph, 'plotly_relayout', { 'xaxis.range[0]': 1 });
  expect(replacement).toHaveBeenCalledExactlyOnceWith({ 'xaxis.range[0]': 1 });
  expect(onRelayout).toHaveBeenCalledTimes(1);
  emit(graph, 'plotly_selected', { points: [] }); expect(onSelected).toHaveBeenCalledTimes(1);
});

it('resizes the graph, reports its last state on purge, and removes the resize subscription on unmount', async () => {
  const { plotly } = plotlyDouble(); const Plot = createPlotlyComponent(plotly);
  const ref = createRef<HTMLDivElement>(); const onPurge = vi.fn(); const data = [{ type: 'scatter3d' }], layout = { autosize: true };
  await render(<Plot ref={ref} data={data} layout={layout} useResizeHandler onPurge={onPurge} />);
  const graph = ref.current as GraphDiv;
  expect(plotly.Plots.resize).toHaveBeenCalledExactlyOnceWith(graph);
  window.dispatchEvent(new Event('resize')); expect(plotly.Plots.resize).toHaveBeenCalledTimes(2);
  await act(async () => root!.unmount()); root = undefined;
  expect(onPurge).toHaveBeenCalledExactlyOnceWith({ data, layout, frames: null }, graph);
  expect(plotly.purge).toHaveBeenCalledExactlyOnceWith(graph); expect(ref.current).toBeNull();
  window.dispatchEvent(new Event('resize')); expect(plotly.Plots.resize).toHaveBeenCalledTimes(2);
});

it('preserves keyed pinned graphs on reorder and purges only the removed graph', async () => {
  const { plotly } = plotlyDouble(); const Plot = createPlotlyComponent(plotly);
  const one = { data: [{ type: 'scatter' }], layout: { title: { text: 'one' } } };
  const two = { data: [{ type: 'scatter3d' }], layout: { title: { text: 'two' } } };
  await render(<><Plot key="one" divId="one" {...one} /><Plot key="two" divId="two" {...two} /></>);
  const first = host.querySelector('#one'), second = host.querySelector('#two');
  await render(<><Plot key="two" divId="two" {...two} /><Plot key="one" divId="one" {...one} /></>);
  expect(host.querySelector('#one')).toBe(first); expect(host.querySelector('#two')).toBe(second);
  expect(plotly.purge).not.toHaveBeenCalled(); expect(plotly.react).toHaveBeenCalledTimes(2);
  await render(<><Plot key="two" divId="two" {...two} /></>);
  expect(plotly.purge).toHaveBeenCalledExactlyOnceWith(first); expect(host.querySelector('#two')).toBe(second);
});

it('serializes Plotly.react updates and suppresses completion callbacks after unmount', async () => {
  const { plotly, apply } = plotlyDouble(); const Plot = createPlotlyComponent(plotly);
  let complete!: (graph: GraphDiv) => void;
  let firstGraph!: GraphDiv;
  const pending = new Promise<GraphDiv>(resolve => { complete = resolve; });
  plotly.react.mockImplementationOnce((graph, figure) => { firstGraph = apply(graph, figure); return pending; });
  const onInitialized = vi.fn(), onUpdate = vi.fn();
  await render(<Plot data={[{ type: 'scatter' }]} onInitialized={onInitialized} onUpdate={onUpdate} />);
  await render(<Plot data={[{ type: 'scatter3d' }]} onInitialized={onInitialized} onUpdate={onUpdate} />);
  expect(plotly.react).toHaveBeenCalledTimes(1);
  await act(async () => root!.unmount()); root = undefined;
  await act(async () => { complete(firstGraph); await pending; });
  expect(plotly.react).toHaveBeenCalledTimes(1);
  expect(onInitialized).not.toHaveBeenCalled(); expect(onUpdate).not.toHaveBeenCalled();
  expect(plotly.purge).toHaveBeenCalledExactlyOnceWith(firstGraph);
});

it('forwards plotting errors to onError without invoking success callbacks', async () => {
  const { plotly } = plotlyDouble(); const Plot = createPlotlyComponent(plotly);
  const error = new Error('Synthetic plotting failure'); plotly.react.mockRejectedValueOnce(error);
  const onError = vi.fn(), onInitialized = vi.fn();
  await render(<Plot onError={onError} onInitialized={onInitialized} />);
  expect(onError).toHaveBeenCalledExactlyOnceWith(error); expect(onInitialized).not.toHaveBeenCalled();
});

it('retains exact upstream artifacts and declares only the React peer', () => {
  const directory = resolve('vendor/react-plotly-factory');
  const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  const provenance = JSON.parse(readFileSync(resolve(directory, 'PROVENANCE.json'), 'utf8'));
  expect(manifest.peerDependencies).toEqual({ react: '^18.0.0 || ^19.0.0' });
  expect(manifest.dependencies).toBeUndefined(); expect(manifest.scripts).toBeUndefined();
  expect(provenance.upstream).toMatchObject({ name: 'react-plotly.js', version: '4.1.0' });
  for (const file of provenance.files) {
    const bytes = readFileSync(resolve(directory, file.file));
    expect(bytes.length, file.file).toBe(file.bytes);
    expect(createHash('sha256').update(bytes).digest('hex'), file.file).toBe(file.sha256);
  }
  expect(readFileSync(resolve(directory, 'LICENSE'), 'utf8')).toContain('Copyright (c) 2017-2024 Plotly Technologies Inc.');
});
