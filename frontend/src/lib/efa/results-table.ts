import type { EfaRun, ItemReview } from "./types";
import { compareEfaRuns } from "./compare";

/** Align only the displayed factor coordinates of a completed candidate.
 * Item order, the raw unrotated extraction, and provenance stay untouched.
 * Never persist, export, or score this view: use the original candidate for
 * those operations so its extraction and coordinate provenance stay intact. */
export function alignEfaDisplayRun(reference: EfaRun, candidate: EfaRun): EfaRun {
  const factors = reference.spec.nFactors;
  if (
    factors !== candidate.spec.nFactors ||
    factors < 1 ||
    !reference.spec.items.some((item) => candidate.spec.items.some((other) => other.column === item.column))
  ) return candidate;
  const { mapping, signs } = compareEfaRuns(reference, candidate);
  if (
    mapping.length !== factors ||
    mapping.some((index) => index === null) ||
    new Set(mapping).size !== factors
  ) return candidate;
  const order = mapping as number[];
  const columns = (matrix: number[][], signed: boolean) =>
    matrix.map((row) => order.map((index, factor) => row[index] * (signed ? signs[factor] : 1)));
  const square = (matrix: number[][], signed: boolean) =>
    order.map((row, a) => order.map((column, b) =>
      matrix[row][column] * (signed ? signs[a] * signs[b] : 1),
    ));
  const result = candidate.result;
  const weighted = result.weighted;
  const robust = weighted?.robust;
  return {
    ...candidate,
    result: {
      ...result,
      rotation: { ...result.rotation, pattern: columns(result.rotation.pattern, true), phi: square(result.rotation.phi, true) },
      structure: columns(result.structure, true),
      weights: columns(result.weights, true),
      ...(weighted ? {
        weighted: {
          ...weighted,
          ...(robust ? {
            robust: {
              ...robust,
              standardErrors: {
                ...robust.standardErrors,
                pattern: columns(robust.standardErrors.pattern, false),
                structure: columns(robust.standardErrors.structure, false),
                phi: square(robust.standardErrors.phi, false),
              },
            },
          } : {}),
        },
      } : {}),
    },
  };
}

export type EfaSortColumn =
  | "item"
  | "factor"
  | "gap"
  | "communality"
  | "uniqueness"
  | "related"
  | "review"
  | "note";

export interface EfaTableSort {
  column: EfaSortColumn;
  factorIndex?: number;
  direction: "asc" | "desc";
}

/** Separation of the strongest two pattern coefficients, regardless of sign. */
export function patternAbsGap(loadings: readonly number[]): number {
  if (!loadings.length || loadings.some((value) => !Number.isFinite(value)))
    return NaN;
  let first = 0;
  let second = 0;
  for (const loading of loadings) {
    const value = Math.abs(loading);
    if (value >= first) {
      second = first;
      first = value;
    } else if (value > second) second = value;
  }
  return first - second;
}

export interface RelatedEfaItem {
  index: number;
  column: string;
  r: number;
}

/** Lookup over the saved correlations; changing its scope does not refit them. */
export function strongestRelatedItem(
  run: Pick<EfaRun, "spec" | "result">,
  itemIndex: number,
  includedColumns?: ReadonlySet<string>,
): RelatedEfaItem | undefined {
  let strongest: RelatedEfaItem | undefined;
  const row = run.result.correlation.matrix[itemIndex];
  if (!row) return;
  for (let index = 0; index < run.spec.items.length; index++) {
    const column = run.spec.items[index].column;
    if (index === itemIndex || (includedColumns && !includedColumns.has(column)))
      continue;
    const r = row[index];
    if (!Number.isFinite(r)) continue;
    if (!strongest || Math.abs(r) > Math.abs(strongest.r))
      strongest = { index, column, r };
  }
  return strongest;
}

export interface EfaTableOptions {
  query?: string;
  sort?: EfaTableSort | null;
  view?: "pattern" | "structure";
  /** Factor-column sorting only; the displayed coefficients remain signed. */
  magnitude?: boolean;
  /** Restricts related-item candidates, not which rows appear in the table. */
  includedColumns?: ReadonlySet<string>;
  reviews?: Record<string, ItemReview>;
}

/** Return original row indices so every coefficient, SE, review and note stays
 * attached to its item. Neither the saved run nor its matrices are reordered. */
export function sortEfaItems(
  run: EfaRun,
  options: EfaTableOptions = {},
): number[] {
  const query = (options.query ?? "").toLocaleLowerCase();
  const indices = run.spec.items
    .map((_, index) => index)
    .filter((index) => run.spec.items[index].column.toLocaleLowerCase().includes(query));
  const sort = options.sort;
  if (!sort) return indices;
  const reviews = options.reviews ?? run.reviews;
  const factorValues = options.view === "structure"
    ? run.result.structure
    : run.result.rotation.pattern;
  const value = (index: number): number | string | undefined => {
    const column = run.spec.items[index].column;
    switch (sort.column) {
      case "item": return column;
      case "factor": {
        const loading = factorValues[index]?.[sort.factorIndex ?? 0];
        return options.magnitude === false ? loading : Math.abs(loading);
      }
      case "gap": return patternAbsGap(run.result.rotation.pattern[index]);
      case "communality": return run.result.communalities[index];
      case "uniqueness": return run.result.uniquenesses[index];
      case "related": {
        const related = strongestRelatedItem(run, index, options.includedColumns);
        return related ? Math.abs(related.r) : undefined;
      }
      case "review": {
        const status = reviews[column]?.status;
        return status === "retain" ? 1 : status === "investigate" ? 2 : status === "exclude" ? 3 : 0;
      }
      case "note": return reviews[column]?.note ?? "";
    }
  };
  const values = new Map(indices.map((index) => [index, value(index)]));
  const missing = (entry: number | string | undefined) =>
    entry === undefined || (typeof entry === "number" && !Number.isFinite(entry));
  return indices.sort((a, b) => {
    const av = values.get(a);
    const bv = values.get(b);
    // Unavailable estimates stay at the end in either direction.
    if (missing(av) || missing(bv))
      return missing(av) === missing(bv) ? a - b : missing(av) ? 1 : -1;
    const comparison = typeof av === "number" && typeof bv === "number"
      ? av - bv
      : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" });
    return comparison ? comparison * (sort.direction === "asc" ? 1 : -1) : a - b;
  });
}
