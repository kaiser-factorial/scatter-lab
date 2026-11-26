/** Shared categorical colors from Themes/primary_theme, followed by darker
 * shades of the same four hues for larger categorical legends. */
export const PRIMARY_CHART_COLORS = [
  "#0045AD", // Blue
  "#EB1A26", // Red
  "#FFD600", // Yellow
  "#1A7A1A", // Green
  "#002B6B",
  "#A8111A",
  "#9B7F00",
  "#104D10",
] as const;

// Key the synthetic survey's labels to their colors, including on CSV reimport.
const surveyGenderColors = new Map<string, string>([
  ["Man", PRIMARY_CHART_COLORS[0]],
  ["Woman", PRIMARY_CHART_COLORS[1]],
  ["Nonbinary", PRIMARY_CHART_COLORS[2]],
  ["N/A", "#8a8a8a"],
]);

export function categoryColors(field: string, categories: readonly unknown[]): string[] {
  const surveyLabels = field === "Gender" && categories.every(value => surveyGenderColors.has(String(value)));
  return categories.map((value, i) => surveyLabels
    ? surveyGenderColors.get(String(value))!
    : value === "Noise" ? "#8a8a8a" : PRIMARY_CHART_COLORS[i % PRIMARY_CHART_COLORS.length]);
}

// The live legend and Plotly traces share both the stop positions and RGB colors.
export const CONTINUOUS_COLOR_SCALE: [number, string][] = [
  [0, "#440154"], [0.2, "#414487"], [0.4, "#2a788e"],
  [0.6, "#22a884"], [0.8, "#7ad151"], [1, "#fde725"],
];
export const CONTINUOUS_COLOR_GRADIENT = `linear-gradient(to right in srgb, ${CONTINUOUS_COLOR_SCALE.map(
  ([position, color]) => `${color} ${position * 100}%`,
).join(", ")})`;
