/** Bounded, aggregate-only projections for the assistant. Never return raw runs. */
import {
  EfaError,
  type EfaRun,
  type EfaImputationRun,
  type EfaResult,
} from "./types";
export type InspectableRun = EfaRun | EfaImputationRun;
export const isImputation = (run: InspectableRun): run is EfaImputationRun =>
  "fits" in run.result;
export function pageInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new EfaError("page", `Use an integer from ${minimum} to ${maximum}.`);
  return value;
}
export function requireAggregate(run: InspectableRun, privateMode: boolean) {
  if (!privateMode) return;
  const n = run.result.fittingRows.length;
  // Older saved imputations without original support metadata fail closed.
  const supported = isImputation(run)
    ? run.result.observedPairFloor === 5
    : run.result.correlation.pairs.every((p) => p.n >= 5);
  if (n < 5 || !supported)
    throw new EfaError(
      "privacy",
      "Original observed support is below the private aggregate floor or unavailable.",
    );
}
export function runMetadata(run: InspectableRun) {
  return {
    runId: run.id,
    label: run.spec.label,
    revision: run.revision,
    reviewRevision: run.reviewRevision ?? 0,
    parentId: run.parentId,
    parentReviewRevision: run.parentReviewRevision,
    type: isImputation(run) ? "mice" : "observed",
    extraction: run.spec.extraction ?? "minres",
    backend: run.spec.compute?.backend ?? "cpu",
    mvCorrection: run.spec.extraction === "wlsmv" ? run.spec.compute?.correction ?? "exact" : undefined,
    rotation: run.spec.rotation,
    missing: isImputation(run) ? "mice" : run.spec.missing,
    nItems: run.spec.items.length,
    nFactors: run.spec.nFactors,
    partition: run.spec.sample.partition,
    n: run.result.fittingRows.length,
    selected: run.spec.items.filter(
      (i) => run.reviews[i.column]?.status !== "exclude",
    ).length,
    revisedAfterHoldout: run.revisedAfterHoldout,
  };
}
export function inspectedFit(
  run: InspectableRun,
  imputation?: unknown,
): EfaResult {
  if (!isImputation(run)) {
    if (imputation !== undefined)
      throw new EfaError(
        "imputation",
        "An observed-data run has no imputations.",
      );
    return run.result;
  }
  const index =
    pageInteger(
      imputation,
      (run.result.fits[0]?.imputation ?? 0) + 1,
      1,
      run.result.requested,
    ) - 1;
  const fit = run.result.fits.find((f) => f.imputation === index);
  if (!fit)
    throw new EfaError(
      "imputation",
      "That imputation has no successful fit; failures remain in the local result.",
    );
  return fit.result;
}
export function runOverview(run: InspectableRun, privateMode: boolean) {
  requireAggregate(run, privateMode);
  const fit = isImputation(run) ? run.result.fits[0]?.result : run.result;
  return {
    ...runMetadata(run),
    ...(isImputation(run)
      ? {
          requested: run.result.requested,
          completed: run.result.completed,
          failureCount: run.result.failures.length,
          provisional: run.result.provisional,
          uncertainty:
            "Separate fits. Aligned between-imputation SD is descriptive, not a pooled standard error. No Rubin-pooled inference.",
        }
      : { kind: run.kind }),
    ...(fit
      ? {
          rmsr: fit.rmsr,
          convergence: fit.extraction.convergence,
          conditionNumber: fit.conditionNumber,
          improperItems: fit.uniquenesses.filter((v) => v < 0).length,
          boundaryItemCount: fit.extraction.boundaryItems.length,
          diagnosticCount: fit.diagnostics.length,
          // Free-text diagnostics can name rare response values; keep them local in private mode.
          diagnostics: privateMode
            ? undefined
            : fit.diagnostics.slice(0, 20).map((d) => ({
                code: d.code,
                message: d.message.slice(0, 500),
              })),
          weighted: fit.weighted
            ? {
                estimator: fit.weighted.estimator,
                rawStatistic: fit.weighted.rawStatistic,
                df: fit.weighted.df,
                correctedTest: fit.weighted.robust?.test,
                standardErrorsAvailable: !!fit.weighted.robust,
              }
            : undefined,
          engine: fit.provenance.engine,
          compute: fit.provenance.execution ? { backend: fit.provenance.execution.backend, precision: fit.provenance.execution.precision, selfCheck: fit.provenance.execution.selfCheck } : undefined,
        }
      : {}),
    readItemsWith: "get_efa_items (at most 20 items and 12 factors per page)",
  };
}
export function inspectItems(
  run: InspectableRun,
  args: Record<string, unknown>,
  privateMode: boolean,
) {
  requireAggregate(run, privateMode);
  const offset = pageInteger(args.offset, 0, 0, run.spec.items.length),
    limit = pageInteger(args.limit, 20, 1, 20),
    factorOffset = pageInteger(args.factorOffset, 0, 0, run.spec.nFactors - 1),
    factorLimit = pageInteger(args.factorLimit, 12, 1, 12),
    factors = Array.from(
      { length: Math.min(factorLimit, run.spec.nFactors - factorOffset) },
      (_, i) => i + factorOffset,
    ),
    summary = args.view === "imputation-summary";
  if (
    args.view !== undefined &&
    !["fit", "imputation-summary"].includes(String(args.view))
  )
    throw new EfaError("view", "Unknown item view.");
  if (summary && (!isImputation(run) || args.imputation !== undefined))
    throw new EfaError(
      "view",
      "The summary requires a MICE run and no individual imputation.",
    );
  const fit = inspectedFit(run, args.imputation),
    mi = isImputation(run) ? run.result : undefined;
  let indices = run.spec.items.map((_, i) => i);
  if (args.columns !== undefined) {
    if (
      !Array.isArray(args.columns) ||
      !args.columns.length ||
      args.columns.length > 20 ||
      new Set(args.columns).size !== args.columns.length ||
      args.columns.some((x) => typeof x !== "string")
    )
      throw new EfaError("items", "Name 1–20 unique items.");
    indices = args.columns.map((name) =>
      run.spec.items.findIndex((i) => i.column === name),
    );
    if (indices.some((i) => i < 0))
      throw new EfaError("items", "An item is not in this saved run.");
  }
  const sourceCount = indices.length;
  indices = indices.slice(offset, offset + limit);
  const values = (field: "pattern" | "structure", i: number) =>
    summary
      ? mi![field][i].map((v) => v.mean!)
      : (field === "pattern" ? fit.rotation.pattern : fit.structure)[i];
  const rows = indices.map((i) => {
    const pattern = values("pattern", i),
      order = pattern
        .map((v, f) => ({ factor: f + 1, loading: v, magnitude: Math.abs(v) }))
        .sort((a, b) => b.magnitude - a.magnitude);
    const correlations = run.spec.items
      .flatMap((item, j) =>
        i === j
          ? []
          : [
              {
                column: item.column,
                correlation: summary
                  ? mi!.fits.reduce(
                      (s, f) => s + f.result.correlation.matrix[i][j],
                      0,
                    ) / mi!.fits.length
                  : fit.correlation.matrix[i][j],
              },
            ],
      )
      .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation))
      .slice(0, 3);
    const review = run.reviews[run.spec.items[i].column] ?? {
      status: "retain",
      note: "",
    };
    const se = summary ? undefined : fit.weighted?.robust?.standardErrors;
    return {
      column: run.spec.items[i].column,
      status: review.status,
      ...(privateMode
        ? { hasLocalNote: !!review.note }
        : { note: review.note.slice(0, 2000) }),
      primary: order[0],
      nextLargest: order[1] ?? null,
      gap: order.length > 1 ? order[0].magnitude - order[1].magnitude : null,
      pattern: factors.map((f) => pattern[f]),
      structure: factors.map((f) => values("structure", i)[f]),
      communality: summary ? mi!.communalities[i] : fit.communalities[i],
      uniqueness: summary ? mi!.uniquenesses[i] : fit.uniquenesses[i],
      ...(summary
        ? {
            betweenImputation: {
              pattern: factors.map((f) => mi!.pattern[i][f]),
              structure: factors.map((f) => mi!.structure[i][f]),
            },
          }
        : {}),
      ...(se
        ? {
            standardErrors: {
              pattern: factors.map((f) => se.pattern[i][f]),
              structure: factors.map((f) => se.structure[i][f]),
              communality: se.communalities[i],
              uniqueness: se.uniquenesses[i],
            },
          }
        : {}),
      relatedItems: correlations,
    };
  });
  return {
    ...runMetadata(run),
    view: summary ? "aligned-imputation-summary" : "fit",
    imputation:
      mi && !summary
        ? ((args.imputation as number | undefined) ?? mi.fits[0].imputation + 1)
        : undefined,
    orientation: summary
      ? "Aligned to first successful imputation by signs/permutation"
      : "This fit's saved factor order and signs",
    interpretation:
      "Primary/next/gap use absolute pattern loadings across ALL factors, even when factor columns are paged. No threshold deletes or assigns an item. Related-item correlations are polychoric.",
    uncertainty: summary
      ? "Between-imputation dispersion, not a pooled SE; related correlations are descriptive means"
      : "Standard errors, when available, belong to this individual fit",
    totalItems: sourceCount,
    offset,
    nextOffset:
      offset + rows.length < sourceCount ? offset + rows.length : null,
    factors: factors.map((f) => f + 1),
    nextFactorOffset:
      factorOffset + factors.length < run.spec.nFactors
        ? factorOffset + factors.length
        : null,
    items: rows,
    factorCorrelations: factors.map((i) =>
      factors.map((j) => (summary ? mi!.phi[i][j] : fit.rotation.phi[i][j])),
    ),
  };
}
