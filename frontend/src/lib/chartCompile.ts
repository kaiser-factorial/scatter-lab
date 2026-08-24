import { asNumber, type DataTable } from './table';
import { MIN_BINS, type AnalysisProfile, type ChartPlan } from './analysisPlan';

// compileChart: one validated ChartPlan → drawable traces + the aggregate
// summary the assistant is allowed to see. ALL house policies live here (the
// harness's compile_spec shape): axis-zero rules, shared binning, orientation
// suggestions, group colouring.
//
// Every mark compiles to plain `scatter` traces — steps, polygons via
// fill:'toself' with null separators, markers — because the app ships only the
// gl3d Plotly bundle (no bar/box/violin trace types), and because computing
// the aggregates ourselves is the point: the drawn geometry IS the aggregate,
// so the summary handed to the model is read off the same numbers the user
// sees, never recomputed from raw rows.
//
// Data-mode rule: series and bars cover the profile's VISIBLE groups. Withheld
// values (private mode: identifier or rarer than the per-value floor) are
// pooled into one unlabeled "(rare values)" bucket for bar charts and omitted
// from grouped series with a note — on-screen and in the summary alike, so the
// two can never disagree about what exists (D8).

export type ChartTrace = {
  x: (number | null)[];
  y: (number | null)[];
  mode: 'lines' | 'markers' | 'lines+markers' | 'none';
  name?: string;
  fill?: 'toself';
  fillcolor?: string;
  line?: { color?: string; width?: number; shape?: 'hv'; dash?: 'dot' };
  marker?: { color?: string; size?: number; opacity?: number };
  showlegend?: boolean;
  hoverinfo?: 'text' | 'skip';
  text?: string[];
};

export type CompiledChart = {
  mark: ChartPlan['mark'];
  title: string;
  xTitle: string;
  yTitle: string;
  traces: ChartTrace[];
  /** Categorical axis labels, when one axis is categories at integer positions. */
  ticks?: { axis: 'x' | 'y'; vals: number[]; text: string[] };
  /** Zero-anchoring per house policy: bars yes, distributions no. */
  zeroBased: boolean;
  /** Line charts: x values are epoch-ms and the axis should render as dates. */
  xIsDate?: boolean;
  /** Footnotes shown under the chart (omitted rare values, binning, caveats). */
  notes: string[];
  /** The aggregate description returned to the assistant. */
  summary: string;
};

export const DEFAULT_CHART_COLORS = [
  '#4195DE', '#D23B72', '#FFD600', '#5F4690', '#1D6996',
  '#38A6A5', '#0F8554', '#73AF48', '#EDAD08', '#E17C05',
];

const withAlpha = (hex: string, alpha: number): string => {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
};

const round3 = (v: number) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------------------
// Small numeric helpers (quantiles, KDE, normal quantile, binning)
// ---------------------------------------------------------------------------

/** Linear-interpolated quantile of a SORTED array (R type 7). */
export const quantileSorted = (sorted: number[], q: number): number => {
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

/** Standard normal quantile by bisection on the CDF — slow-path only. */
export const normalQuantile = (p: number): number => {
  let lo = -10, hi = 10;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    // A&S 26.2.17 CDF, duplicated in statTests; kept local so the two modules
    // stay dependency-free of each other.
    const t = 1 / (1 + 0.2316419 * Math.abs(mid));
    const d = Math.exp(-mid * mid / 2) / Math.sqrt(2 * Math.PI);
    const poly = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    const cdf = mid >= 0 ? 1 - poly : poly;
    if (cdf < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
};

/** Gaussian KDE with Silverman's bandwidth, on a fixed grid. */
export const kde = (values: number[], gridN = 60): { grid: number[]; density: number[] } => {
  const n = values.length;
  const m = values.reduce((s, v) => s + v, 0) / n;
  const sd = n > 1 ? Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1)) : 0;
  const sorted = [...values].sort((a, b) => a - b);
  const iqr = quantileSorted(sorted, 0.75) - quantileSorted(sorted, 0.25);
  const spread = Math.min(sd || Infinity, iqr / 1.34 || Infinity);
  const h = spread > 0 && Number.isFinite(spread) ? 0.9 * spread * n ** -0.2 : 1;
  const lo = sorted[0] - 2 * h, hi = sorted[n - 1] + 2 * h;
  const grid: number[] = [], density: number[] = [];
  for (let i = 0; i < gridN; i++) {
    const x = lo + ((hi - lo) * i) / (gridN - 1);
    let acc = 0;
    for (const v of values) {
      const z = (x - v) / h;
      acc += Math.exp(-z * z / 2);
    }
    grid.push(x);
    density.push(acc / (n * h * Math.sqrt(2 * Math.PI)));
  }
  return { grid, density };
};

