"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { InfoTip } from "./InfoTip";
import { EfaWeightedSummary } from "./EfaWeightedSummary";
import { EfaProgress, EfaToast } from "./EfaFeedback";
import { StabilityPanel } from "./EfaBatchResults";
import type { EfaActions } from "./EfaPanel";
import type { DataTable } from "@/lib/table";
import type { EfaJob } from "@/lib/efa/service";
import type { EfaRun, EfaState, ItemReview } from "@/lib/efa/types";
import { compareEfaRuns } from "@/lib/efa/compare";
import { serializeEfaCsv } from "@/lib/efa/state";
import { alignEfaDisplayRun, patternAbsGap, sortEfaItems, strongestRelatedItem, type EfaTableSort } from "@/lib/efa/results-table";

const control = "border border-[var(--border)] bg-[var(--input)] px-2 py-1 text-xs min-w-0";
const button = "efa-action border border-[var(--border)] bg-[var(--input)] px-2 py-1 text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed";
const factorColors = ["#0045AD", "#EB1A26", "#FFD600", "#1A7A1A"];
const number = (x: number | null | undefined) => x == null || !Number.isFinite(x) ? "—" : x.toFixed(3);
const matrixMagnitude = (matrix: number[][], minimum = 0) => matrix.reduce((max, row) => row.reduce((m, value) => Math.max(m, Math.abs(value)), max), minimum);
const signature = (columns: string[]) => JSON.stringify(columns);
const download = (name: string, text: string, type: string) => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
function tint(value: number, limit: number, factor?: number): CSSProperties {
  const hue = factor == null ? (value < 0 ? factorColors[1] : factorColors[0]) : factorColors[factor % factorColors.length];
  return { backgroundColor: "color-mix(in srgb, " + hue + " " + Math.min(45, Math.abs(value) / Math.max(limit, .001) * 45) + "%, var(--background))" };
}
function Estimate({ value, se }: { value: number | null | undefined; se?: number | null }) {
  return <><span>{number(value)}</span>{se != null && <span className="ml-1 text-[10px] opacity-70" title="Robust standard error">(SE {number(se)})</span>}</>;
}

function MatrixView({ matrix, rows, columns, kind, limit = 1, standardErrors }: {
  matrix: (number | null)[][]; rows: string[]; columns: string[]; kind: "correlation" | "count";
  limit?: number; standardErrors?: (number | null)[][];
}) {
  const [offset, setOffset] = useState(0), [startColumn, setStartColumn] = useState(0);
  return <div className="space-y-2">
    <div className="flex flex-wrap gap-3 items-center text-xs">
      <span>{kind === "count" ? "Jointly observed respondents" : "Red: negative · blue: positive · scale ±" + number(limit)}</span>
      <label>First row <input aria-label="Matrix first row" className={control + " w-20"} type="number" min={1} max={rows.length} value={offset + 1} onChange={e => setOffset(Math.max(0, Math.min(rows.length - 1, +e.target.value - 1)))} /></label>
      <label>First column <input aria-label="Matrix first column" className={control + " w-20"} type="number" min={1} max={columns.length} value={startColumn + 1} onChange={e => setStartColumn(Math.max(0, Math.min(columns.length - 1, +e.target.value - 1)))} /></label>
    </div>
    <div className="overflow-auto"><table className="w-full text-xs border-collapse">
      <thead><tr><th scope="col">Item</th>{columns.slice(startColumn, startColumn + 20).map(c => <th scope="col" key={c} className="p-2 max-w-32 break-words">{c}</th>)}</tr></thead>
      <tbody>{matrix.slice(offset, offset + 30).map((row, i) => <tr key={rows[offset + i]}>
        <th scope="row" className="p-2 text-left sticky left-0 bg-[var(--background)] max-w-48 break-words">{rows[offset + i]}</th>
        {row.slice(startColumn, startColumn + 20).map((v, j) => <td key={j} className="p-2 text-right tabular-nums whitespace-nowrap border border-[var(--border)]" style={v == null || kind === "count" ? {} : tint(v, limit)}>
          {kind === "count" ? v : <Estimate value={v} se={standardErrors?.[offset + i]?.[startColumn + j]} />}
        </td>)}
      </tr>)}</tbody>
    </table></div>
  </div>;
}

