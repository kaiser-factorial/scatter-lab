import type { TraceEstimate } from "@/lib/efa/trace-estimation";

export function EfaTraceEstimate({ estimate, status = "completed" }: { estimate: TraceEstimate; status?: string }) {
  const complete = estimate.probes === estimate.requestedProbes;
  const state = status === "cancelled" || status === "failed" ? "Partial estimate discarded"
    : !complete ? "Provisional estimate" : status === "running" ? "Probe budget complete; fit still running" : "Estimated MV correction";
  return <div className="my-2 space-y-1 border border-current/30 p-2 text-xs" aria-label="MV estimation uncertainty">
    <p className="font-bold">{state} · {estimate.probes} / {estimate.requestedProbes} probes · seed {estimate.seed}</p>
    <progress className="w-full" aria-label="MV probe progress" value={estimate.probes} max={estimate.requestedProbes} />
    <p>tr(H²) estimate: {estimate.traceSquared.toPrecision(7)}. Monte Carlo standard error: {estimate.monteCarloSE.toPrecision(4)}
      {estimate.traceSquared > 0 ? ` (${(100 * estimate.monteCarloSE / estimate.traceSquared).toPrecision(3)}% relative).` : "."}</p>
    <p>Approximate 95% Monte Carlo interval: [{estimate.normalInterval95.map(v => v.toPrecision(7)).join(", ")}].</p>
    <p className="opacity-80">Normal approximation for the fixed probe budget; not an error guarantee or a stopping rule. This measures trace-estimation uncertainty, separately from sampling uncertainty in loadings and numerical precision. Both correction modes apply MV scaling and shift.</p>
  </div>;
}
