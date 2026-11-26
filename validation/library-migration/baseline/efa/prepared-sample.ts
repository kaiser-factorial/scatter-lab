import { EfaError, type EfaPreparedData } from "./types";

/** Recompute all fitting statistics after an explicit imputation or resample. */
export function preparedSample(
  source: EfaPreparedData,
  codes: Uint16Array,
  observed: Uint8Array,
  rows = source.rows,
  originalRowCount = source.originalRowCount,
): EfaPreparedData {
  const n = rows.length,
    p = source.items.length,
    means = Array(p).fill(0),
    sds = Array(p).fill(0),
    counts = source.items.map((item) => Array(item.categories.length).fill(0));
  if (codes.length !== n * p || observed.length !== codes.length)
    throw new EfaError("sample", "Invalid prepared response dimensions.");
  for (let j = 0; j < p; j++) {
    let count = 0;
    for (let i = 0; i < n; i++)
      if (observed[j * n + i]) {
        const c = codes[j * n + i];
        if (c >= counts[j].length)
          throw new EfaError("category", "Invalid resampled category.");
        counts[j][c]++;
        means[j] += c + 1;
        count++;
      }
    if (count < 2 || counts[j].filter((c) => c > 0).length < 2)
      throw new EfaError(
        "constant-item",
        `Item ${source.items[j].column} is constant or unobserved in this sample.`,
      );
    means[j] /= count;
    for (let i = 0; i < n; i++)
      if (observed[j * n + i]) sds[j] += (codes[j * n + i] + 1 - means[j]) ** 2;
    sds[j] = Math.sqrt(sds[j] / (count - 1));
  }
  return {
    ...source,
    fingerprint: undefined,
    codes,
    observed,
    rows: rows.slice(),
    nRows: n,
    originalRowCount,
    means,
    sds,
    counts,
  };
}
