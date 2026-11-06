import { EfaTraceEstimate } from "./EfaTraceEstimate";
import type { EfaResult } from "@/lib/efa/types";

export function EfaWeightedSummary({ result }: { result: EfaResult }) {
  const weighted = result.weighted;
  if (!weighted) return null;
  const robust = weighted.robust;
  return (
    <details className="text-xs border border-[var(--border)] rounded p-2" open>
      <summary className="font-bold">
        {weighted.estimator.toUpperCase()} fit and uncertainty
      </summary>
      {robust ? (
        <>
          {robust.test.traceEstimation && <EfaTraceEstimate estimate={robust.test.traceEstimation} />}
          <p className="mt-1">
            {robust.test.df > 0
              ? `Scaled/shifted χ²(${robust.test.df}) = ${robust.test.statistic!.toFixed(3)}; p ${robust.test.pValue! < 0.001 ? "< .001" : `= ${robust.test.pValue!.toFixed(3)}`}.`
              : "Just-identified model: a corrected chi-square test is unavailable."}{" "}
            Standard errors account for the full rotation.
          </p>
          <p>
            Fit statistics describe compatibility with this exploratory model.
            They do not establish validity or protect a repeatedly inspected
            holdout.
          </p>
          <details className="mt-1">
            <summary>Correction and numerical provenance</summary>
            <p>
              Uncorrected weighted statistic {weighted.rawStatistic.toFixed(6)};
              denominator {robust.test.denominator}; scaling{" "}
              {robust.test.scalingFactor?.toPrecision(6) ?? "unavailable"};
              shift {robust.test.shift?.toPrecision(6) ?? "unavailable"}.
            </p>
            <p>
              Trace {robust.test.trace.toPrecision(7)}; squared trace product{" "}
              {robust.test.traceSquared.toPrecision(7)}. {robust.test.traceEstimation ? "Estimated matrix-product correction" : `Exact ${robust.plan.space === "cases" ? "case-block" : "moment-space"} calculation`}.
            </p>
            <p>{robust.standardErrors.method}</p>
          </details>
        </>
      ) : (
        <p className="mt-1">
          DWLS point fit with {weighted.fittingWeights.length.toLocaleString()}{" "}
          ordinal variance weights. Uncorrected weighted statistic{" "}
          {weighted.rawStatistic.toFixed(3)}; {weighted.df} model degrees of
          freedom. Select WLSMV to calculate robust standard errors and the
          corrected test.
        </p>
      )}
    </details>
  );
}
