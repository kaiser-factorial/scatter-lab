import { describe, expect, it } from 'vitest';
import { readRelayout } from '../relayout';

describe('reading a plotly relayout payload', () => {
  it('reports a 3D camera move', () => {
    const camera = { eye: { x: 1, y: 2, z: 3 } };
    expect(readRelayout({ 'scene.camera': camera })).toEqual({ kind: 'camera', camera });
  });

  it('reports a 2D box-zoom as the new viewport', () => {
    expect(readRelayout({
      'xaxis.range[0]': 1.5, 'xaxis.range[1]': 4.5,
      'yaxis.range[0]': -2, 'yaxis.range[1]': 2,
    })).toEqual({ kind: 'range2d', range: { x: [1.5, 4.5], y: [-2, 2] } });
  });

  it('reads a double-click reset as autorange, on either axis alone', () => {
    expect(readRelayout({ 'xaxis.autorange': true, 'yaxis.autorange': true }))
      .toEqual({ kind: 'range2d', range: null });
    expect(readRelayout({ 'yaxis.autorange': true })).toEqual({ kind: 'range2d', range: null });
  });

  it('ignores a partial range rather than building half a viewport', () => {
    // A pan that reports only x, or an autoscale that reports one axis, would
    // otherwise produce {x: [...], y: [undefined, undefined]} — which Plotly
    // renders as an empty plot.
    expect(readRelayout({ 'xaxis.range[0]': 1, 'xaxis.range[1]': 2 })).toBeNull();
    expect(readRelayout({
      'xaxis.range[0]': 1, 'xaxis.range[1]': 2, 'yaxis.range[0]': 0,
    })).toBeNull();
  });

  it('ignores non-finite bounds', () => {
    expect(readRelayout({
      'xaxis.range[0]': NaN, 'xaxis.range[1]': 2,
      'yaxis.range[0]': 0, 'yaxis.range[1]': 1,
    })).toBeNull();
    expect(readRelayout({
      'xaxis.range[0]': 0, 'xaxis.range[1]': Infinity,
      'yaxis.range[0]': 0, 'yaxis.range[1]': 1,
    })).toBeNull();
  });

  it('ignores layout noise, and empty or missing events', () => {
    expect(readRelayout({ 'legend.x': 0.5, autosize: true })).toBeNull();
    expect(readRelayout({})).toBeNull();
    expect(readRelayout(null)).toBeNull();
    expect(readRelayout(undefined)).toBeNull();
  });

  it('prefers the camera when a payload somehow carries both', () => {
    const camera = { eye: { x: 0, y: 0, z: 1 } };
    expect(readRelayout({
      'scene.camera': camera,
      'xaxis.range[0]': 1, 'xaxis.range[1]': 2, 'yaxis.range[0]': 0, 'yaxis.range[1]': 1,
    })).toEqual({ kind: 'camera', camera });
  });
});
