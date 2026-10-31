import type { DataTable } from "../table";
import {
  EfaError,
  type EfaSpec,
  type EfaPreparedData,
  type OrdinalCategory,
} from "./types";

export function proposedCategories(
  values: unknown[],
): OrdinalCategory[] | null {
  const unique = [...new Set(values.filter((v) => v != null && v !== ""))];
  if (!unique.every((v) => typeof v === "number" && Number.isFinite(v)))
    return null;
  return (unique as number[]).sort((a, b) => a - b);
}
export function validateSpec(spec: EfaSpec) {
  if (
    !spec ||
    !Array.isArray(spec.items) ||
    typeof spec.label !== "string" ||
    !spec.label.trim() ||
    !spec.sample ||
    !["all", "development", "holdout"].includes(spec.sample.partition)
  )
    throw new EfaError(
      "spec",
      "Supply a run label, items and an explicit sample partition.",
    );
  const p = spec.items.length,
    k = spec.nFactors;
  if (p < 3 || p > 500)
    throw new EfaError("items", "Select between 3 and 500 ordered items.");
  if (!Number.isInteger(k) || k < 1 || k >= p || (p - k) ** 2 - p - k < 0)
    throw new EfaError(
      "identification",
      `${k} factors are underidentified for ${p} items. Reduce the factor count or add items.`,
    );
  if (
    !["pairwise", "complete"].includes(spec.missing) ||
    !["minres", "dwls", "wlsmv"].includes(spec.extraction ?? "minres") ||
    !["oblimin", "varimax", "promax"].includes(spec.rotation)
  )
    throw new EfaError("method", "Unsupported EFA method.");
  if (!Number.isSafeInteger(spec.seed))
    throw new EfaError("seed", "Use an integer seed.");
  if (new Set(spec.items.map((i) => i.column)).size !== p)
    throw new EfaError("items", "Selected items must be unique.");
  for (const item of spec.items) {
    if (
      item.categories.length < 2 ||
      item.categories.length > 65535 ||
      new Set(item.categories).size !== item.categories.length ||
      item.categories.some(
        (v) =>
          (typeof v !== "string" && typeof v !== "number") ||
          v === "" ||
          (typeof v === "number" && !Number.isFinite(v)),
      )
    )
      throw new EfaError(
        "category-order",
        `Specify a unique, explicit category order for ${item.column}.`,
      );
  }
}
export function prepareEfa(
  table: DataTable,
  spec: EfaSpec,
  eligibleRows: number[],
): EfaPreparedData {
  validateSpec(spec);
  if (
    new Set(eligibleRows).size !== eligibleRows.length ||
    eligibleRows.some((r) => !Number.isInteger(r) || r < 0 || r >= table.nRows)
  )
    throw new EfaError("rows", "Invalid fitting row membership.");
  const maps = spec.items.map(
    (item) =>
      new Map(
        item.categories.map((v, i) => [
          v,
          item.reverse ? item.categories.length - 1 - i : i,
        ]),
      ),
  );
  for (const item of spec.items)
    if (!table.columns.includes(item.column))
      throw new EfaError("column", `Item ${item.column} no longer exists.`);
  const rows =
    spec.missing === "complete"
      ? eligibleRows.filter((r) =>
          spec.items.every(
            (item) =>
              table.data[item.column][r] != null &&
              table.data[item.column][r] !== "",
          ),
        )
      : eligibleRows.slice();
  if (rows.length < 3)
    throw new EfaError(
      "sample",
      "Fewer than three eligible respondents remain.",
    );
  const n = rows.length,
    p = spec.items.length,
    codes = new Uint16Array(n * p),
    observed = new Uint8Array(n * p),
    means: number[] = [],
    sds: number[] = [],
    counts: number[][] = [];
  for (let j = 0; j < p; j++) {
    const item = spec.items[j],
      freq = Array(item.categories.length).fill(0);
    let mean = 0,
      m2 = 0,
      total = 0;
    for (let i = 0; i < n; i++) {
      const v = table.data[item.column][rows[i]];
      if (v == null || v === "") continue;
      const code = maps[j].get(v);
      if (code === undefined)
        throw new EfaError(
          "category-order",
          `Observed value ${String(v)} is absent from the category order for ${item.column}.`,
        );
      const at = j * n + i;
      codes[at] = code;
      observed[at] = 1;
      freq[code]++;
      total++;
      const delta = code + 1 - mean;
      mean += delta / total;
      m2 += delta * (code + 1 - mean);
    }
    if (freq.filter((x) => x > 0).length < 2)
      throw new EfaError(
        "constant",
        `${item.column} has fewer than two observed categories in this sample.`,
      );
    means.push(mean);
    sds.push(Math.sqrt(m2 / (total - 1)));
    counts.push(freq);
  }
  return {
    items: structuredClone(spec.items),
    nRows: n,
    originalRowCount: table.nRows,
    rows,
    codes,
    observed,
    means,
    sds,
    counts,
    diagnostics: [],
  };
}
