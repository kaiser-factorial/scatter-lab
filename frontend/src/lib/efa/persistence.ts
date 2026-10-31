import type { EfaState } from "./types";
import { validateSpec } from "./prepare";
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
export function validateEfaState(value: unknown, nRows: number) {
  if (value == null) return;
  const fail = () => {
    throw new Error("Workspace file is damaged: invalid EFA state.");
  };
  if (
    !record(value) ||
    !Array.isArray(value.runs) ||
    !Array.isArray(value.splits)
  )
    return fail();
  const rows = (v: unknown) =>
    Array.isArray(v) &&
    v.every((i) => Number.isInteger(i) && i >= 0 && i < nRows) &&
    new Set(v).size === v.length;
  const matrix = (v: unknown, p: number, k: number) =>
    Array.isArray(v) &&
    v.length === p &&
    v.every(
      (row) =>
        Array.isArray(row) &&
        row.length === k &&
        row.every((x) => typeof x === "number" && Number.isFinite(x)),
    );
  const numeric = (v: unknown, p: number) =>
    Array.isArray(v) &&
    v.length === p &&
    v.every((x) => typeof x === "number" && Number.isFinite(x));
  const ids = new Set<string>();
  for (const s of value.splits) {
    if (
      !record(s) ||
      typeof s.id !== "string" ||
      ids.has(s.id) ||
      !rows(s.development) ||
      !rows(s.holdout) ||
      !rows(s.eligible)
    )
      return fail();
    const d = new Set(s.development as number[]);
    if ((s.holdout as number[]).some((r) => d.has(r))) return fail();
    ids.add(s.id);
  }
  ids.clear();
  if (value.parallelRuns !== undefined) {
    if (!Array.isArray(value.parallelRuns)) return fail();
    for (const simulation of value.parallelRuns) {
      if (
        !record(simulation) ||
        typeof simulation.id !== "string" ||
        !record(simulation.spec) ||
        !record(simulation.result) ||
        !rows(simulation.eligibleRows)
      )
        return fail();
      const s = simulation as unknown as NonNullable<
        EfaState["parallelRuns"]
      >[number];
      try {
        validateSpec(s.spec);
      } catch {
        return fail();
      }
      const p = s.spec.items.length,
        r = s.result;
      if (
        !numeric(r.observed, p) ||
        !Array.isArray(r.reference) ||
        r.reference.length !== p ||
        r.reference.some((v) => v !== null && !Number.isFinite(v)) ||
        !Array.isArray(r.nullEigenvalues) ||
        !r.nullEigenvalues.every((v) => numeric(v, p)) ||
        !Array.isArray(r.failures) ||
        r.failures.some((f) => !f || typeof f.error !== "string") ||
        !Number.isInteger(r.completed) ||
        r.completed !== r.nullEigenvalues.length
      )
        return fail();
    }
  }
  for (const v of value.runs) {
    if (
      !record(v) ||
      typeof v.id !== "string" ||
      ids.has(v.id) ||
      !record(v.spec) ||
      !record(v.result) ||
      !record(v.reviews) ||
      !rows(v.eligibleRows) ||
      !Array.isArray(v.scoreColumns) ||
      v.scoreColumns.some((x) => typeof x !== "string")
    )
      return fail();
    const run = v as unknown as EfaState["runs"][number];
    if (
      typeof run.spec.label !== "string" ||
      !Number.isInteger(run.revision) ||
      run.revision < 1 ||
      typeof run.createdAt !== "string" ||
      typeof run.datasetRevision !== "string"
    )
      return fail();
    try {
      validateSpec(run.spec);
    } catch {
      return fail();
    }
    if (
      !record(run.spec.sample) ||
      !["all", "development", "holdout"].includes(run.spec.sample.partition)
    )
      return fail();
    const p = run.spec.items.length,
      k = run.spec.nFactors,
      r = run.result;
    if (
      !rows(r.fittingRows) ||
      r.originalRowCount !== nRows ||
      !r.rotation ||
      !r.correlation ||
      !r.extraction ||
      !r.provenance ||
      !Array.isArray(r.diagnostics) ||
      !Array.isArray(r.categoryCounts) ||
      !Array.isArray(r.correlation.pairs) ||
      r.correlation.pairs.length !== (p * (p - 1)) / 2
    )
      return fail();
    if (
      !matrix(r.rotation.pattern, p, k) ||
      !matrix(r.rotation.phi, k, k) ||
      !matrix(r.structure, p, k) ||
      !matrix(r.weights, p, k) ||
      !matrix(r.extraction.loadings, p, k) ||
      !matrix(r.correlation.matrix, p, p) ||
      !matrix(r.residuals, p, p) ||
      !matrix(r.reproduced, p, p) ||
      !numeric(r.means, p) ||
      !numeric(r.sds, p) ||
      !numeric(r.communalities, p) ||
      !numeric(r.uniquenesses, p) ||
      !numeric(r.correlation.counts, p)
    )
      return fail();
    if (
      r.correlation.pairs.some(
        (pair) =>
          !pair ||
          !Number.isInteger(pair.i) ||
          !Number.isInteger(pair.j) ||
          pair.i < 0 ||
          pair.j >= p ||
          pair.i >= pair.j ||
          !Number.isFinite(pair.rho) ||
          !Number.isInteger(pair.n) ||
          pair.n < 0 ||
          !Array.isArray(pair.thresholdsX) ||
          !Array.isArray(pair.thresholdsY),
      )
    )
      return fail();
    if (
      !Number.isFinite(r.rmsr) ||
      r.diagnostics.some(
        (d) =>
          !d || typeof d.code !== "string" || typeof d.message !== "string",
      )
    )
      return fail();
    if (
      Object.values(run.reviews).some(
        (review) =>
          !review ||
          !["retain", "investigate", "exclude"].includes(review.status) ||
          typeof review.note !== "string",
      )
    )
      return fail();
    ids.add(run.id);
  }
}
