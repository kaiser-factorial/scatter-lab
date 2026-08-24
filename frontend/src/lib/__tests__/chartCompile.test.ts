import { describe, it, expect } from 'vitest';
import { compileChart, kde, normalQuantile, quantileSorted } from '../chartCompile';
import { analysisProfileOf } from '../validators';
import { policyFor } from '../dataPolicy';
import type { DataTable } from '../table';

// The compiler's contract: house policies applied centrally (zero-anchoring,
// shared bins, orientation tips), and the summary the assistant sees derived
// from the SAME aggregates the user's chart draws — with withheld group
// values pooled or omitted identically in both.

const table = (data: Record<string, unknown[]>): DataTable => {
  const columns = Object.keys(data);
  return { columns, data: data as DataTable['data'], nRows: data[columns[0]].length };
};

// species: two visible groups + a 1-row rare value withheld in private mode.
const fixture = table({
  sepal_len: [5.1, 4.9, 6.2, 5.8, 6.4, 5.5, 5.0, 6.0, 5.9, 6.1, 5.2, 9.9],
  species: ['setosa', 'setosa', 'setosa', 'setosa', 'setosa', 'setosa',
            'virginica', 'virginica', 'virginica', 'virginica', 'virginica', 'ghost_orchid'],
  when: ['2024-01-01', '2024-01-01', '2024-01-02', '2024-01-02', '2024-01-03', '2024-01-03',
         '2024-01-01', '2024-01-02', '2024-01-02', '2024-01-03', '2024-01-03', '2024-01-04'],
});
const priv = () => analysisProfileOf(fixture, policyFor('private'));
const open = () => analysisProfileOf(fixture, policyFor('open'));

describe('numeric helpers', () => {
  it('quantileSorted interpolates like R type 7', () => {
    expect(quantileSorted([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantileSorted([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(quantileSorted([7], 0.9)).toBe(7);
  });

  it('normalQuantile inverts the CDF', () => {
    expect(normalQuantile(0.5)).toBeCloseTo(0, 6);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 4);
  });

  it('kde integrates to ~1', () => {
    const { grid, density } = kde([1, 2, 2, 3, 4, 5, 5, 6]);
    const step = grid[1] - grid[0];
    const mass = density.reduce((s, d) => s + d * step, 0);
    expect(mass).toBeGreaterThan(0.95);
    expect(mass).toBeLessThan(1.05);
  });
});

describe('compileChart — data-mode rule', () => {
  it('private ECDF omits the withheld group and says so, without naming it', () => {
    const c = compileChart({ kind: 'chart', mark: 'ecdf', column: 'sepal_len', groupBy: 'species' }, fixture, priv());
    expect(c.traces.length).toBe(2);
    const text = JSON.stringify(c);
    expect(text).not.toContain('ghost_orchid');
    expect(c.notes.some(n => n.includes('rare value'))).toBe(true);
    expect(c.summary).toContain('setosa: n=6');
    expect(c.summary).toContain('virginica: n=5');
  });

  it('open ECDF includes every group', () => {
    const c = compileChart({ kind: 'chart', mark: 'ecdf', column: 'sepal_len', groupBy: 'species' }, fixture, open());
    expect(c.traces.length).toBe(3);
    expect(JSON.stringify(c)).toContain('ghost_orchid');
  });

  it('private bar pools withheld values as an unlabeled bucket, totals honest', () => {
    const c = compileChart({ kind: 'chart', mark: 'bar', column: 'species' }, fixture, priv());
    expect(c.ticks!.text).toEqual(['setosa', 'virginica', '(rare values)']);
    expect(c.summary).toContain('(rare values): 1');
    expect(c.summary).not.toContain('ghost_orchid');
    expect(c.zeroBased).toBe(true);
  });
});

describe('compileChart — marks', () => {
  it('ecdf steps rise to 1', () => {
    const c = compileChart({ kind: 'chart', mark: 'ecdf', column: 'sepal_len' }, fixture, open());
    const t = c.traces[0];
    expect(t.line?.shape).toBe('hv');
    expect(t.y[t.y.length - 1]).toBe(1);
    expect(c.zeroBased).toBe(false);
  });

  it('histogram uses shared bins and reports counts that sum to n', () => {
    const c = compileChart({ kind: 'chart', mark: 'histogram', column: 'sepal_len', groupBy: 'species', bins: 5 }, fixture, open());
    expect(c.notes.some(n => n.includes('5 bins'))).toBe(true);
    const counts = [...c.summary.matchAll(/\[([\d, ]+)\]/g)]
      .map(m => m[1].split(',').reduce((s, v) => s + Number(v), 0));
    expect(counts.reduce((s, v) => s + v, 0)).toBe(12);
  });

  it('box computes quartiles and flags outliers as markers', () => {
    const withOutlier = table({ v: [1, 2, 3, 4, 5, 6, 7, 8, 50], g: Array.from({ length: 9 }, () => 'a') });
    const c = compileChart({ kind: 'chart', mark: 'box', column: 'v', groupBy: 'g' }, withOutlier, analysisProfileOf(withOutlier, policyFor('open')));
    const outlierTrace = c.traces.find(t => t.mode === 'markers');
    expect(outlierTrace?.y).toEqual([50]);
    expect(c.ticks).toEqual({ axis: 'x', vals: [0], text: ['a'] });
  });

  it('violin closes its polygon and marks the median', () => {
    const c = compileChart({ kind: 'chart', mark: 'violin', column: 'sepal_len', groupBy: 'species' }, fixture, priv());
    const fills = c.traces.filter(t => t.fill === 'toself');
    expect(fills.length).toBe(2);
    // one median tick per violin
    expect(c.traces.filter(t => t.showlegend === false).length).toBe(2);
  });

  it('qq summary describes deciles, not every value', () => {
    const c = compileChart({ kind: 'chart', mark: 'qq', column: 'sepal_len' }, fixture, open());
    expect(c.summary).toContain('deciles');
    expect(c.traces.some(t => t.line?.dash === 'dot')).toBe(true);
  });

  it('bar horizontal swaps axes; many categories tip toward horizontal', () => {
    const c = compileChart({ kind: 'chart', mark: 'bar', column: 'species', orientation: 'horizontal' }, fixture, open());
    expect(c.ticks!.axis).toBe('y');
    expect(c.xTitle).toBe('Count');
    const many = table({
      cat: Array.from({ length: 40 }, (_, i) => `category_${i % 10}`),
    });
    const cm = compileChart({ kind: 'chart', mark: 'bar', column: 'cat' }, many, analysisProfileOf(many, policyFor('open')));
    expect(cm.notes.some(n => n.includes('horizontal'))).toBe(true);
  });

  it('line aggregates per day with the requested agg and date axis', () => {
    const c = compileChart({ kind: 'chart', mark: 'line', column: 'sepal_len', x: 'when', groupBy: 'species', agg: 'mean' }, fixture, priv());
    expect(c.xIsDate).toBe(true);
    expect(c.traces.length).toBe(2); // ghost_orchid's day omitted with its group
    expect(c.summary).toContain('2024-01-01');
    const setosa = c.traces.find(t => t.name === 'setosa')!;
    expect(setosa.y[0]).toBeCloseTo(5.0, 10); // mean(5.1, 4.9) on day 1
  });
});