const sturgesBins = (n: number) => Math.max(MIN_BINS, Math.ceil(Math.log2(Math.max(2, n)) + 1));

// A closed rectangle as polygon points (for fill:'toself' bar/box geometry).
const rect = (x0: number, x1: number, y0: number, y1: number): { x: number[]; y: number[] } => ({
  x: [x0, x1, x1, x0, x0], y: [y0, y0, y1, y1, y0],
});

// Many disjoint polygons in ONE trace, separated by nulls.
const polysTrace = (
  polys: { x: number[]; y: number[] }[], color: string, name: string, texts?: string[],
): ChartTrace => {
  const x: (number | null)[] = [], y: (number | null)[] = [], text: string[] = [];
  polys.forEach((p, i) => {
    if (i > 0) { x.push(null); y.push(null); text.push(''); }
    x.push(...p.x); y.push(...p.y);
    for (let k = 0; k < p.x.length; k++) text.push(texts?.[i] ?? '');
  });
  return {
    x, y, mode: 'lines', name, fill: 'toself',
    fillcolor: withAlpha(color, 0.55), line: { color, width: 1 },
    hoverinfo: texts ? 'text' : 'skip', ...(texts ? { text } : {}),
  };
};

// ---------------------------------------------------------------------------
// Group extraction under the data-mode rule
// ---------------------------------------------------------------------------

type Cell = number | string | null | undefined;

type GroupSeries = { name: string; values: number[]; color: string };

// Numeric values of `col`, split by the plan's groupBy: one series per VISIBLE
// group, plus how many rows fell under withheld values (pooled, unnamed).
const seriesFor = (
  plan: ChartPlan, table: DataTable, profile: AnalysisProfile, palette: string[],
): { series: GroupSeries[]; withheldRows: number; notes: string[] } => {
  const vals = table.data[plan.column] ?? [];
  const notes: string[] = [];
  if (!plan.groupBy) {
    const values = (vals as Cell[]).map(asNumber).filter((v): v is number => v !== null);
    return { series: [{ name: plan.column, values, color: palette[0] }], withheldRows: 0, notes };
  }
  const groupCol = profile.columns.find(c => c.name === plan.groupBy);
  const visible = (groupCol?.groups ?? []).filter(g => !g.withheld).map(g => g.value);
  const withheldCount = (groupCol?.groups ?? []).filter(g => g.withheld).length;
  const byGroup = new Map<string, number[]>(visible.map(v => [v, []]));
  const gvals = table.data[plan.groupBy] ?? [];
  let withheldRows = 0;
  const n = Math.min(vals.length, gvals.length);
  for (let i = 0; i < n; i++) {
    const v = asNumber(vals[i]);
    if (v === null || gvals[i] == null) continue;
    const bucket = byGroup.get(String(gvals[i]));
    if (bucket) bucket.push(v); else withheldRows++;
  }
  if (withheldCount > 0) {
    notes.push(`${withheldCount} rare value(s) of ${plan.groupBy} (${withheldRows} rows) omitted under the dataset's privacy floor.`);
  }
  return {
    series: visible.map((name, i) => ({ name, values: byGroup.get(name)!, color: palette[i % palette.length] }))
      .filter(s => s.values.length > 0),
    withheldRows, notes,
  };
};

