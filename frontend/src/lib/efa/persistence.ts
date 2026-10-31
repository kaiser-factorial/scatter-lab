import type { EfaState } from "./types";
import { validateSpec } from "./prepare";
import { validateMiceOptions } from "./mice";
import { validateStability } from "./stability";
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
  const reviewRevision = (v: unknown) =>
    v === undefined ||
    (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
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
      !reviewRevision(v.reviewRevision) ||
      !reviewRevision(v.parentReviewRevision) ||
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
    const estimator = run.spec.extraction ?? "minres";
    if (
      (r.extraction.estimator ?? "minres") !==
      (estimator === "minres" ? "minres" : "dwls")
    )
      return fail();
    if (estimator === "minres" && r.weighted !== undefined) return fail();
    if (estimator !== "minres") {
      const w = r.weighted,
        m = (p * (p - 1)) / 2,
        q = p * k - (k * (k - 1)) / 2,
        df = m - q,
        n = r.fittingRows.length;
      if (
        !record(w) ||
        w.estimator !== estimator ||
        !numeric(w.samplingVariances, m) ||
        !numeric(w.fittingWeights, m) ||
        w.samplingVariances.some((v) => v <= 0) ||
        w.fittingWeights.some(
          (v, i) => v <= 0 || Math.abs(v * w.samplingVariances[i] - 1) > 1e-8,
        ) ||
        typeof w.uncertaintyMethod !== "string" ||
        !Number.isFinite(w.rawStatistic) ||
        w.rawStatistic < 0 ||
        w.df !== df
      )
        return fail();
      if (estimator === "dwls" && w.robust !== undefined) return fail();
      if (estimator === "wlsmv") {
        const robust = w.robust;
        if (
          !record(robust) ||
          !record(robust.test) ||
          !record(robust.plan) ||
          !record(robust.standardErrors)
        )
          return fail();
        const t = robust.test,
          se = robust.standardErrors,
          plan = robust.plan;
        if (
          t.df !== df ||
          t.denominator !== n - 1 ||
          t.rawStatistic !== w.rawStatistic ||
          ![t.trace, t.traceSquared].every(
            (v) => Number.isFinite(v) && v >= -1e-8,
          ) ||
          !matrix(se.pattern, p, k) ||
          !matrix(se.structure, p, k) ||
          !matrix(se.phi, k, k) ||
          !numeric(se.communalities, p) ||
          !numeric(se.uniquenesses, p) ||
          [
            ...se.pattern.flat(),
            ...se.structure.flat(),
            ...se.phi.flat(),
            ...se.communalities,
            ...se.uniquenesses,
          ].some((v) => v < 0) ||
          !Number.isFinite(se.derivativeMaxRelativeChange) ||
          se.derivativeMaxRelativeChange < 0 ||
          se.derivativeMaxRelativeChange > 0.005 ||
          typeof se.method !== "string"
        )
          return fail();
        if (
          df === 0
            ? [t.scalingFactor, t.shift, t.statistic, t.pValue].some(
                (v) => v !== null,
              )
            : ![t.scalingFactor, t.shift, t.statistic, t.pValue].every(
                (v) => typeof v === "number" && Number.isFinite(v),
              ) ||
              t.scalingFactor! <= 0 ||
              t.pValue! < 0 ||
              t.pValue! > 1
        )
          return fail();
        if (
          !["moments", "cases"].includes(plan.space) ||
          plan.parameters !== q ||
          plan.pairs !== m ||
          plan.rows !== n ||
          !Number.isInteger(plan.blockSize) ||
          plan.blockSize < 1 ||
          plan.blockSize > 128 ||
          !Number.isFinite(plan.estimatedBytes) ||
          plan.estimatedBytes <= 0 ||
          plan.estimatedBytes > plan.budgetBytes ||
          !Number.isFinite(plan.budgetBytes) ||
          plan.budgetBytes > 1024 ** 3 ||
          !Number.isFinite(plan.approximateMultiplyAdds) ||
          plan.approximateMultiplyAdds <= 0
        )
          return fail();
      }
    }
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
  const finite = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  const nullable = (x: unknown) => x === null || finite(x);
  const replicaDiagnostics = (x: unknown, p: number) =>
    x === undefined ||
    (record(x) &&
      typeof x.improper === "boolean" &&
      finite(x.conditionNumber) &&
      Array.isArray(x.boundaryItems) &&
      x.boundaryItems.every((i) => Number.isInteger(i) && i >= 0 && i < p));
  const distribution = (x: unknown, keys: string[]) =>
    record(x) && keys.every((key) => nullable(x[key]));
  const distributionMatrix = (
    x: unknown,
    p: number,
    k: number,
    keys: string[],
  ) =>
    Array.isArray(x) &&
    x.length === p &&
    x.every(
      (row) =>
        Array.isArray(row) &&
        row.length === k &&
        row.every((v) => distribution(v, keys)),
    );
  const reviewMap = (x: unknown) =>
    record(x) &&
    Object.values(x).every(
      (v) =>
        record(v) &&
        ["retain", "investigate", "exclude"].includes(String(v.status)) &&
        typeof v.note === "string",
    );
  if (value.imputationRuns !== undefined) {
    if (!Array.isArray(value.imputationRuns)) return fail();
    for (const raw of value.imputationRuns) {
      if (
        !record(raw) ||
        typeof raw.id !== "string" ||
        ids.has(raw.id) ||
        !record(raw.result) ||
        !record(raw.spec) ||
        !rows(raw.eligibleRows) ||
        !reviewMap(raw.reviews) ||
        !reviewRevision(raw.reviewRevision) ||
        !reviewRevision(raw.parentReviewRevision)
      )
        return fail();
      const run = raw as unknown as NonNullable<
          EfaState["imputationRuns"]
        >[number],
        r = run.result,
        p = run.spec.items?.length;
      try {
        validateSpec(run.spec);
        validateMiceOptions(r.options, p);
      } catch {
        return fail();
      }
      if (
        (r.observedPairFloor !== undefined &&
          (!Number.isInteger(r.observedPairFloor) ||
            r.observedPairFloor < 0 ||
            r.observedPairFloor > 5)) ||
        run.spec.missing !== "pairwise" ||
        !Number.isInteger(run.revision) ||
        run.revision < 1 ||
        typeof run.createdAt !== "string" ||
        typeof run.datasetRevision !== "string" ||
        !rows(r.fittingRows) ||
        r.originalRowCount !== nRows ||
        !Array.isArray(r.fits) ||
        !Array.isArray(r.failures) ||
        !Array.isArray(r.aligned) ||
        !Array.isArray(r.trace) ||
        r.requested !== r.options.imputations ||
        r.completed !== r.fits.length ||
        r.completed + r.failures.length !== r.requested ||
        r.aligned.length !== r.completed ||
        r.provisional !== r.failures.length > 0 ||
        !record(r.provenance)
      )
        return fail();
      const n = r.fittingRows.length,
        k = r.completed ? run.spec.nFactors : 0,
        keys = ["mean", "sd", "min", "max"],
        eligible = new Set(run.eligibleRows);
      if (
        !Array.isArray(r.missingPositions) ||
        new Set(r.missingPositions).size !== r.missingPositions.length ||
        r.missingPositions.some(
          (i) => !Number.isInteger(i) || i < 0 || i >= n * p,
        ) ||
        r.fittingRows.some((i) => !eligible.has(i))
      )
        return fail();
      const chainIds = [
        ...r.fits.map((f) => f?.imputation),
        ...r.failures.map((f) => f?.imputation),
      ];
      if (
        new Set(chainIds).size !== r.requested ||
        chainIds.some(
          (i) => !Number.isInteger(i) || i < 0 || i >= r.requested,
        ) ||
        r.failures.some(
          (f) =>
            !f ||
            !["fit", "imputation"].includes(f.stage) ||
            typeof f.error !== "string",
        )
      )
        return fail();
      for (const fit of r.fits) {
        if (
          !fit ||
          !record(fit.result) ||
          !Array.isArray(fit.replacements) ||
          fit.replacements.length !== r.missingPositions.length ||
          fit.replacements.some(
            (v, j) =>
              !Number.isInteger(v) ||
              v < 0 ||
              v >=
                run.spec.items[Math.floor(r.missingPositions[j] / n)].categories
                  .length,
          )
        )
          return fail();
        validateEfaState(
          {
            runs: [
              { ...run, kind: "fit", scoreColumns: [], result: fit.result },
            ],
            splits: [],
          },
          nRows,
        );
        if (
          JSON.stringify(fit.result.fittingRows) !==
          JSON.stringify(r.fittingRows)
        )
          return fail();
      }
      if (
        !distributionMatrix(r.pattern, p, k, keys) ||
        !distributionMatrix(r.structure, p, k, keys) ||
        !distributionMatrix(r.phi, k, k, keys) ||
        !Array.isArray(r.communalities) ||
        r.communalities.length !== p ||
        !r.communalities.every((v) => distribution(v, keys)) ||
        !Array.isArray(r.uniquenesses) ||
        r.uniquenesses.length !== p ||
        !r.uniquenesses.every((v) => distribution(v, keys))
      )
        return fail();
      if (
        r.aligned.some(
          (a) =>
            !a ||
            !matrix(a.pattern, p, k) ||
            !matrix(a.structure, p, k) ||
            !matrix(a.phi, k, k) ||
            !numeric(a.communalities, p) ||
            !numeric(a.uniquenesses, p) ||
            !finite(a.rmsr) ||
            !replicaDiagnostics(a.diagnostics, p),
        ) ||
        r.trace.some(
          (t) =>
            !t ||
            !Number.isInteger(t.imputation) ||
            t.imputation < 0 ||
            t.imputation >= r.requested ||
            !Number.isInteger(t.item) ||
            t.item < 0 ||
            t.item >= p ||
            !Number.isInteger(t.iteration) ||
            t.iteration < 1 ||
            t.iteration > r.options.iterations ||
            !finite(t.mean) ||
            !finite(t.sd) ||
            !finite(t.gradient) ||
            !numeric(t.counts, run.spec.items[t.item].categories.length),
        )
      )
        return fail();
      ids.add(run.id);
    }
  }
  if (value.stabilityRuns !== undefined) {
    if (!Array.isArray(value.stabilityRuns)) return fail();
    for (const raw of value.stabilityRuns) {
      if (
        !record(raw) ||
        typeof raw.id !== "string" ||
        ids.has(raw.id) ||
        !record(raw.result)
      )
        return fail();
      const run = raw as unknown as NonNullable<
          EfaState["stabilityRuns"]
        >[number],
        r = run.result,
        parent = (value as unknown as EfaState).runs.find(
          (v) => v.id === run.runId,
        );
      if (
        !parent ||
        typeof run.createdAt !== "string" ||
        typeof run.datasetRevision !== "string"
      )
        return fail();
      try {
        validateStability(r.options);
      } catch {
        return fail();
      }
      const p = parent.spec.items.length,
        k = parent.spec.nFactors,
        n = parent.result.fittingRows.length,
        keys = ["mean", "sd", "lower", "upper"];
      if (
        r.requested !== r.options.replicates ||
        !Array.isArray(r.replicas) ||
        !Array.isArray(r.failures) ||
        !Array.isArray(r.samples) ||
        r.completed !== r.replicas.length ||
        r.completed + r.failures.length !== r.requested ||
        r.samples.length !== r.requested ||
        r.provisional !== r.failures.length > 0 ||
        r.samples.some(
          (sample) =>
            !Array.isArray(sample) ||
            sample.some((i) => !Number.isInteger(i) || i < 0 || i >= n),
        )
      )
        return fail();
      const replicaIds = [
        ...r.replicas.map((a) => a?.replicate),
        ...r.failures.map((f) => f?.replicate),
      ];
      if (
        new Set(replicaIds).size !== r.requested ||
        replicaIds.some(
          (i) => !Number.isInteger(i) || i < 0 || i >= r.requested,
        ) ||
        r.failures.some((f) => !f || typeof f.error !== "string")
      )
        return fail();
      if (
        r.options.groups &&
        (!Array.isArray(r.options.groups) ||
          r.options.groups.length !== n ||
          r.options.groups.some((g) => typeof g !== "string" || !g))
      )
        return fail();
      if (
        !distributionMatrix(r.pattern, p, k, keys) ||
        !distributionMatrix(r.structure, p, k, keys) ||
        !distributionMatrix(r.phi, k, k, keys) ||
        !Array.isArray(r.communalities) ||
        r.communalities.length !== p ||
        !r.communalities.every((v) => distribution(v, keys)) ||
        !Array.isArray(r.uniquenesses) ||
        r.uniquenesses.length !== p ||
        !r.uniquenesses.every((v) => distribution(v, keys))
      )
        return fail();
      if (
        r.replicas.some(
          (a) =>
            !a ||
            !matrix(a.pattern, p, k) ||
            !matrix(a.structure, p, k) ||
            !matrix(a.phi, k, k) ||
            !numeric(a.communalities, p) ||
            !numeric(a.uniquenesses, p) ||
            !finite(a.rmsr) ||
            !replicaDiagnostics(a.diagnostics, p),
        )
      )
        return fail();
      for (const rates of [r.primaryAgreement, r.crossLoadingFrequency])
        if (
          !Array.isArray(rates) ||
          rates.length !== p ||
          rates.some((v) => v !== null && (!finite(v) || v < 0 || v > 1))
        )
          return fail();
      ids.add(run.id);
    }
  }
}
