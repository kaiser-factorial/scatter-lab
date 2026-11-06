import type { DataTable } from './table';

export type BreakdownDirection = 'cluster' | 'group';
export type BreakdownSection = { total: number; counts: Record<string, number> };
export type ClusterCrosstab = {
  byCluster: Record<string, BreakdownSection>;
  byGroup: Record<string, BreakdownSection>;
};

export const sortClusterLabels = (a: string, b: string) => {
  if (a === 'Noise') return 1;
  if (b === 'Noise') return -1;
  return a.localeCompare(b, undefined, { numeric: true });
};

export const buildClusterCrosstab = (table: DataTable, attribute: string): ClusterCrosstab | null => {
  const clusterCol = table.data.Cluster;
  const attrVals = table.data[attribute];
  if (!clusterCol || !attrVals) return null;

  const byCluster: Record<string, BreakdownSection> = {};
  const byGroup: Record<string, BreakdownSection> = {};
  for (let i = 0; i < table.nRows; i++) {
    const cluster = String(clusterCol[i] ?? 'N/A');
    const group = String(attrVals[i] ?? 'N/A');
    const clusterSection = (byCluster[cluster] ??= { total: 0, counts: {} });
    clusterSection.total++;
    clusterSection.counts[group] = (clusterSection.counts[group] || 0) + 1;
    const groupSection = (byGroup[group] ??= { total: 0, counts: {} });
    groupSection.total++;
    groupSection.counts[cluster] = (groupSection.counts[cluster] || 0) + 1;
  }
  return { byCluster, byGroup };
};

export type ClusterHeatmap = {
  rowLabels: string[];
  columnLabels: string[];
  percentages: number[][];
  counts: number[][];
  denominatorLabel: 'cluster' | 'group';
};

export const buildClusterHeatmap = (crosstab: ClusterCrosstab, direction: BreakdownDirection): ClusterHeatmap => {
  const sections = direction === 'cluster' ? crosstab.byCluster : crosstab.byGroup;
  const rowLabels = direction === 'cluster'
    ? Object.keys(sections).sort(sortClusterLabels)
    : Object.keys(sections).sort((a, b) => sections[b].total - sections[a].total || a.localeCompare(b));
  const columnLabels = Array.from(new Set(Object.values(sections).flatMap(section => Object.keys(section.counts))))
    .sort(direction === 'cluster' ? (a, b) => a.localeCompare(b, undefined, { numeric: true }) : sortClusterLabels);

  const counts = rowLabels.map(row => columnLabels.map(column => sections[row].counts[column] || 0));
  const percentages = rowLabels.map((row, i) =>
    counts[i].map(count => sections[row].total ? (count / sections[row].total) * 100 : 0)
  );
  return { rowLabels, columnLabels, percentages, counts, denominatorLabel: direction };
};

export const HEATMAP_PALETTES = ['PrimaryBlue', 'Viridis', 'Inferno', 'Greens'] as const;
export type HeatmapPalette = typeof HEATMAP_PALETTES[number];

const PALETTE_STOPS: Record<HeatmapPalette, string[]> = {
  PrimaryBlue: ['#FFFFFF', '#0045AD'],
  Viridis: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
  Inferno: ['#000004', '#420a68', '#932667', '#dd513a', '#fba40a', '#fcffa4'],
  Greens: ['#f7fcf5', '#c7e9c0', '#74c476', '#238b45', '#00441b'],
};

const hexToRgb = (hex: string) => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
] as const;

const paletteColor = (palette: HeatmapPalette, value: number) => {
  const stops = PALETTE_STOPS[palette].map(hexToRgb);
  const scaled = Math.max(0, Math.min(1, value / 100)) * (stops.length - 1);
  const index = Math.min(Math.floor(scaled), stops.length - 2);
  const t = scaled - index;
  const from = stops[index], to = stops[index + 1];
  const rgb = from.map((channel, i) => Math.round(channel + (to[i] - channel) * t));
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
};

const textColorFor = (color: string) => {
  const rgb = color.match(/\d+/g)?.map(Number) ?? [255, 255, 255];
  const luminance = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  return luminance > 0.56 ? '#111111' : '#ffffff';
};