const seriesSummary = (series: GroupSeries[]): string =>
  series.map(s => {
    const sorted = [...s.values].sort((a, b) => a - b);
    const q = (p: number) => round3(quantileSorted(sorted, p));
    return `${s.name}: n=${s.values.length}, min=${q(0)}, q1=${q(0.25)}, median=${q(0.5)}, q3=${q(0.75)}, max=${q(1)}`;
  }).join('\n');

// ---------------------------------------------------------------------------
// The compiler
// ---------------------------------------------------------------------------

export const compileChart = (
  plan: ChartPlan, table: DataTable, profile: AnalysisProfile,
  palette: string[] = DEFAULT_CHART_COLORS,
): CompiledChart => {
  switch (plan.mark) {
    case 'ecdf': return compileEcdf(plan, table, profile, palette);
    case 'histogram': return compileHistogram(plan, table, profile, palette);
    case 'box': return compileBoxOrViolin(plan, table, profile, palette, 'box');
    case 'violin': return compileBoxOrViolin(plan, table, profile, palette, 'violin');
    case 'qq': return compileQq(plan, table, profile, palette);
    case 'bar': return compileBar(plan, table, profile, palette);
    case 'line': return compileLine(plan, table, profile, palette);
  }
};

const compileEcdf = (
  plan: ChartPlan, table: DataTable, profile: AnalysisProfile, palette: string[],
): CompiledChart => {
  const { series, notes } = seriesFor(plan, table, profile, palette);
  const traces: ChartTrace[] = series.map(s => {
    const sorted = [...s.values].sort((a, b) => a - b);
    return {
      x: sorted, y: sorted.map((_, i) => (i + 1) / sorted.length),
      mode: 'lines' as const, name: `${s.name} (n=${s.values.length})`,
      line: { color: s.color, width: 2, shape: 'hv' as const },
    };
  });
  return {
    mark: 'ecdf',
    title: plan.groupBy ? `Cumulative distribution of ${plan.column} by ${plan.groupBy}` : `Cumulative distribution of ${plan.column}`,
    xTitle: plan.column, yTitle: 'Cumulative proportion',
    traces, zeroBased: false, notes,
    summary: `ECDF of ${plan.column}${plan.groupBy ? ` by ${plan.groupBy}` : ''}. Per-group five-number summaries:\n${seriesSummary(series)}`,
  };
};

const compileHistogram = (
  plan: ChartPlan, table: DataTable, profile: AnalysisProfile, palette: string[],
): CompiledChart => {
  const { series, notes } = seriesFor(plan, table, profile, palette);
  const all = series.flatMap(s => s.values);
  const lo = Math.min(...all), hi = Math.max(...all);
  const nBins = plan.bins ?? sturgesBins(all.length);
  // SHARED edges across groups — per-group binning makes overlaid histograms
  // incomparable, the classic way this chart lies.
  const width = hi > lo ? (hi - lo) / nBins : 1;
  const countsOf = (values: number[]): number[] => {
    const counts = new Array<number>(nBins).fill(0);
    for (const v of values) counts[Math.min(nBins - 1, Math.floor((v - lo) / width))]++;
    return counts;
  };
  const binLines: string[] = [];
  const traces = series.map(s => {
    const counts = countsOf(s.values);
    binLines.push(`${s.name}: [${counts.join(', ')}]`);
    const polys = counts.map((c, b) => rect(lo + b * width, lo + (b + 1) * width, 0, c));
    const texts = counts.map((c, b) => `${s.name}: ${round3(lo + b * width)}–${round3(lo + (b + 1) * width)}, n=${c}`);
    const t = polysTrace(polys.filter((_, b) => counts[b] > 0), s.color, `${s.name} (n=${s.values.length})`, texts.filter((_, b) => counts[b] > 0));
    if (series.length > 1) t.fillcolor = withAlpha(s.color, 0.4);
    return t;
  });
  notes.push(`${nBins} bins of width ${round3(width)}, shared across groups.`);
  return {
    mark: 'histogram',
    title: plan.groupBy ? `Distribution of ${plan.column} by ${plan.groupBy}` : `Distribution of ${plan.column}`,
    xTitle: plan.column, yTitle: 'Count',
    traces, zeroBased: true, notes,
    summary: `Histogram of ${plan.column}${plan.groupBy ? ` by ${plan.groupBy}` : ''}: ${nBins} bins of width ${round3(width)} from ${round3(lo)}. Counts per bin:\n${binLines.join('\n')}`,
  };
};

