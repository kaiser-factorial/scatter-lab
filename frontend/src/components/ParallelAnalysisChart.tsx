"use client";

import { useId, useMemo, useState } from "react";
import type { ParallelResult } from "@/lib/efa/types";

export interface HistogramBin { lower: number; upper: number; count: number }

/** Equal-width count bins; the final interval includes its upper endpoint. */
export function parallelHistogram(values: number[], requestedBins?: number): HistogramBin[] {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return [];
  let lower = Math.min(...finite), upper = Math.max(...finite);
  if (lower === upper) {
    const padding = Math.max(Math.abs(lower) * 0.05, 0.05);
    lower -= padding; upper += padding;
  }
  const count = Math.max(1, Math.min(30, Math.floor(requestedBins ?? Math.max(5, Math.ceil(Math.sqrt(finite.length))))));
  const width = (upper - lower) / count;
  const bins = Array.from({ length: count }, (_, i) => ({ lower: lower + width * i, upper: lower + width * (i + 1), count: 0 }));
  for (const value of finite) bins[Math.min(count - 1, Math.floor((value - lower) / width))].count++;
  return bins;
}

const format = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 3 });

/**
 * One mark aggregates successful shuffled eigenvalues for one factor. Position
 * retains the eigenvalue scale; bar height is the number of permutations.
 * Out-of-domain observed values are explicitly labeled, never silently clipped.
 */