export function EfaResults({ state, activeId, onSelect, actions, onClose, table, job }: {
  state: EfaState; activeId: string; onSelect: (id: string) => void; actions: EfaActions;
  onClose: () => void; table: DataTable; job?: EfaJob;
}) {
  const base = state.runs.find(r => r.id === activeId) ?? state.runs.at(-1)!;
  const [candidate, setCandidate] = useState<EfaRun | null>(null);
  const [candidateCurrent, setCandidateCurrent] = useState(false);
  const rawRun = candidate ?? base;
  let reference = base;
  const visited = new Set<string>();
  while (reference.kind === "items" && reference.parentId && !visited.has(reference.id)) {
    visited.add(reference.id);
    const parent = state.runs.find(r => r.id === reference.parentId);
    if (!parent) break;
    reference = parent;
  }
  // Align only the presentation. Exports, saving and score calculation use the original fitted result.
  const run = useMemo(() => reference === rawRun ? rawRun : alignEfaDisplayRun(reference, rawRun), [reference, rawRun]);
  const reviews = base.reviews;
  const [attemptedKey, setAttemptedKey] = useState<string | null>(null);
  const [reasons, setReasons] = useState("");
  const [live, setLive] = useState(false), [pending, setPending] = useState(false);
  const [view, setView] = useState<"pattern" | "structure" | "phi" | "residuals" | "correlation" | "counts" | "diagnostics" | "stability">("pattern");
  const [heat, setHeat] = useState(true), [showSE, setShowSE] = useState(true), [magnitude, setMagnitude] = useState(true);
  const [relatedScope, setRelatedScope] = useState<"selected" | "fitted">("selected");
  const [query, setQuery] = useState(""), [sort, setSort] = useState<EfaTableSort | null>(null);
  const [compareId, setCompareId] = useState(""), [weak, setWeak] = useState(.4), [cross, setCross] = useState(.3), [gap, setGap] = useState(.2);
  const [notice, setNotice] = useState<{ message: string; tone: "success" | "error" | "info" } | null>(null);
  const [pairOffset, setPairOffset] = useState(0), [scrollPosition, setScrollPosition] = useState({ key: "", top: 0 }), [viewportHeight, setViewportHeight] = useState(600);
  const sequence = useRef(0), reviewsRef = useRef(reviews), scrollArea = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null), mounted = useRef(true);
  const pool = base.spec.items.map(i => i.column);
  const included = pool.filter(column => reviews[column]?.status !== "exclude");
  const selectionKey = signature(included), fittedKey = signature(rawRun.spec.items.map(i => i.column));
  const dirty = selectionKey !== fittedKey || (!!candidate && !candidateCurrent);
  const [observedSelection, setObservedSelection] = useState(selectionKey);
  if (observedSelection !== selectionKey) {
    setObservedSelection(selectionKey); setCandidateCurrent(false); setPending(false); setAttemptedKey(null);
  }
  const selectedSet = new Set(included);
  const comparison = state.runs.find(r => r.id === compareId && r.id !== rawRun.id);
  const alignment = useMemo(() => comparison && run.spec.items.some(item => comparison.spec.items.some(other => other.column === item.column)) ? compareEfaRuns(run, comparison) : null, [run, comparison]);
  const items = run.spec.items.map(i => i.column), factors = Array.from({ length: run.spec.nFactors }, (_, i) => "F" + (i + 1));
  const indices = sortEfaItems(run, { query, sort, view: view === "structure" ? "structure" : "pattern", magnitude, includedColumns: relatedScope === "selected" ? selectedSet : undefined, reviews });
  const scrollKey = JSON.stringify([query, sort, magnitude, rawRun.id, view, relatedScope]);
  const scroll = scrollPosition.key === scrollKey ? scrollPosition.top : 0;
  const first = Math.max(0, Math.min(Math.max(0, indices.length - 1), Math.floor(scroll / 36) - 4));
  const visible = indices.slice(first, first + Math.ceil(viewportHeight / 36) + 8);
  const limit = [run, ...(comparison ? [comparison] : [])].reduce((m, r) => Math.max(m, matrixMagnitude(r.result.rotation.pattern), matrixMagnitude(r.result.structure)), .001);
  const outside = pool.filter(column => !items.includes(column));
  const busy = pending || job?.status === "running";

  useEffect(() => { actions.openHoldout(base.id); }, [actions, base.id]);
  useEffect(() => { if (comparison) actions.openHoldout(comparison.id); }, [actions, comparison?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement as HTMLElement | null;
    return () => { mounted.current = false; actions.cancelRefitPreview(); previous?.focus(); };
  }, [actions]);
  useEffect(() => { reviewsRef.current = base.reviews; }, [base.reviews]);
  useEffect(() => { sequence.current++; actions.cancelRefitPreview(); }, [actions, selectionKey]);
  useEffect(() => {
    const element = scrollArea.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewportHeight(element.clientHeight));
    observer.observe(element); return () => observer.disconnect();
  }, [view]);
  useEffect(() => { scrollArea.current?.scrollTo({ top: 0 }); }, [scrollKey]);

  const refit = useCallback(async () => {
    const ticket = ++sequence.current;
    actions.cancelRefitPreview();
    const snapshot = reviewsRef.current;
    const columns = base.spec.items.map(i => i.column).filter(c => snapshot[c]?.status !== "exclude");
    setAttemptedKey(signature(columns)); setPending(true); setCandidateCurrent(false); setNotice(null);
    try {
      const next = await actions.previewRefit(base.id, columns, snapshot);
      if (!mounted.current || ticket !== sequence.current) return;
      setCandidate(next); setCandidateCurrent(true); setCompareId("");
    } catch (error) {
      if (mounted.current && ticket === sequence.current) setNotice({ tone: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (mounted.current && ticket === sequence.current) setPending(false);
    }
  }, [actions, base.id, base.spec.items]);
  useEffect(() => {
    if (!live || !dirty || attemptedKey === selectionKey) return;
    const scheduled = sequence.current;
    const timer = setTimeout(() => { if (sequence.current === scheduled) void refit(); }, 400);
    return () => clearTimeout(timer);
  }, [live, selectionKey, dirty, attemptedKey, refit]);

  const updateReviews = (next: Record<string, ItemReview>) => {
    const before = signature(pool.filter(c => reviewsRef.current[c]?.status !== "exclude"));
    const after = signature(pool.filter(c => next[c]?.status !== "exclude"));
    if (before !== after) { sequence.current++; actions.cancelRefitPreview(); setPending(false); setCandidateCurrent(false); setNotice(null); }
    reviewsRef.current = next; actions.reviews(base.id, next);
  };
  const review = (column: string, change: Partial<ItemReview>) => updateReviews({ ...reviewsRef.current, [column]: { ...(reviewsRef.current[column] ?? { status: "retain", note: "" }), ...change } });
  const toggleLive = (enabled: boolean) => {
    if (!enabled) { sequence.current++; actions.cancelRefitPreview({ preserveCompleted: true }); setPending(false); }
    setAttemptedKey(null); setLive(enabled);
  };
  const execute = async (task: () => Promise<string>, compare = false) => {
    try {
      const result = await task();
      if (!mounted.current) return;
      if (compare && /^[a-f0-9-]{36}$/.test(result)) setCompareId(result);
      setNotice({ tone: "success", message: /^[a-f0-9-]{36}$/.test(result) ? "Completed." : result });
    } catch (error) { if (mounted.current) setNotice({ tone: "error", message: error instanceof Error ? error.message : String(error) }); }
  };
  const save = async () => {
    if (!candidate || dirty || pending) return;
    await execute(async () => { const id = await actions.saveRefitPreview(candidate.id, reviewsRef.current, reasons); onSelect(id); return "Candidate saved."; });
  };
  const sortHeader = (label: ReactNode, column: EfaTableSort["column"], factorIndex?: number, tooltip?: string) => {
    const active = sort?.column === column && sort.factorIndex === factorIndex;
    return <th scope="col" aria-sort={active ? sort.direction === "asc" ? "ascending" : "descending" : "none"} className="p-2 whitespace-nowrap text-left">
      <button className="cursor-pointer font-bold" onClick={() => setSort({ column, factorIndex, direction: active && sort.direction === "desc" ? "asc" : "desc" })}>{label}<span className="ml-1 opacity-60" aria-hidden="true">{active ? sort.direction === "asc" ? "↑" : "↓" : "↕"}</span></button>
      {tooltip && <InfoTip label={typeof label === "string" ? label : "Column information"} text={tooltip} />}
    </th>;
  };
  const counts = (r: EfaRun) => {
    const m = r.spec.items.map((_, i) => r.spec.items.map((__, j) => i === j ? r.result.correlation.counts[i] : 0));
    for (const p of r.result.correlation.pairs) m[p.i][p.j] = m[p.j][p.i] = p.n;
    return m;
  };
  const matrix = (r: EfaRun) => view === "phi" ? r.result.rotation.phi : view === "counts" ? counts(r) : view === "residuals" ? r.result.residuals : r.result.correlation.matrix;
  const currentMatrix = matrix(run), comparisonMatrix = comparison ? matrix(comparison) : [];
  const matrixScale = view === "residuals" ? [run, ...(comparison ? [comparison] : [])].reduce((max, r) => matrixMagnitude(r.result.residuals, max), .01) : 1;

  return createPortal(<div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="efa-results-title" className="efa-results fixed inset-2 sm:inset-4 z-[120] flex flex-col bg-[var(--background)] text-[var(--foreground)] border-2 border-[var(--border)] shadow-xl p-3 gap-2 overflow-hidden" onKeyDown={e => {
    if (e.key === "Escape" && !document.querySelector('[role="tooltip"]')) { e.stopPropagation(); onClose(); }
    if (e.key !== "Tab") return;
    const nodes = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,[tabindex='0']")).filter(n => n.getClientRects().length);
    if (e.shiftKey && document.activeElement === nodes[0]) { e.preventDefault(); nodes.at(-1)?.focus(); }
    else if (!e.shiftKey && document.activeElement === nodes.at(-1)) { e.preventDefault(); nodes[0]?.focus(); }
  }}>
    <header className="flex gap-3 items-start justify-between shrink-0">
      <div><h2 id="efa-results-title" className="font-bold text-lg">EFA · {base.spec.label}{candidate ? " · working candidate" : " · revision " + base.revision}</h2>
        <p className="text-xs opacity-75">{(run.spec.extraction ?? "minres").toUpperCase()} · {run.spec.rotation} · {run.result.fittingRows.length.toLocaleString()} fixed fitting rows · {items.length} fitted items · {factors.length} factors</p>
      </div>
      <button autoFocus className={button} onClick={onClose}>Close results</button>
    </header>
    <div className="flex flex-wrap gap-2 items-center text-xs shrink-0">
      <label>Saved run <select className={control + " max-w-52"} value={base.id} aria-label="Saved run" onChange={e => onSelect(e.target.value)}>{state.runs.map(r => <option key={r.id} value={r.id}>{r.spec.label} r{r.revision} · {r.kind}</option>)}</select></label>
      <label>Compare with <select className={control + " max-w-44"} value={compareId} aria-label="Compare with" onChange={e => setCompareId(e.target.value)}><option value="">No comparison</option>{state.runs.filter(r => r.id !== rawRun.id).map(r => <option key={r.id} value={r.id}>{r.spec.label} r{r.revision}</option>)}</select></label>
      <button className={button} disabled={!!candidate || dirty || busy} title={candidate ? "Save the candidate before adding scores" : undefined} onClick={() => void execute(() => actions.addScores(base.id))}>Add scores to dataset</button>
      {rawRun.result.likelihood && actions.complete && <details className="relative"><summary className={button + " cursor-pointer"}>Complete missing values</summary>
        <div className="absolute left-0 top-full z-40 min-w-72 max-w-sm border-2 border-[var(--border)] bg-[var(--card)] p-2 flex flex-col gap-2">
          <p>Conditional predictions from the saved ML/FIML model. The operation uses its fixed fitting rows and preserves observed values.</p>
          {([['columns', 'Add completed item columns'], ['csv', 'Completed values · CSV'], ['operation', 'Saved operation + input · JSON'], ['code', 'Replay operation · R code']] as const).map(([destination, label]) => <button key={destination} className={button} disabled={!!candidate || dirty || busy} onClick={e => {
            e.currentTarget.closest('details')?.removeAttribute('open');
            void execute(() => actions.complete!(base.id, destination));
          }}>{label}</button>)}
          <span className="opacity-70">The R code replays the saved model with the operation JSON. It does not refit the model.</span>
        </div>
      </details>}
      <details className="relative"><summary className={button + " cursor-pointer"}>Export</summary><div className="absolute left-0 top-full z-40 min-w-64 border-2 border-[var(--border)] bg-[var(--card)] p-2 flex flex-col gap-2">
        <button className={button} onClick={e => { download(rawRun.spec.label + ".csv", serializeEfaCsv({ ...rawRun, reviews }), "text/csv;charset=utf-8"); e.currentTarget.closest("details")?.removeAttribute("open"); }}>Loadings and item statistics · CSV</button>
        <button className={button} onClick={e => { download(rawRun.spec.label + ".efa.json", JSON.stringify({ format: 1, run: { ...rawRun, reviews }, split: state.splits.find(s => s.id === rawRun.spec.sample.splitId) }, null, 2), "application/json"); e.currentTarget.closest("details")?.removeAttribute("open"); }}>Complete analysis · JSON</button>
        <span className="opacity-70">Exports the last completed fit in its original factor order, with full precision. The table aligns factors to the reference run.</span>
      </div></details>
    </div>
    <div className="flex flex-wrap gap-x-3 gap-y-2 items-center text-xs shrink-0 border-y border-[var(--border)] py-2">
      <label className="font-bold flex gap-1 items-center"><input type="checkbox" checked={live} onChange={e => toggleLive(e.target.checked)} />Live refit</label>
      <InfoTip label="About live refitting" text="Refits 400 ms after your last inclusion change, keeping the original fitting rows and factor count. Turn it off to select several items, then choose Refit now. The table updates only when the new fit completes." />
      <span>{included.length} selected · {pool.length - included.length} excluded</span>
      <button className={button} disabled={!dirty || pending} onClick={() => void refit()}>Refit now</button>
      <button className={button} disabled={!candidate || dirty || busy} onClick={() => void save()}>Save candidate</button>
      <button className={button} onClick={() => { sequence.current++; actions.cancelRefitPreview(); setPending(false); setCandidate(null); setCompareId(""); updateReviews(Object.fromEntries(pool.map(c => [c, { ...(reviewsRef.current[c] ?? { note: "" }), status: "retain" as const }]))); }}>Reset selection</button>
      <span role="status" aria-live="polite" className="opacity-75">{pending ? "Updating · showing previous fit" : dirty ? "Selection changed · showing previous fit" : candidate ? "Working candidate · unsaved" : "Saved fit"}</span>
    </div>
    {pending && <EfaProgress label="Refitting selected items" progress={job?.status === "running" ? job.progress : undefined} />}
    {notice && <EfaToast {...notice} onDismiss={() => setNotice(null)} />}
    <EfaWeightedSummary result={run.result} />
    {comparison && !alignment && <p role="status" className="text-xs">These runs have no shared items to compare.</p>}
    {comparison && alignment && <details className="text-xs shrink-0"><summary className="cursor-pointer">Comparison: {comparison.spec.label} r{comparison.revision} · {alignment.shared.length} shared items · {alignment.sameRows ? "same fitting rows" : "different fitting rows"}</summary><p>Cells show current / comparison. Factor congruence: {alignment.congruence.map(number).join(", ")}. Factors are aligned by signs and order. Unmatched comparison factors: {alignment.unmatchedCandidate.map(i => "F" + (i + 1)).join(", ") || "none"}.</p></details>}
    <nav aria-label="EFA result views" className="flex gap-1 overflow-x-auto shrink-0">
      {(["pattern", "structure", "phi", "residuals", "correlation", "counts", "diagnostics", "stability"] as const).map(v => <button key={v} className={button + " whitespace-nowrap"} aria-pressed={view === v} onClick={() => setView(v)}>{({ pattern: "Pattern", structure: "Structure", phi: "Factor correlations", residuals: "Residuals", correlation: "Correlations", counts: "Pair counts", diagnostics: "Diagnostics", stability: "Resampling stability" })[v]}</button>)}
    </nav>
    {view === "pattern" || view === "structure" ? <>
      <div className="flex flex-wrap items-center gap-3 text-xs shrink-0">
        <strong>{view === "pattern" ? "Pattern" : "Structure"} {heat ? "heatmap" : "coefficients"}<InfoTip label={view === "pattern" ? "About pattern loadings" : "About structure coefficients"} text={view === "pattern" ? "Pattern coefficients describe each factor’s contribution while accounting for the other factors. Pattern abs Δ and review flags always use pattern loadings." : "Structure coefficients are item–factor correlations, including relationships among factors. Pattern abs Δ and review flags still use pattern loadings."} /></strong>
        <label className="flex gap-1 items-center">Find item <input className={control + " w-40"} value={query} onChange={e => setQuery(e.target.value)} /></label>
        <span className="opacity-70">{indices.length} items · {heat ? "tint = |loading|; numbers retain sign" : "coefficients to 3 decimals"}</span>
        {sort && <button className={button} onClick={() => setSort(null)}>Original order</button>}
      </div>
      <details className="shrink-0 text-xs"><summary className="cursor-pointer">Table options</summary><div className="flex flex-wrap gap-x-4 gap-y-2 py-2 items-center">
        <label><input type="checkbox" checked={heat} onChange={e => setHeat(e.target.checked)} /> Heatmap</label>
        <label><input type="checkbox" checked={showSE} onChange={e => setShowSE(e.target.checked)} /> Show robust SE</label>
        <label><input type="checkbox" checked={magnitude} onChange={e => setMagnitude(e.target.checked)} /> Sort factor columns by absolute loading</label>
        <label>Related item <select className={control} value={relatedScope} onChange={e => setRelatedScope(e.target.value as typeof relatedScope)}><option value="selected">Among selected items</option><option value="fitted">Among all fitted items</option></select></label>
        <InfoTip label="Related-item scope" text="The strongest absolute saved correlation among the chosen items. Selection changes this lookup immediately; new factor loadings require a completed refit. Newly re-included items join this lookup after refitting." />
        <label>Flag primary |pattern| below <input aria-label="Weak pattern threshold" className={control + " w-16"} type="number" step={.05} min={0} value={weak} onChange={e => setWeak(+e.target.value)} /></label>
        <label>Flag next |pattern| above <input aria-label="Cross-loading threshold" className={control + " w-16"} type="number" step={.05} min={0} value={cross} onChange={e => setCross(+e.target.value)} /></label>
        <label>Flag Pattern abs Δ below <input aria-label="Pattern gap threshold" className={control + " w-16"} type="number" step={.05} min={0} value={gap} onChange={e => setGap(+e.target.value)} /></label>
        <span>Shared magnitude scale 0–{number(limit)}.</span>
      </div></details>
      <div ref={scrollArea} className="flex-1 min-h-24 overflow-auto border border-[var(--border)]" onScroll={e => setScrollPosition({ key: scrollKey, top: e.currentTarget.scrollTop })}>
        <table className="w-full text-xs border-collapse" aria-label={view + (heat ? " heatmap" : " loading table")} aria-rowcount={indices.length + 1}>
          <thead className="sticky top-0 bg-[var(--background)] z-20"><tr>
            {sortHeader("Item", "item")}
            {factors.map((f, i) => <th key={f} scope="col" aria-sort={sort?.column === "factor" && sort.factorIndex === i ? sort.direction === "asc" ? "ascending" : "descending" : "none"} className="p-2 text-right whitespace-nowrap" style={{ borderTop: "4px solid " + factorColors[i % 4] }}><button className="cursor-pointer" onClick={() => setSort({ column: "factor", factorIndex: i, direction: sort?.column === "factor" && sort.factorIndex === i && sort.direction === "desc" ? "asc" : "desc" })}>{f} {sort?.column === "factor" && sort.factorIndex === i ? sort.direction === "asc" ? "↑" : "↓" : "↕"}</button></th>)}
            {sortHeader("Pattern abs Δ", "gap", undefined, "Largest absolute pattern loading minus the second-largest absolute pattern loading. This always uses pattern loadings, including in Structure view. A small gap means neither loading clearly dominates, regardless of sign.")}
            {sortHeader("h²", "communality", undefined, "Communality: variance reproduced by the factors.")}
            {sortHeader("u²", "uniqueness", undefined, "Uniqueness: 1 minus communality.")}
            {sortHeader("Related item · r", "related")}{sortHeader("Review", "review")}{sortHeader("Note", "note")}
          </tr></thead>
          <tbody>
            {first > 0 && <tr aria-hidden="true"><td colSpan={factors.length + 7} style={{ height: first * 36 }} /></tr>}
            {visible.map((i, row) => {
              const column = items[i], values = view === "pattern" ? run.result.rotation.pattern[i] : run.result.structure[i];
              const sorted = run.result.rotation.pattern[i].map(Math.abs).sort((a, b) => b - a), delta = patternAbsGap(run.result.rotation.pattern[i]);
              const flags = [sorted[0] < weak ? "Weak primary pattern loading" : "", (sorted[1] ?? 0) > cross ? "Pattern cross-loading" : "", delta < gap ? "Small pattern gap" : ""].filter(Boolean).join("; ");
              const related = strongestRelatedItem(run, i, relatedScope === "selected" ? selectedSet : undefined);
              const shared = alignment?.shared.indexOf(column) ?? -1, otherIndex = shared < 0 ? -1 : alignment!.bi[shared];
              const includedHere = selectedSet.has(column);
              return <tr key={column} aria-rowindex={first + row + 2} className="border-t border-[var(--border)]" style={{ height: 36 }}>
                <th scope="row" className="sticky left-0 z-10 bg-[var(--background)] text-left px-2 max-w-64"><label className="flex gap-2 items-center"><input aria-label={"Include " + column} type="checkbox" checked={includedHere} onChange={e => review(column, { status: e.target.checked ? "retain" : "exclude" })} /><span className={"truncate " + (!includedHere ? "line-through opacity-60" : "")} title={column}>{column}</span></label></th>
                {values.map((v, f) => {
                  const otherFactor = alignment?.mapping[f], otherValue = comparison && otherIndex >= 0 && otherFactor != null ? (view === "pattern" ? comparison.result.rotation.pattern : comparison.result.structure)[otherIndex][otherFactor] * alignment!.signs[f] : null;
                  return <td key={f} className="px-2 text-right tabular-nums whitespace-nowrap" style={heat ? tint(v, limit, f) : {}}><Estimate value={v} se={showSE ? run.result.weighted?.robust?.standardErrors[view][i][f] : undefined} />{comparison && alignment && <span className="ml-2 opacity-75">/ <Estimate value={otherValue} se={showSE && otherIndex >= 0 && otherFactor != null ? comparison.result.weighted?.robust?.standardErrors[view][otherIndex][otherFactor] : undefined} /></span>}</td>;
                })}
                <td className="px-2 tabular-nums whitespace-nowrap" title={flags || undefined}>{number(delta)}{flags && <InfoTip label={"Pattern flags for " + column} text={flags} />}</td>
                <td className="px-2 tabular-nums whitespace-nowrap"><Estimate value={run.result.communalities[i]} se={showSE ? run.result.weighted?.robust?.standardErrors.communalities[i] : undefined} />{comparison && alignment && <span className="opacity-70"> / {number(comparison.result.communalities[otherIndex])}</span>}</td>
                <td className="px-2 tabular-nums whitespace-nowrap"><Estimate value={run.result.uniquenesses[i]} se={showSE ? run.result.weighted?.robust?.standardErrors.uniquenesses[i] : undefined} />{comparison && alignment && <span className="opacity-70"> / {number(comparison.result.uniquenesses[otherIndex])}</span>}</td>
                <td className="px-2 max-w-48 truncate" title={related ? related.column + ": " + related.r : "No related item in this scope"}>{related ? related.column + " · " + number(related.r) : "—"}</td>
                <td className="px-1"><select aria-label={"Review " + column} className={control + " w-24"} value={reviews[column]?.status ?? "retain"} onChange={e => review(column, { status: e.target.value as ItemReview["status"] })}><option value="retain">Keep</option><option value="investigate">Review</option><option value="exclude">Exclude</option></select></td>
                <td className="px-1"><input aria-label={"Note " + column} className={control + " w-36"} value={reviews[column]?.note ?? ""} onChange={e => review(column, { note: e.target.value })} /></td>
              </tr>;
            })}
            {first + visible.length < indices.length && <tr aria-hidden="true"><td colSpan={factors.length + 7} style={{ height: (indices.length - first - visible.length) * 36 }} /></tr>}
            {!indices.length && <tr><td colSpan={factors.length + 7} className="p-4">No items match this search.</td></tr>}
          </tbody>
        </table>
      </div>
      {outside.length > 0 && <details className="text-xs shrink-0"><summary className="cursor-pointer">Items outside this fit ({outside.length}) · expand to reinclude</summary><div className="flex flex-wrap gap-3 max-h-28 overflow-auto py-2">{outside.map(column => <label key={column} className="flex items-center gap-1"><input aria-label={"Include " + column} type="checkbox" checked={selectedSet.has(column)} onChange={e => review(column, { status: e.target.checked ? "retain" : "exclude" })} />{column}{selectedSet.has(column) ? " · awaiting refit" : ""}</label>)}</div></details>}
    </> : <div className="flex-1 min-h-0 overflow-auto">
      {view === "stability" ? candidate || dirty ? <p className="p-3 text-sm">Refit and save the current selection to run resampling stability.</p> : <StabilityPanel key={base.id} run={base} state={state} table={table} actions={actions} job={job} /> : view === "diagnostics" ? <div className="space-y-3 text-xs">
        <p>{(run.result.extraction.estimator ?? "minres").toUpperCase()}: {run.result.extraction.convergence.iterations} iterations · objective {number(run.result.extraction.convergence.objective)} · gradient {number(run.result.extraction.convergence.gradient)} · condition number {number(run.result.conditionNumber)}</p>
        {run.result.diagnostics.map((d, i) => <p key={i}>{d.message}</p>)}
        <details><summary>Category and pair diagnostics</summary><label>First pair <input className={control} type="number" min={1} max={run.result.correlation.pairs.length} value={pairOffset + 1} onChange={e => setPairOffset(Math.max(0, +e.target.value - 1))} /></label><pre className="whitespace-pre-wrap">{JSON.stringify({ categories: run.spec.items.map((item, i) => ({ ...item, counts: run.result.categoryCounts[i] })), pairs: run.result.correlation.pairs.slice(pairOffset, pairOffset + 20) }, null, 2)}</pre></details>
        <details><summary>Numerical provenance</summary><pre className="whitespace-pre-wrap">{JSON.stringify(run.result.provenance, null, 2)}</pre></details>
        {run.revisedAfterHoldout && <p>This candidate was revised after holdout results were opened.</p>}
        {state.splits.find(s => s.id === run.spec.sample.splitId)?.afterFullExploration && <p>This split was created after full-data exploration.</p>}
      </div> : <div className="grid gap-4" style={{ gridTemplateColumns: comparison && alignment ? "repeat(2,minmax(0,1fr))" : "1fr" }}>
        <div><h3 className="font-bold mb-2">Current fit</h3><MatrixView key={rawRun.id + view} matrix={view === "phi" || !comparison || !alignment ? currentMatrix : alignment.ai.map(i => alignment.ai.map(j => currentMatrix[i][j]))} rows={view === "phi" ? factors : (comparison && alignment ? alignment.shared : items)} columns={view === "phi" ? factors : (comparison && alignment ? alignment.shared : items)} kind={view === "counts" ? "count" : "correlation"} limit={matrixScale} standardErrors={view === "phi" && showSE ? run.result.weighted?.robust?.standardErrors.phi : undefined} /></div>
        {comparison && alignment && <div><h3 className="font-bold mb-2">Comparison · {comparison.spec.label}</h3><MatrixView key={comparison.id + rawRun.id + view + signature(alignment.shared)} matrix={view === "phi" ? alignment.mapping.map((i, a) => alignment.mapping.map((j, b) => i == null || j == null ? null : comparison.result.rotation.phi[i][j] * alignment.signs[a] * alignment.signs[b])) : alignment.bi.map(i => alignment.bi.map(j => comparisonMatrix[i][j]))} rows={view === "phi" ? factors : alignment.shared} columns={view === "phi" ? factors : alignment.shared} kind={view === "counts" ? "count" : "correlation"} limit={matrixScale} standardErrors={view === "phi" && showSE && comparison.result.weighted?.robust ? alignment.mapping.map(i => alignment.mapping.map(j => i == null || j == null ? null : comparison.result.weighted!.robust!.standardErrors.phi[i][j])) : undefined} /></div>}
      </div>}
    </div>}
    <details className="shrink-0 border-t border-[var(--border)] pt-2 text-xs"><summary className="cursor-pointer font-bold">More actions · rotations and holdout</summary><div className="flex flex-wrap gap-3 items-center py-2">
      <label>Candidate note <input className={control + " w-56"} aria-label="Refit reasons" placeholder="Reasons for this candidate" value={reasons} onChange={e => setReasons(e.target.value)} /></label>
      <details className="relative"><summary className={button + " cursor-pointer"}>Rotations…</summary><div className="absolute bottom-full left-0 z-40 min-w-60 bg-[var(--card)] border-2 border-[var(--border)] p-2 flex flex-col gap-2">{(["promax", "oblimin", "varimax"] as const).filter(r => r !== base.spec.rotation).map(rotation => <button key={rotation} className={button} disabled={!!candidate || dirty || busy} onClick={e => { e.currentTarget.closest("details")?.removeAttribute("open"); void execute(() => actions.run({ ...base.spec, rotation }, { parentId: base.id, kind: "rotation", reviews, reasons: "Rotation comparison: " + rotation }), true); }}>{rotation === "varimax" ? "Varimax · uncorrelated factors" : rotation === "promax" ? "Promax · correlated factors" : "Oblimin · correlated factors"}</button>)}</div></details>
      {base.spec.sample.partition === "development" && <button className={button} disabled={!!candidate || dirty || busy} onClick={() => void execute(() => actions.run({ ...base.spec, sample: { partition: "holdout", splitId: base.spec.sample.splitId } }, { parentId: base.id, kind: "structure-replication", reviews, reasons: "Independent holdout refit of frozen development specification" }), true)}>Compare on holdout</button>}
      <span className="opacity-75">{candidate ? "Save the candidate before running further analyses." : "Item refits keep the original fitting rows and factor count. Review items remain included."}</span>
    </div></details>
  </div>, document.body);
}