const compileBoxOrViolin = (
  plan: ChartPlan, table: DataTable, profile: AnalysisProfile, palette: string[],
  kind: 'box' | 'violin',
): CompiledChart => {
  const { series, notes } = seriesFor(plan, table, profile, palette);
  const traces: ChartTrace[] = [];
  const HALF = 0.32;
  series.forEach((s, i) => {
    const sorted = [...s.values].sort((a, b) => a - b);
    const q1 = quantileSorted(sorted, 0.25), med = quantileSorted(sorted, 0.5), q3 = quantileSorted(sorted, 0.75);
    if (kind === 'violin' && sorted.length > 1) {
      const { grid, density } = kde(s.values);
      const peak = Math.max(...density);
      const scale = peak > 0 ? HALF / peak : 0;
      const xs = [...grid.map((_, k) => i - density[k] * scale), ...grid.map((_, k) => i + density[grid.length - 1 - k] * scale)];
      const ys = [...grid, ...[...grid].reverse()];
      traces.push({
        x: xs, y: ys, mode: 'lines', name: `${s.name} (n=${s.values.length})`,
        fill: 'toself', fillcolor: withAlpha(s.color, 0.45), line: { color: s.color, width: 1 }, hoverinfo: 'skip',
      });
      // Median tick inside the violin
      traces.push({
        x: [i - HALF / 2, i + HALF / 2], y: [med, med], mode: 'lines',
        line: { color: s.color, width: 2 }, showlegend: false, hoverinfo: 'skip',
      });
    } else {
      const iqr = q3 - q1;
      const loFence = q1 - 1.5 * iqr, hiFence = q3 + 1.5 * iqr;
      const inliers = sorted.filter(v => v >= loFence && v <= hiFence);
      const wLo = inliers[0] ?? q1, wHi = inliers[inliers.length - 1] ?? q3;
      const outliers = sorted.filter(v => v < loFence || v > hiFence);
      traces.push(polysTrace([rect(i - HALF, i + HALF, q1, q3)], s.color, `${s.name} (n=${s.values.length})`,
        [`${s.name}: q1=${round3(q1)}, median=${round3(med)}, q3=${round3(q3)}`]));
      traces.push({
        // whiskers with caps + median line, as one lines trace with gaps
        x: [i, i, null, i - HALF / 2, i + HALF / 2, null, i, i, null, i - HALF / 2, i + HALF / 2, null, i - HALF, i + HALF],
        y: [q3, wHi, null, wHi, wHi, null, q1, wLo, null, wLo, wLo, null, med, med],
        mode: 'lines', line: { color: s.color, width: 2 }, showlegend: false, hoverinfo: 'skip',
      });
      if (outliers.length) {
        traces.push({
          x: outliers.map(() => i), y: outliers, mode: 'markers',
          marker: { color: s.color, size: 5, opacity: 0.7 }, showlegend: false,
          hoverinfo: 'text', text: outliers.map(v => `${s.name} outlier: ${round3(v)}`),
        });
      }
    }
  });
  const what = kind === 'box' ? 'Box plot' : 'Violin plot';
  return {
    mark: kind,
    title: plan.groupBy ? `${what} of ${plan.column} by ${plan.groupBy}` : `${what} of ${plan.column}`,
    xTitle: plan.groupBy ?? '', yTitle: plan.column,
    traces, zeroBased: false, notes,
    ticks: { axis: 'x', vals: series.map((_, i) => i), text: series.map(s => s.name) },
    summary: `${what} of ${plan.column}${plan.groupBy ? ` by ${plan.groupBy}` : ''}. Five-number summaries:\n${seriesSummary(series)}`,
  };
};

