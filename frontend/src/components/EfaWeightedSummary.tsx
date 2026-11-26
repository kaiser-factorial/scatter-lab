import { EfaTraceEstimate } from "./EfaTraceEstimate";
import type { EfaResult } from "@/lib/efa/types";

const value = (number: number | null | undefined, digits = 3) =>
  number != null && Number.isFinite(number) ? number.toFixed(digits) : "—";

export function EfaWeightedSummary({ result }: { result: EfaResult }) {
  const weighted = result.weighted;
  const robust = weighted?.robust;
  const likelihood = result.likelihood;
  const hasTest = !!robust && robust.test.df > 0;
  const metrics = [
    ...(likelihood ? [
      { label: "Log likelihood", value: value(likelihood.logLikelihood) },
      { label: "AIC", value: value(likelihood.aic) },
      { label: "BIC", value: value(likelihood.bic) },
    ] : []),
    ...(weighted
      ? [
          {
            label: robust ? "Scaled / shifted χ²" : "Weighted statistic",
            value: value(robust ? robust.test.statistic : weighted.rawStatistic),
          },
          { label: "df", value: value(robust?.test.df ?? weighted.df, 0) },
        ]
      : []),
    ...(robust
      ? [{
          label: "p",
          value: !hasTest || robust.test.pValue == null
            ? "—"
            : robust.test.pValue < 0.001
              ? "< .001"
              : value(robust.test.pValue),
        }]
      : []),
    { label: "RMS residual", value: value(result.rmsr) },
  ];

  return (
    <section className="efa-fit-summary text-xs" aria-label="Fit and uncertainty">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <p className="font-bold">
          {(weighted?.estimator ?? result.extraction.estimator ?? "minres").toUpperCase()} fit
        </p>
        <dl className="flex flex-wrap gap-x-5 gap-y-2">
          {metrics.map((metric) => (
            <div key={metric.label} className="flex items-baseline gap-2">
              <dt className="opacity-75">{metric.label}</dt>
              <dd className="efa-fit-value font-bold tabular-nums">{metric.value}</dd>
            </div>
          ))}
        </dl>
        {robust && <span className="opacity-75">Robust SE · full rotation</span>}
        {likelihood && <span className="opacity-75">{likelihood.kind === "fiml" ? "FIML" : "Complete-data ML"} · {result.extraction.convergence.converged ? "converged" : "did not converge"}</span>}
      </div>
      {robust && !hasTest && (
        <p className="mt-1">Just-identified model; corrected χ² and p are unavailable.</p>
      )}
      {weighted && (
        <details className="mt-2">
          <summary className="w-fit cursor-pointer font-bold">Correction and numerical details</summary>
          {robust ? (
            <div className="mt-2 space-y-1">
              <p>
                Uncorrected weighted statistic <strong className="tabular-nums">{value(weighted.rawStatistic, 6)}</strong>;{" "}
                denominator <strong className="tabular-nums">{robust.test.denominator}</strong>;{" "}
                scaling <strong className="tabular-nums">{robust.test.scalingFactor?.toPrecision(6) ?? "unavailable"}</strong>;{" "}
                shift <strong className="tabular-nums">{robust.test.shift?.toPrecision(6) ?? "unavailable"}</strong>.
              </p>
              <p>
                Trace <strong className="tabular-nums">{robust.test.trace.toPrecision(7)}</strong>;{" "}
                squared trace product <strong className="tabular-nums">{robust.test.traceSquared.toPrecision(7)}</strong>.{" "}
                {robust.test.traceEstimation ? "Estimated matrix-product correction" : `Exact ${robust.plan.space === "cases" ? "case-block" : "moment-space"} calculation`}.
              </p>
              <p>{robust.standardErrors.method}</p>
              {robust.test.traceEstimation && <EfaTraceEstimate estimate={robust.test.traceEstimation} />}
            </div>
          ) : (
            <p className="mt-2">
              DWLS point fit with <strong className="tabular-nums">{weighted.fittingWeights.length.toLocaleString()}</strong> ordinal variance weights.
              Robust standard errors and a corrected test are available with WLSMV.
            </p>
          )}
        </details>
      )}
      {likelihood && <details className="mt-2"><summary className="w-fit cursor-pointer font-bold">Likelihood and numerical details</summary>
        <p className="mt-2">{likelihood.nRows.toLocaleString()} informative rows · {likelihood.observedCells.toLocaleString()} {result.imputation ? `input cells after ${result.imputation.method} fill` : "observed cells"} · {likelihood.patternCount.toLocaleString()} missingness patterns.</p>
        <p>Selected start {likelihood.selectedStart}/{likelihood.starts.length}; {result.extraction.convergence.iterations} iterations; gradient {value(result.extraction.convergence.gradient, 8)}.</p>
        <p>Gaussian model likelihood in the original numeric units. Conditional completed values are separate predictions. Standard errors and a likelihood-ratio model test are not computed here.</p>
      </details>}
    </section>
  );
}