const cropText = (ctx: CanvasRenderingContext2D, text: string, maxWidth: number) => {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1);
  return `${out}…`;
};

const safeFilename = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export const downloadClusterHeatmapPng = async ({
  heatmap,
  attribute,
  palette,
}: {
  heatmap: ClusterHeatmap;
  attribute: string;
  palette: HeatmapPalette;
}) => {
  const rowCount = heatmap.rowLabels.length;
  const columnCount = heatmap.columnLabels.length;
  if (!rowCount || !columnCount) throw new Error('No composition values are available to export.');

  const left = 168;
  const top = 118;
  // Reserve a slim right-hand scale so the image remains interpretable after
  // it leaves the app (for example, in a slide or manuscript).
  const right = 94;
  const bottom = 42;
  const width = Math.min(2600, Math.max(760, left + right + columnCount * 96));
  const cellWidth = (width - left - right) / columnCount;
  const cellHeight = 56;
  const height = top + bottom + rowCount * cellHeight;
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Your browser could not create the heatmap image.');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#111111';
  ctx.font = '700 19px sans-serif';
  ctx.fillText(`Cluster composition by ${attribute}`, 28, 32);
  ctx.fillStyle = '#555555';
  ctx.font = '12px sans-serif';
  ctx.fillText(`% of ${heatmap.denominatorLabel} · each cell shows percentage and count · ${palette}`, 28, 53);

  ctx.font = '600 11px sans-serif';
  ctx.fillStyle = '#444444';
  heatmap.columnLabels.forEach((label, column) => {
    const x = left + column * cellWidth + 6;
    ctx.fillText(cropText(ctx, label, cellWidth - 12), x, top - 15);
  });

  heatmap.rowLabels.forEach((label, row) => {
    const y = top + row * cellHeight;
    ctx.fillStyle = '#333333';
    ctx.font = '600 12px sans-serif';
    ctx.fillText(cropText(ctx, label, left - 14), 24, y + 29);
    heatmap.columnLabels.forEach((_, column) => {
      const x = left + column * cellWidth;
      const percentage = heatmap.percentages[row][column];
      const count = heatmap.counts[row][column];
      const fill = paletteColor(palette, percentage);
      ctx.fillStyle = fill;
      ctx.fillRect(x, y, cellWidth - 1, cellHeight - 1);
      ctx.fillStyle = textColorFor(fill);
      ctx.font = '700 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${Math.round(percentage)}%`, x + cellWidth / 2, y + 25);
      ctx.font = '11px sans-serif';
      ctx.fillText(`n=${count}`, x + cellWidth / 2, y + 42);
      ctx.textAlign = 'start';
    });
  });

  // A continuous 0–100% colour-scale legend. Draw small horizontal strips so
  // it exactly uses the same interpolated palette as the heatmap cells.
  const legendX = width - right + 20;
  const legendWidth = 16;
  const legendY = top;
  const legendHeight = rowCount * cellHeight;
  for (let step = 0; step < legendHeight; step++) {
    const value = 100 - (step / Math.max(legendHeight - 1, 1)) * 100;
    ctx.fillStyle = paletteColor(palette, value);
    ctx.fillRect(legendX, legendY + step, legendWidth, 1);
  }
  ctx.strokeStyle = '#777777';
  ctx.lineWidth = 1;
  ctx.strokeRect(legendX, legendY, legendWidth, legendHeight);
  ctx.fillStyle = '#444444';
  ctx.font = '600 10px sans-serif';
  ctx.fillText('%', legendX, legendY - 15);
  ctx.font = '10px sans-serif';
  ctx.fillText('100%', legendX + legendWidth + 6, legendY + 8);
  ctx.fillText('0%', legendX + legendWidth + 6, legendY + legendHeight);

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(value => value ? resolve(value) : reject(new Error('The heatmap image could not be encoded.')), 'image/png')
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `cluster_composition_${safeFilename(attribute)}_${heatmap.denominatorLabel}_${palette.toLowerCase()}.png`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};