const compileQq = (
  plan: ChartPlan, table: DataTable, profile: AnalysisProfile, palette: string[],
): CompiledChart => {
  const { series, notes } = seriesFor(plan, table, profile, palette);
  const traces: ChartTrace[] = [];
  const summaryLines: string[] = [];
  for (const s of series) {
    const sorted = [...s.values].sort((a, b) => a - b);
    const n = sorted.length;
    const theo = sorted.map((_, i) => normalQuantile((i + 0.5) / n));
    traces.push({
      x: theo, y: sorted, mode: 'markers', name: `${s.name} (n=${n})`,
      marker: { color: s.color, size: 5, opacity: 0.75 },
    });
    // Reference line through the quartiles — the qqline convention, robust to tails.
    const [tq1, tq3] = [normalQuantile(0.25), normalQuantile(0.75)];
    const [sq1, sq3] = [quantileSorted(sorted, 0.25), quantileSorted(sorted, 0.75)];
    const slope = (sq3 - sq1) / (tq3 - tq1);
    const intercept = sq1 - slope * tq1;
    const xEnds = [theo[0], theo[theo.length - 1]];
    traces.push({
      x: xEnds, y: xEnds.map(x => intercept + slope * x), mode: 'lines',
      line: { color: s.color, width: 1, dash: 'dot' }, showlegend: false, hoverinfo: 'skip',
    });
    // Deciles only — the summary describes the SHAPE without echoing every value.
    const deciles = Array.from({ length: 9 }, (_, k) => `${(k + 1) * 10}%: ${round3(quantileSorted(sorted, (k + 1) / 10))}`);
    summaryLines.push(`${s.name} (n=${n}) deciles — ${deciles.join(', ')}`);
  }
  return {
    mark: 'qq',
    title: plan.groupBy ? `Normal Q–Q of ${plan.column} by ${plan.groupBy}` : `Normal Q–Q of ${plan.column}`,
    xTitle: 'Theoretical quantiles (normal)', yTitle: plan.column,
    traces, zeroBased: false, notes,
    summary: `Normal Q–Q of ${plan.column}${plan.groupBy ? ` by ${plan.groupBy}` : ''} (straightness = normality; read curvature at the ends as tail weight).\n${summaryLines.join('\n')}`,
  };
};

const compileBar = (
  plan: ChartPlan, table: DataTable, profile: AnalysisProfile, palette: string[],
): CompiledChart => {
  const col = profile.columns.find(c => c.name === plan.column);
  const visible = (col?.groups ?? []).filter(g => !g.withheld);
  const withheld = (col?.groups ?? []).filter(g => g.withheld);
  const labels = visible.map(g => g.value);
  const counts = visible.map(g => g.n);
  const notes: string[] = [];
  if (withheld.length > 0) {
    // Pooled and unlabeled: the total stays honest without naming what the
    // profile withholds.
    labels.push('(rare values)');
    counts.push(withheld.reduce((s, g) => s + g.n, 0));
    notes.push(`${withheld.length} rare value(s) pooled into "(rare values)" under the dataset's privacy floor.`);
  }
  const horizontal = plan.orientation === 'horizontal';
  if (!plan.orientation && labels.length > 8) {
    notes.push('Tip: with this many categories, orientation:"horizontal" reads better.');
  }
  const W = 0.38;
  const polys = counts.map((c, i) => (horizontal ? rect(0, c, i - W, i + W) : rect(i - W, i + W, 0, c)));
  const texts = labels.map((l, i) => `${l}: n=${counts[i]}`);
  const trace = polysTrace(polys, palette[0], plan.column, texts);
  trace.showlegend = false;
  return {
    mark: 'bar',
    title: `Counts of ${plan.column}`,
    xTitle: horizontal ? 'Count' : plan.column,
    yTitle: horizontal ? plan.column : 'Count',
    traces: [trace], zeroBased: true, notes,
    ticks: { axis: horizontal ? 'y' : 'x', vals: labels.map((_, i) => i), text: labels },
    summary: `Bar chart of ${plan.column} (${horizontal ? 'horizontal' : 'vertical'}): ${labels.map((l, i) => `${l}: ${counts[i]}`).join(', ')}.`,
  };
};