export function ParallelAnalysisChart({ result }: { result: ParallelResult }) {
  const [chosen, setChosen] = useState(0);
  const factor = Math.max(0, Math.min(chosen, result.observed.length - 1));
  const titleId = useId(), descriptionId = useId();
  const samples = useMemo(() => result.nullEigenvalues.map(row => row[factor]).filter(Number.isFinite), [result, factor]);
  const bins = useMemo(() => parallelHistogram(samples), [samples]);
  const observed = result.observed[factor];
  const reference = result.reference[factor];
  if (!result.observed.length) return <p>No factor eigenvalues are available.</p>;

  const width = 340, height = 205, left = 43, right = 326, top = 24, bottom = 159;
  const lower = bins[0]?.lower ?? 0, upper = bins.at(-1)?.upper ?? 1;
  const domainLow = reference != null && Number.isFinite(reference) ? Math.min(lower, reference) : lower;
  const domainHigh = reference != null && Number.isFinite(reference) ? Math.max(upper, reference) : upper;
  const peak = Math.max(1, ...bins.map(bin => bin.count));
  const x = (value: number) => left + (value - domainLow) / (domainHigh - domainLow) * (right - left);
  const y = (count: number) => bottom - count / peak * (bottom - top);
  const observedBelow = observed < domainLow, observedAbove = observed > domainHigh;
  const observedX = x(Math.max(domainLow, Math.min(domainHigh, observed)));
  const ticks = [domainLow, (domainLow + domainHigh) / 2, domainHigh];
  const counts = [...new Set([0, Math.ceil(peak / 2), peak])];

  return <figure className="my-2 space-y-2" aria-label="Parallel analysis histogram">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <label className="flex items-center gap-2 font-bold">
        Factor
        <select aria-label="Histogram factor" className="w-20 border border-[var(--border)] bg-[var(--input)] px-2 py-1" value={factor} onChange={event => setChosen(Number(event.target.value))}>
          {result.observed.map((_, index) => <option key={index} value={index}>{index + 1}</option>)}
        </select>
      </label>
      <span className="opacity-65">{samples.length} shuffled values</span>
    </div>
    {bins.length ? <svg viewBox={`0 0 ${width} ${height}`} className="block w-full" role="img" aria-labelledby={`${titleId} ${descriptionId}`}>
      <title id={titleId}>Factor {factor + 1}: shuffled eigenvalue histogram</title>
      <desc id={descriptionId}>{samples.length} successful permutations in {bins.length} equal-width bins. Observed eigenvalue {format(observed)}. {reference == null ? "No percentile reference is available." : `95th percentile ${format(reference)}.`}{observedAbove ? " The observed value lies above the displayed null range." : observedBelow ? " The observed value lies below the displayed null range." : ""}</desc>
      {counts.map(count => <g key={count}>
        <line x1={left} x2={right} y1={y(count)} y2={y(count)} stroke="currentColor" strokeOpacity={count === 0 ? 0.55 : 0.12} />
        <text x={left - 7} y={y(count) + 3} textAnchor="end" fontSize={10} fill="currentColor">{count}</text>
      </g>)}
      <text x={left} y={12} fontSize={10} fill="currentColor">Permutations</text>
      {bins.map((bin, index) => <rect key={index} x={x(bin.lower)} y={y(bin.count)} width={Math.max(0, x(bin.upper) - x(bin.lower) - 0.6)} height={bottom - y(bin.count)} fill="#0045AD" fillOpacity={0.8} stroke="currentColor" strokeOpacity={0.35} strokeWidth={0.5}>
        <title>{format(bin.lower)} to {format(bin.upper)}: {bin.count} permutation{bin.count === 1 ? "" : "s"}{index === bins.length - 1 ? "; upper endpoint included" : "; upper endpoint excluded"}</title>
      </rect>)}
      {reference != null && Number.isFinite(reference) && <line x1={x(reference)} x2={x(reference)} y1={top} y2={bottom} stroke="#8F7100" strokeWidth={2.5} strokeDasharray="5 3"><title>95th percentile: {format(reference)}</title></line>}
      {Number.isFinite(observed) && <>
        {!observedAbove && !observedBelow && <line x1={observedX} x2={observedX} y1={top} y2={bottom} stroke="#EB1A26" strokeWidth={2.5}><title>Observed: {format(observed)}</title></line>}
        {(observedAbove || observedBelow) && <path d={observedAbove ? `M ${right - 10} ${top + 3} L ${right} ${top + 9} L ${right - 10} ${top + 15}` : `M ${left + 10} ${top + 3} L ${left} ${top + 9} L ${left + 10} ${top + 15}`} fill="none" stroke="#EB1A26" strokeWidth={2.5}><title>Observed {format(observed)} is {observedAbove ? "above" : "below"} this displayed range</title></path>}
      </>}
      {ticks.map((tick, index) => <g key={index}>
        <line x1={x(tick)} x2={x(tick)} y1={bottom} y2={bottom + 4} stroke="currentColor" />
        <text x={x(tick)} y={bottom + 17} textAnchor={index === 0 ? "start" : index === 2 ? "end" : "middle"} fontSize={10} fill="currentColor">{format(tick)}</text>
      </g>)}
      <text x={(left + right) / 2} y={height - 5} textAnchor="middle" fontSize={11} fill="currentColor">Factor eigenvalue</text>
    </svg> : <p>No successful shuffled eigenvalues are available for this factor.</p>}
    <figcaption className="space-y-1 text-[11px]">
      <div className="flex items-center gap-1.5"><span aria-hidden="true" className="inline-block w-3 h-2" style={{ background: "#0045AD" }} />Shuffled-data distribution</div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <span><span aria-hidden="true" className="inline-block w-3 align-middle mr-1" style={{ borderTop: "2px solid #EB1A26" }} />Observed <b>{format(observed)}</b>{observedAbove ? " → above range" : observedBelow ? " ← below range" : ""}</span>
        <span><span aria-hidden="true" className="inline-block w-3 align-middle mr-1" style={{ borderTop: "2px dashed #8F7100" }} />95th percentile <b>{reference == null ? "—" : format(reference)}</b></span>
      </div>
      {reference != null && <p>{observed > reference ? "Observed exceeds" : "Observed does not exceed"} the reference for factor {factor + 1}.</p>}
    </figcaption>
    {bins.length > 0 && <details className="text-[10px] opacity-70">
      <summary className="cursor-pointer">Bin counts · width {format(bins[0].upper - bins[0].lower)}</summary>
      <table className="w-full text-right mt-1"><caption className="text-left">Lower-inclusive intervals; the final upper endpoint is included.</caption><thead><tr><th scope="col">From</th><th scope="col">To</th><th scope="col">Count</th></tr></thead><tbody>{bins.map((bin, index) => <tr key={index}><td>{format(bin.lower)}</td><td>{format(bin.upper)}</td><td>{bin.count}</td></tr>)}</tbody></table>
    </details>}
  </figure>;
}