const compileLine = (
  plan: ChartPlan, table: DataTable, profile: AnalysisProfile, palette: string[],
): CompiledChart => {
  const agg = plan.agg ?? 'mean';
  const xs = table.data[plan.x!] ?? [];
  const ys = table.data[plan.column] ?? [];
  const groupCol = plan.groupBy ? profile.columns.find(c => c.name === plan.groupBy) : undefined;
  const visible = new Set((groupCol?.groups ?? []).filter(g => !g.withheld).map(g => g.value));
  const withheldCount = (groupCol?.groups ?? []).filter(g => g.withheld).length;
  const gvals = plan.groupBy ? table.data[plan.groupBy] ?? [] : [];

  // Aggregate per DAY (UTC), per group. Sub-day resolution is out of scope for
  // v1: EDA line charts of survey/time data almost always want the day grain,
  // and one deterministic rule beats a heuristic that guesses the grain wrong.
  const buckets = new Map<string, Map<number, number[]>>();
  const n = Math.min(xs.length, ys.length);
  let dropped = 0;
  for (let i = 0; i < n; i++) {
    const t = typeof xs[i] === 'string' ? Date.parse(xs[i] as string) : NaN;
    const v = asNumber(ys[i]);
    if (!Number.isFinite(t) || v === null) { dropped++; continue; }
    let g = plan.column;
    if (plan.groupBy) {
      if (gvals[i] == null || !visible.has(String(gvals[i]))) continue;
      g = String(gvals[i]);
    }
    const day = Math.floor(t / 86_400_000) * 86_400_000;
    if (!buckets.has(g)) buckets.set(g, new Map());
    const m = buckets.get(g)!;
    if (!m.has(day)) m.set(day, []);
    m.get(day)!.push(v);
  }
  const aggregate = (vals: number[]): number => {
    if (agg === 'count') return vals.length;
    if (agg === 'sum') return vals.reduce((s, v) => s + v, 0);
    if (agg === 'median') return quantileSorted([...vals].sort((a, b) => a - b), 0.5);
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  };
  const notes: string[] = [`Aggregated per day (${agg}).`];
  if (withheldCount > 0) notes.push(`${withheldCount} rare value(s) of ${plan.groupBy} omitted under the dataset's privacy floor.`);
  if (dropped > 0) notes.push(`${dropped} row(s) skipped (unparseable date or non-numeric value).`);
  const groupNames = [...buckets.keys()];
  const summaryLines: string[] = [];
  const traces: ChartTrace[] = groupNames.map((g, i) => {
    const days = [...buckets.get(g)!.keys()].sort((a, b) => a - b);
    const points = days.map(d => aggregate(buckets.get(g)!.get(d)!));
    summaryLines.push(`${g}: ${days.length} day(s), ${days.map((d, k) => `${new Date(d).toISOString().slice(0, 10)}=${round3(points[k])}`).join(', ')}`);
    return {
      x: days, y: points, mode: 'lines+markers' as const,
      name: g, line: { color: palette[i % palette.length], width: 2 },
      marker: { color: palette[i % palette.length], size: 5 },
    };
  });
  return {
    mark: 'line',
    title: `${agg} of ${plan.column} over ${plan.x}${plan.groupBy ? ` by ${plan.groupBy}` : ''}`,
    xTitle: plan.x!, yTitle: `${agg}(${plan.column})`,
    traces, zeroBased: false, xIsDate: true, notes,
    summary: `Line chart: daily ${agg} of ${plan.column} over ${plan.x}${plan.groupBy ? ` by ${plan.groupBy}` : ''}.\n${summaryLines.join('\n')}`,
  };
};
