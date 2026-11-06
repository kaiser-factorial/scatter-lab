"use client";

import { EfaBackendControls } from "./EfaBackendControls";
import { InfoTip } from "./InfoTip";
import { mvRuntimeAdvice } from "@/lib/efa/runtime-advice";
import type { EfaService } from "@/lib/efa/service";
import type { EfaComputeSettings } from "@/lib/efa/backends/types";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { DataTable } from "@/lib/table";
import { proposedCategories } from "@/lib/efa/prepare";
import { compareEfaRuns } from "@/lib/efa/compare";
import { serializeEfaCsv } from "@/lib/efa/state";
import type { EfaJob } from "@/lib/efa/service";
import type { MiceOptions } from "@/lib/efa/mice";
import type { StabilityOptions } from "@/lib/efa/stability";
import type { InferencePlan } from "@/lib/efa/weighted-inference";
import { EfaWeightedSummary } from "./EfaWeightedSummary";
import { ImputationResults, StabilityPanel } from "./EfaBatchResults";
import type {
  EfaSpec,
  EfaState,
  EfaRun,
  ItemReview,
  Rotation,
  SampleSplit,
  ParallelResult,
  OrdinalCategory,
  EfaEstimator,
} from "@/lib/efa/types";

export interface EfaActions {
  impute: (
    spec: EfaSpec,
    options: MiceOptions,
    changes?: {
      parentId?: string;
      reviews?: Record<string, ItemReview>;
      reasons?: string;
    },
  ) => Promise<string>;
  imputationReviews: (id: string, reviews: Record<string, ItemReview>) => void;
  stability: (
    runId: string,
    options: Omit<StabilityOptions, "groups">,
    groupColumn?: string,
  ) => Promise<string>;
  run: (
    spec: EfaSpec,
    options?: {
      parentId?: string;
      kind?: EfaRun["kind"];
      reviews?: Record<string, ItemReview>;
      reasons?: string;
    },
  ) => Promise<string>;
  addScores: (id: string) => Promise<string>;
  parallel: (spec: EfaSpec, replicates: number) => Promise<ParallelResult>;
  preview: (spec: EfaSpec) => Promise<{
    nRows: number;
    counts: number[][];
    inferencePlan?: InferencePlan;
  }>;
  split: (options: {
    seed: number;
    fraction: number;
    groupColumn?: string;
    stratumColumn?: string;
    sourceColumn?: string;
    developmentValue?: string;
    holdoutValue?: string;
  }) => SampleSplit;
  reviews: (id: string, reviews: Record<string, ItemReview>) => void;
  openHoldout: (id: string) => void;
  cancel: () => void;
}
const control =
  "w-full border border-[var(--border)] bg-[var(--input)] rounded px-2 py-1 text-xs";
const button =
  "border border-[var(--border)] bg-[var(--input)] rounded px-3 py-1 text-xs font-bold disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2";
const number = (x: number | null | undefined) =>
  x == null || !Number.isFinite(x) ? "—" : x.toFixed(3);
const download = (name: string, text: string, type: string) => {
  const url = URL.createObjectURL(new Blob([text], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
function color(value: number, limit: number): CSSProperties {
  return {
    backgroundColor: `color-mix(in srgb, ${value < 0 ? "#b35806" : "#0571b0"} ${Math.min(80, (Math.abs(value) / Math.max(limit, 0.001)) * 80)}%, var(--background))`,
  };
}

function MatrixView({
  matrix,
  rows,
  columns,
  kind,
  scaleLimit,
  standardErrors,
}: {
  matrix: (number | null)[][];
  rows: string[];
  columns: string[];
  kind: "loading" | "correlation" | "count";
  scaleLimit?: number;
  standardErrors?: (number | null)[][];
}) {
  const [offset, setOffset] = useState(0),
    [startColumn, setStartColumn] = useState(0);
  const limit =
    scaleLimit ??
    (kind === "correlation"
      ? 1
      : matrix.reduce(
          (m, row) =>
            row.reduce<number>((s, v) => Math.max(s, Math.abs(v ?? 0)), m),
          1,
        ));
  const visible = matrix.slice(offset, offset + 12),
    end = Math.min(columns.length, startColumn + 12);
  return (
    <div className="space-y-2">
      <p className="text-xs">
        {kind === "count"
          ? "Jointly observed respondents"
          : `Color scale: −${limit.toFixed(2)} to +${limit.toFixed(2)}; zero is neutral.`}{" "}
        All values are available as text.
        {standardErrors
          ? " Robust SEs are shown in parentheses; colors encode correlations."
          : ""}
      </p>
      <div className="flex gap-2 text-xs">
        <label>
          First row{" "}
          <input
            className={control}
            type="number"
            min={1}
            max={rows.length}
            value={offset + 1}
            onChange={(e) =>
              setOffset(
                Math.max(0, Math.min(rows.length - 1, +e.target.value - 1)),
              )
            }
          />
        </label>
        <label>
          First column{" "}
          <input
            className={control}
            type="number"
            min={1}
            max={columns.length}
            value={startColumn + 1}
            onChange={(e) =>
              setStartColumn(
                Math.max(0, Math.min(columns.length - 1, +e.target.value - 1)),
              )
            }
          />
        </label>
      </div>
      <div className="overflow-auto">
        <table className="text-xs border-collapse w-full">
          <thead>
            <tr>
              <th scope="col">Item</th>
              {columns.slice(startColumn, end).map((c) => (
                <th scope="col" key={c} className="p-2 max-w-28 break-words">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, i) => (
              <tr key={rows[offset + i]}>
                <th
                  scope="row"
                  className="p-2 text-left sticky left-0 bg-[var(--background)] max-w-48 break-words"
                >
                  {rows[offset + i]}
                </th>
                {row.slice(startColumn, end).map((v, j) => (
                  <td
                    key={j}
                    className="p-2 text-right tabular-nums border border-[var(--border)]"
                    style={
                      v === null || kind === "count" ? {} : color(v, limit)
                    }
                  >
                    {kind === "count" ? v : number(v)}
                    {standardErrors?.[offset + i]?.[startColumn + j] != null
                      ? ` (${number(standardErrors[offset + i][startColumn + j])})`
                      : ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Results({
  state,
  activeId,
  onSelect,
  actions,
  onClose,
  table,
  job,
}: {
  state: EfaState;
  activeId: string;
  onSelect: (id: string) => void;
  actions: EfaActions;
  onClose: () => void;
  table: DataTable;
  job?: EfaJob;
}) {
  const run = state.runs.find((r) => r.id === activeId) ?? state.runs.at(-1)!;
  const [view, setView] = useState<
    | "pattern"
    | "structure"
    | "phi"
    | "residuals"
    | "correlation"
    | "counts"
    | "diagnostics"
    | "stability"
  >("pattern");
  const [heat, setHeat] = useState(true),
    [showSE, setShowSE] = useState(true),
    [compareId, setCompareId] = useState(""),
    [scroll, setScroll] = useState(0),
    [query, setQuery] = useState(""),
    [message, setMessage] = useState(""),
    [keepRows, setKeepRows] = useState(true),
    [reasons, setReasons] = useState(""),
    [pairOffset, setPairOffset] = useState(0);
  const [weak, setWeak] = useState(0.4),
    [cross, setCross] = useState(0.3),
    [gap, setGap] = useState(0.2);
  const comparison = state.runs.find((r) => r.id === compareId),
    alignment = useMemo(
      () =>
        comparison &&
        run.spec.items.some((item) =>
          comparison.spec.items.some((other) => other.column === item.column),
        )
          ? compareEfaRuns(run, comparison)
          : null,
      [run, comparison],
    );
  useEffect(() => {
    actions.openHoldout(run.id);
    if (comparison) actions.openHoldout(comparison.id);
  }, [actions, run.id, comparison]);
  const items = run.spec.items.map((x) => x.column),
    factors = Array.from({ length: run.spec.nFactors }, (_, i) => `F${i + 1}`);
  const indices = items
    .map((_, i) => i)
    .filter((i) => items[i].toLowerCase().includes(query.toLowerCase()));
  const first = Math.max(
      0,
      Math.min(indices.length - 1, Math.floor(scroll / 42) - 3),
    ),
    visible = indices.slice(first, first + 22);
  const limit = [run, ...(comparison ? [comparison] : [])].reduce(
    (max, r) =>
      [...r.result.rotation.pattern, ...r.result.structure].reduce(
        (m, row) => row.reduce((v, x) => Math.max(v, Math.abs(x)), m),
        max,
      ),
    0.001,
  );
  const execute = async (task: () => Promise<unknown>) => {
    try {
      setMessage("Working…");
      const value = await task();
      if (typeof value === "string" && /^[a-f0-9-]{36}$/.test(value))
        setCompareId(value);
      setMessage(
        typeof value === "string" && !/^[a-f0-9-]{36}$/.test(value)
          ? value
          : "Completed.",
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };
  const review = (column: string, change: Partial<ItemReview>) =>
    actions.reviews(run.id, {
      ...run.reviews,
      [column]: {
        ...(run.reviews[column] ?? { status: "retain", note: "" }),
        ...change,
      },
    });
  const pairCounts = useMemo(() => {
    const m = run.spec.items.map((_, i) =>
      run.spec.items.map((__, j) =>
        i === j ? run.result.correlation.counts[i] : 0,
      ),
    );
    run.result.correlation.pairs.forEach(
      (p) => (m[p.i][p.j] = m[p.j][p.i] = p.n),
    );
    return m;
  }, [run]);
  const comparisonCounts = useMemo(() => {
    if (!comparison) return [];
    const m = comparison.spec.items.map((_, i) =>
      comparison.spec.items.map((__, j) =>
        i === j ? comparison.result.correlation.counts[i] : 0,
      ),
    );
    for (const pair of comparison.result.correlation.pairs)
      m[pair.i][pair.j] = m[pair.j][pair.i] = pair.n;
    return m;
  }, [comparison]);
  const residualScale = Math.max(
    0.01,
    ...[run, ...(comparison ? [comparison] : [])].map((r) =>
      r.result.residuals.reduce(
        (max, row) => row.reduce((m, v) => Math.max(m, Math.abs(v)), max),
        0,
      ),
    ),
  );
  const matrixIndices = alignment?.ai ?? items.map((_, i) => i);
  const title = `${run.spec.label} · revision ${run.revision}`;
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="efa-results-title"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        if (e.key === "Tab") {
          const nodes = Array.from(
            e.currentTarget.querySelectorAll<HTMLElement>(
              "button:not(:disabled), input:not(:disabled), select:not(:disabled), summary",
            ),
          ).filter((n) => n.getClientRects().length);
          const first = nodes[0],
            last = nodes.at(-1);
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last?.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }
      }}
      className="fixed inset-4 z-[120] flex flex-col bg-[var(--background)] text-[var(--foreground)] border-2 border-[var(--border)] shadow-xl rounded p-5 gap-3 overflow-hidden"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="efa-results-title" className="font-bold text-xl">
            EFA · {title}
          </h2>
          <p className="text-xs">
            Two-step polychoric ·{" "}
            {(run.spec.extraction ?? "minres").toUpperCase()} ·{" "}
            {run.spec.rotation} · {run.spec.missing} deletion ·{" "}
            {run.result.fittingRows.length.toLocaleString()} fitting rows ·{" "}
            {run.spec.items.length} items · {run.spec.nFactors} factors
          </p>
        </div>
        <button autoFocus className={button} onClick={onClose}>
          Close results
        </button>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <label className="text-xs">
          Saved run{" "}
          <select
            className={control}
            value={run.id}
            aria-label="Saved run"
            onChange={(e) => {
              onSelect(e.target.value);
              setScroll(0);
            }}
          >
            {state.runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.spec.label} r{r.revision} · {r.kind}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          Compare with{" "}
          <select
            className={control}
            value={compareId}
            aria-label="Compare with"
            onChange={(e) => {
              setCompareId(e.target.value);
              actions.openHoldout(e.target.value);
            }}
          >
            <option value="">No comparison</option>
            {state.runs
              .filter((r) => r.id !== run.id)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.spec.label} r{r.revision} · {r.kind}
                </option>
              ))}
          </select>
        </label>
        <button
          className={button}
          onClick={() => void execute(() => actions.addScores(run.id))}
        >
          Add scores to dataset
        </button>
        <button
          className={button}
          onClick={() =>
            download(
              `${run.spec.label}-r${run.revision}.csv`,
              serializeEfaCsv(run),
              "text/csv;charset=utf-8",
            )
          }
        >
          Export loadings CSV
        </button>
        <button
          className={button}
          onClick={() =>
            download(
              `${run.spec.label}-r${run.revision}.efa.json`,
              JSON.stringify(
                {
                  format: 1,
                  run,
                  split: state.splits.find(
                    (s) => s.id === run.spec.sample.splitId,
                  ),
                },
                null,
                2,
              ),
              "application/json",
            )
          }
        >
          Export complete JSON
        </button>
      </div>
      <p className="text-xs">
        Scores are linear regression approximations for ordinal responses, on
        complete fitting rows only. RMS off-diagonal residual:{" "}
        {number(run.result.rmsr)}. Factor variance is shared when factors
        correlate.
      </p>
      {comparison && !alignment && (
        <p role="status">
          These runs have no shared items. Select a run with overlapping items
          to align factors.
        </p>
      )}
      {alignment && comparison && (
        <div className="text-xs border-l-4 border-[var(--primary)] pl-3">
          <p>
            {comparison.kind === "structure-replication"
              ? "Structure replication"
              : "Aligned comparison"}{" "}
            · {alignment.shared.length} shared items ·{" "}
            {run.result.fittingRows.length} /{" "}
            {comparison.result.fittingRows.length} fitting rows ·{" "}
            {alignment.sameDatasetRevision
              ? alignment.commonRows
              : "unverified"}{" "}
            shared row positions.{" "}
            {alignment.sameRows
              ? "Same fitting membership."
              : "Fitting membership differs."}
          </p>
          <p>
            Factor congruence: {alignment.congruence.map(number).join(", ")}.
            Unmatched comparison factors:{" "}
            {alignment.unmatchedCandidate.map((i) => `F${i + 1}`).join(", ") ||
              "none"}
            . {alignment.removedItems} removed / {alignment.addedItems} added
            items. Matching uses signs and permutations only.
          </p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {(
          [
            "pattern",
            "structure",
            "phi",
            "residuals",
            "correlation",
            "counts",
            "diagnostics",
            "stability",
          ] as const
        ).map((v) => (
          <button
            className={button}
            aria-pressed={view === v}
            key={v}
            onClick={() => setView(v)}
          >
            {v === "phi"
              ? "Factor correlations"
              : v === "counts"
                ? "Pair sample sizes"
                : v === "pattern"
                  ? "Pattern"
                  : v === "structure"
                    ? "Structure"
                    : v === "stability"
                      ? "Resampling stability"
                      : v}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        <EfaWeightedSummary result={run.result} />
        {view === "pattern" || view === "structure" ? (
          <>
            <div className="mb-3 text-xs space-y-1">
              <p className="font-bold">
                {view === "pattern" ? "Pattern" : "Structure"}{" "}
                {heat ? "heatmap" : "coefficients"}
              </p>
              <p>
                {view === "pattern"
                  ? "Pattern coefficients describe each factor’s contribution while accounting for the other factors."
                  : "Structure coefficients describe item–factor correlations, including the relationships among factors."}{" "}
                Review flags always use the pattern coefficients.
              </p>
            </div>
            <div className="flex flex-wrap gap-4 items-center mb-2">
              <label className="text-xs">
                Find item{" "}
                <input
                  className={control}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setScroll(0);
                  }}
                />
              </label>
              <label className="text-xs">
                <input
                  type="checkbox"
                  checked={heat}
                  onChange={(e) => setHeat(e.target.checked)}
                />{" "}
                Loading heatmap
              </label>
              {(run.result.weighted?.robust ||
                comparison?.result.weighted?.robust) && (
                <label className="text-xs">
                  <input
                    type="checkbox"
                    checked={showSE}
                    onChange={(e) => setShowSE(e.target.checked)}
                  />{" "}
                  Show robust SE in parentheses
                </label>
              )}
              <span className="text-xs">
                {heat
                  ? `Shared scale −${limit.toFixed(2)} to +${limit.toFixed(2)}`
                  : "Coefficients shown to 3 decimals; CSV and JSON retain full precision."}
              </span>
              {heat && (
                <div
                  className="flex text-xs tabular-nums"
                  aria-label="Loading color legend"
                >
                  {[-limit, 0, limit].map((value) => (
                    <span
                      key={value}
                      className="px-3 py-1 border border-[var(--border)]"
                      style={color(value, limit)}
                    >
                      {value > 0 ? "+" : ""}
                      {value.toFixed(2)}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="flex gap-3 text-xs mb-2">
              <label>
                Flag primary |loading| below{" "}
                <input
                  className={`${control} max-w-20`}
                  type="number"
                  step={0.05}
                  min={0}
                  value={weak}
                  onChange={(e) => setWeak(+e.target.value)}
                />
              </label>
              <label>
                Flag next |loading| above{" "}
                <input
                  className={`${control} max-w-20`}
                  type="number"
                  step={0.05}
                  min={0}
                  value={cross}
                  onChange={(e) => setCross(+e.target.value)}
                />
              </label>
              <label>
                Flag gap below{" "}
                <input
                  className={`${control} max-w-20`}
                  type="number"
                  step={0.05}
                  min={0}
                  value={gap}
                  onChange={(e) => setGap(+e.target.value)}
                />
              </label>
              <p>
                Review flags are adjustable heuristics. They never remove items
                automatically.
              </p>
            </div>
            <div
              key={`${run.id}-${query}`}
              className="overflow-auto border border-[var(--border)] max-h-[60vh]"
              onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
            >
              <table
                className="w-full text-xs border-collapse"
                aria-rowcount={indices.length + 1}
                aria-label={`${view} ${heat ? "heatmap" : "loading table"}`}
              >
                <thead className="sticky top-0 bg-[var(--background)] z-20">
                  <tr>
                    <th className="p-2 text-left sticky left-0 bg-[var(--background)]">
                      Item
                    </th>
                    {factors.map((f) => (
                      <th key={f} className="p-2">
                        {f}
                        {comparison ? " · baseline / comparison" : ""}
                      </th>
                    ))}
                    <th>Primary / next / gap</th>
                    <th>h²</th>
                    <th>u²</th>
                    <th>Related item · r</th>
                    <th>Review</th>
                    <th>Substantive note</th>
                  </tr>
                </thead>
                <tbody>
                  {first > 0 && (
                    <tr aria-hidden="true">
                      <td
                        colSpan={factors.length + 7}
                        style={{ height: first * 42 }}
                      />
                    </tr>
                  )}
                  {visible.map((i, row) => {
                    const values =
                        view === "pattern"
                          ? run.result.rotation.pattern[i]
                          : run.result.structure[i],
                      sorted = run.result.rotation.pattern[i]
                        .map(Math.abs)
                        .sort((a, b) => b - a),
                      sharedIndex = alignment?.shared.indexOf(items[i]) ?? -1;
                    const other =
                      sharedIndex < 0
                        ? null
                        : alignment!.mapping.map((f, j) =>
                            f === null
                              ? null
                              : (view === "pattern"
                                  ? comparison!.result.rotation.pattern
                                  : comparison!.result.structure)[
                                  alignment!.bi[sharedIndex]
                                ][f] * alignment!.signs[j],
                          );
                    const related = run.result.correlation.matrix[i]
                      .map((r, j) => ({ r, j }))
                      .filter((x) => x.j !== i)
                      .sort((a, b) => Math.abs(b.r) - Math.abs(a.r))[0];
                    return (
                      <tr
                        key={items[i]}
                        aria-rowindex={first + row + 2}
                        style={{ height: 42 }}
                        className="border-t border-[var(--border)]"
                      >
                        <th
                          scope="row"
                          className="sticky left-0 bg-[var(--background)] text-left p-2 max-w-56 truncate"
                          title={items[i]}
                        >
                          <button
                            className="text-left underline"
                            onClick={() => setMessage(items[i])}
                          >
                            {items[i]}
                          </button>
                        </th>
                        {values.map((v, f) => (
                          <td
                            className="p-2 text-right tabular-nums whitespace-nowrap"
                            style={heat && !comparison ? color(v, limit) : {}}
                            key={f}
                          >
                            {comparison ? (
                              <div className="grid grid-cols-2 gap-px">
                                <span
                                  className="px-2 py-1"
                                  aria-label={`Baseline ${factors[f]}: ${number(v)}`}
                                  style={heat ? color(v, limit) : {}}
                                >
                                  {number(v)}
                                  {showSE && run.result.weighted?.robust
                                    ? ` (${number(run.result.weighted.robust.standardErrors[view][i][f])})`
                                    : ""}
                                </span>
                                <span
                                  className="px-2 py-1"
                                  aria-label={`Comparison ${factors[f]}: ${number(other?.[f])}`}
                                  style={
                                    heat && other?.[f] != null
                                      ? color(other[f]!, limit)
                                      : {}
                                  }
                                >
                                  {number(other?.[f])}
                                  {showSE &&
                                  comparison.result.weighted?.robust &&
                                  sharedIndex >= 0 &&
                                  alignment?.mapping[f] != null
                                    ? ` (${number(comparison.result.weighted.robust.standardErrors[view][alignment.bi[sharedIndex]][alignment.mapping[f]!])})`
                                    : ""}
                                </span>
                              </div>
                            ) : (
                              `${number(v)}${showSE && run.result.weighted?.robust ? ` (${number(run.result.weighted.robust.standardErrors[view][i][f])})` : ""}`
                            )}
                          </td>
                        ))}
                        <td className="p-2 whitespace-nowrap">
                          {number(sorted[0])} / {number(sorted[1] ?? 0)} /{" "}
                          {number(sorted[0] - (sorted[1] ?? 0))}
                          <span className="block">
                            {[
                              sorted[0] < weak ? "weak loading" : "",
                              (sorted[1] ?? 0) > cross ? "cross-loading" : "",
                              sorted[0] - (sorted[1] ?? 0) < gap
                                ? "small gap"
                                : "",
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </td>
                        <td className="p-2">
                          {number(run.result.communalities[i])}
                          {showSE && run.result.weighted?.robust
                            ? ` (${number(run.result.weighted.robust.standardErrors.communalities[i])})`
                            : ""}
                          {comparison &&
                            ` / ${number(sharedIndex < 0 ? null : comparison.result.communalities[alignment!.bi[sharedIndex]])}`}
                        </td>
                        <td className="p-2">
                          {number(run.result.uniquenesses[i])}
                          {showSE && run.result.weighted?.robust
                            ? ` (${number(run.result.weighted.robust.standardErrors.uniquenesses[i])})`
                            : ""}
                          {comparison &&
                            ` / ${number(sharedIndex < 0 ? null : comparison.result.uniquenesses[alignment!.bi[sharedIndex]])}`}
                        </td>
                        <td
                          className="p-2 max-w-36 truncate"
                          title={`${items[related.j]}: ${related.r}`}
                        >
                          {items[related.j]} · {number(related.r)}
                        </td>
                        <td>
                          <select
                            aria-label={`Review ${items[i]}`}
                            className={control}
                            value={run.reviews[items[i]]?.status ?? "retain"}
                            onChange={(e) =>
                              review(items[i], {
                                status: e.target.value as ItemReview["status"],
                              })
                            }
                          >
                            {["retain", "investigate", "exclude"].map((v) => (
                              <option key={v}>{v}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            aria-label={`Note ${items[i]}`}
                            className={control}
                            value={run.reviews[items[i]]?.note ?? ""}
                            onChange={(e) =>
                              review(items[i], { note: e.target.value })
                            }
                          />
                        </td>
                      </tr>
                    );
                  })}
                  {first + visible.length < indices.length && (
                    <tr aria-hidden="true">
                      <td
                        colSpan={factors.length + 7}
                        style={{
                          height:
                            (indices.length - first - visible.length) * 42,
                        }}
                      />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="text-xs mt-2">
              Review revision {run.reviewRevision ?? 0}. Retain and investigate
              items remain in a refit. Exclude is applied only when you select
              “Refit selection”. No loading cutoff assigns membership or removes
              items automatically.
            </p>
          </>
        ) : view === "stability" ? (
          <StabilityPanel
            key={run.id}
            run={run}
            state={state}
            table={table}
            actions={actions}
            job={job}
          />
        ) : view === "diagnostics" ? (
          <div className="space-y-2 text-xs">
            <p>
              {(run.result.extraction.estimator ?? "minres").toUpperCase()}:{" "}
              {run.result.extraction.convergence.iterations} iterations;
              objective {run.result.extraction.convergence.objective};{" "}
              {run.result.extraction.estimator === "dwls"
                ? "loading"
                : "projected"}
              gradient {run.result.extraction.convergence.gradient}. Condition
              number: {number(run.result.conditionNumber)}.
            </p>
            {run.result.diagnostics.map((d, i) => (
              <p key={i}>
                {d.code}: {d.message}
              </p>
            ))}
            <details>
              <summary>Category and pair diagnostics</summary>
              <label>
                First pair (20 shown at a time)
                <input
                  className={control}
                  type="number"
                  min={1}
                  max={run.result.correlation.pairs.length}
                  value={pairOffset + 1}
                  onChange={(e) =>
                    setPairOffset(Math.max(0, +e.target.value - 1))
                  }
                />
              </label>
              <pre className="whitespace-pre-wrap max-h-96 overflow-auto">
                {JSON.stringify(
                  {
                    categories: run.spec.items.map((item, i) => ({
                      ...item,
                      counts: run.result.categoryCounts[i],
                    })),
                    pairs: run.result.correlation.pairs.slice(
                      pairOffset,
                      pairOffset + 20,
                    ),
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
            <details>
              <summary>Numerical provenance</summary>
              <pre className="whitespace-pre-wrap">
                {JSON.stringify(run.result.provenance, null, 2)}
              </pre>
            </details>
            <p>
              {run.revisedAfterHoldout
                ? "This candidate was revised after holdout results had been opened."
                : ""}{" "}
              {state.splits.find((s) => s.id === run.spec.sample.splitId)
                ?.afterFullExploration
                ? "This split was created after full-data exploration."
                : ""}{" "}
              This history describes activity within this app, not inspection
              elsewhere.
            </p>
          </div>
        ) : (
          <div
            className="grid gap-5"
            style={{
              gridTemplateColumns: comparison
                ? "repeat(2,minmax(0,1fr))"
                : "1fr",
            }}
          >
            <div>
              <h3 className="font-bold mb-2">{title}</h3>
              <MatrixView
                key={`${run.id}:${view}:${matrixIndices.length}`}
                standardErrors={
                  view === "phi"
                    ? run.result.weighted?.robust?.standardErrors.phi
                    : undefined
                }
                kind={view === "counts" ? "count" : "correlation"}
                scaleLimit={view === "residuals" ? residualScale : undefined}
                rows={view === "phi" ? factors : (alignment?.shared ?? items)}
                columns={
                  view === "phi" ? factors : (alignment?.shared ?? items)
                }
                matrix={
                  view === "phi"
                    ? run.result.rotation.phi
                    : matrixIndices.map((i) =>
                        matrixIndices.map((j) =>
                          view === "counts"
                            ? pairCounts[i][j]
                            : view === "residuals"
                              ? run.result.residuals[i][j]
                              : run.result.correlation.matrix[i][j],
                        ),
                      )
                }
              />
            </div>
            {comparison && alignment && (
              <div>
                <h3 className="font-bold mb-2">
                  {comparison.spec.label} r{comparison.revision}
                </h3>
                <MatrixView
                  key={`${comparison.id}:${view}:${alignment.shared.length}`}
                  standardErrors={
                    view === "phi" && comparison.result.weighted?.robust
                      ? alignment.mapping.map((i) =>
                          alignment.mapping.map((j) =>
                            i === null || j === null
                              ? null
                              : comparison.result.weighted!.robust!
                                  .standardErrors.phi[i][j],
                          ),
                        )
                      : undefined
                  }
                  kind={view === "counts" ? "count" : "correlation"}
                  scaleLimit={view === "residuals" ? residualScale : undefined}
                  rows={view === "phi" ? factors : alignment.shared}
                  columns={view === "phi" ? factors : alignment.shared}
                  matrix={
                    view === "phi"
                      ? alignment.mapping.map((i, a) =>
                          alignment.mapping.map((j, b) =>
                            i === null || j === null
                              ? null
                              : comparison.result.rotation.phi[i][j] *
                                alignment.signs[a] *
                                alignment.signs[b],
                          ),
                        )
                      : alignment.bi.map((i) =>
                          alignment.bi.map((j) =>
                            view === "residuals"
                              ? comparison.result.residuals[i][j]
                              : view === "correlation"
                                ? comparison.result.correlation.matrix[i][j]
                                : comparisonCounts[i][j],
                          ),
                        )
                  }
                />
              </div>
            )}
          </div>
        )}
      </div>
      <div className="border-t border-[var(--border)] pt-3 flex flex-wrap gap-3 items-center text-xs">
        <input
          className={`${control} max-w-80`}
          aria-label="Refit reasons"
          placeholder="Reasons for the next candidate"
          value={reasons}
          onChange={(e) => setReasons(e.target.value)}
        />
        <label>
          <input
            type="checkbox"
            checked={keepRows}
            onChange={(e) => setKeepRows(e.target.checked)}
          />{" "}
          Keep original fitting rows
        </label>
        <button
          className={button}
          onClick={() =>
            void execute(() =>
              actions.run(
                {
                  ...run.spec,
                  items: run.spec.items.filter(
                    (i) => run.reviews[i.column]?.status !== "exclude",
                  ),
                  sample: {
                    ...run.spec.sample,
                    fixedRows: keepRows ? run.result.fittingRows : undefined,
                  },
                },
                {
                  parentId: run.id,
                  kind: "items",
                  reviews: run.reviews,
                  reasons,
                },
              ),
            )
          }
        >
          Refit selection
        </button>
        {(["oblimin", "promax", "varimax"] as const)
          .filter((r) => r !== run.spec.rotation)
          .map((rotation) => (
            <button
              className={button}
              key={rotation}
              onClick={() =>
                void execute(() =>
                  actions.run(
                    { ...run.spec, rotation },
                    {
                      parentId: run.id,
                      kind: "rotation",
                      reviews: run.reviews,
                      reasons: `Rotation comparison: ${rotation}`,
                    },
                  ),
                )
              }
            >
              Compare {rotation}
            </button>
          ))}
        {run.spec.sample.partition === "development" && (
          <button
            className={button}
            onClick={() =>
              void execute(() =>
                actions.run(
                  {
                    ...run.spec,
                    sample: {
                      partition: "holdout",
                      splitId: run.spec.sample.splitId,
                    },
                  },
                  {
                    parentId: run.id,
                    kind: "structure-replication",
                    reviews: run.reviews,
                    reasons:
                      "Independent holdout refit of frozen development specification",
                  },
                ),
              )
            }
          >
            Compare on holdout
          </button>
        )}
        <p>
          Changing items can change complete-case membership; keeping original
          rows fixes that comparison.
        </p>
      </div>
      <p role="status" className="text-xs break-words">
        {message}
      </p>
    </div>,
    document.body,
  );
}

export function EfaPanel({
  service,
  table,
  state,
  actions,
  job,
}: {
  service: EfaService;
  table: DataTable;
  state: EfaState;
  actions: EfaActions;
  job?: EfaJob;
}) {
  const proposed = useMemo(
    () =>
      Object.fromEntries(
        table.columns.map((column) => [
          column,
          proposedCategories(table.data[column]),
        ]),
      ),
    [table],
  );
  const [selected, setSelected] = useState<string[]>([]),
    [orders, setOrders] = useState<Record<string, string>>({}),
    [reverse, setReverse] = useState<Record<string, boolean>>({});
  const [compute, setCompute] = useState<EfaComputeSettings>({ backend: "cpu" });
  const [factors, setFactors] = useState(2),
    [extraction, setExtraction] = useState<EfaEstimator>("minres"),
    [rotation, setRotation] = useState<Rotation>("oblimin"),
    [missing, setMissing] = useState<"pairwise" | "complete" | "mice">(
      "pairwise",
    ),
    [label, setLabel] = useState("Likert"),
    [seed, setSeed] = useState(73021),
    [splitId, setSplitId] = useState(""),
    [partition, setPartition] = useState<"development" | "holdout">(
      "development",
    ),
    [fraction, setFraction] = useState(0.7),
    [groupColumn, setGroupColumn] = useState(""),
    [stratumColumn, setStratumColumn] = useState(""),
    [sourceColumn, setSourceColumn] = useState(""),
    [developmentValue, setDevelopmentValue] = useState("development"),
    [holdoutValue, setHoldoutValue] = useState("holdout"),
    [splitMode, setSplitMode] = useState("create");
  const [message, setMessage] = useState(""),
    [search, setSearch] = useState(""),
    [results, setResults] = useState(""),
    [preview, setPreview] = useState<{
      nRows: number;
      counts: number[][];
      key: string;
      columns: string[];
      inferencePlan?: InferencePlan;
    } | null>(null),
    [parallel, setParallel] = useState<ParallelResult | null>(null),
    [replicates, setReplicates] = useState(100);
  const [imputations, setImputations] = useState(20),
    [sweeps, setSweeps] = useState(10),
    [predictorEncoding, setPredictorEncoding] = useState<
      "ordered-polynomial" | "rank"
    >("ordered-polynomial"),
    [predictors, setPredictors] = useState<Record<string, string[]>>({}),
    [target, setTarget] = useState(""),
    [miceResults, setMiceResults] = useState("");
  const predictorTarget = selected.includes(target) ? target : selected[0],
    targetPredictors =
      predictors[predictorTarget] ??
      selected.filter((c) => c !== predictorTarget);
  const busy = job?.status === "running";
  const setupKey = JSON.stringify({
    compute,
    selected,
    orders,
    reverse,
    factors,
    extraction,
    rotation,
    missing,
    label,
    seed,
    splitId,
    partition,
  });
  const previewCurrent = preview?.key === setupKey;
  const runtimeAdvice = missing !== "mice" && previewCurrent && preview.inferencePlan
    ? mvRuntimeAdvice(preview.inferencePlan, compute.probes ?? 128,
      preview.counts.reduce((sum, categories, i) => sum + preview.counts.slice(i + 1).reduce((s, other) => s + categories.length * other.length, 0), 0))
    : undefined;
  const simulation = parallel ?? state.parallelRuns?.at(-1)?.result;
  const makeSpec = (): EfaSpec => ({
    items: selected.map((column) => {
      let categories: OrdinalCategory[];
      try {
        categories = orders[column]
          ? JSON.parse(orders[column])
          : (proposed[column] ?? []);
      } catch {
        throw new Error(`Enter a JSON category array for ${column}.`);
      }
      if (!Array.isArray(categories))
        throw new Error(`Enter a JSON category array for ${column}.`);
      return { column, categories, reverse: reverse[column] ?? false };
    }),
    nFactors: factors,
    compute: extraction === "wlsmv" ? compute : { backend: "cpu" },
    extraction,
    rotation,
    missing: missing === "mice" ? "pairwise" : missing,
    seed,
    label,
    sample: splitId ? { splitId, partition } : { partition: "all" },
  });
  const makeMiceOptions = (): MiceOptions => ({
    imputations,
    iterations: sweeps,
    seed,
    predictorEncoding,
    predictors: selected.map((column, i) =>
      (predictors[column] ?? selected.filter((_, j) => i !== j)).flatMap(
        (name) => {
          const j = selected.indexOf(name);
          return j >= 0 && j !== i ? [j] : [];
        },
      ),
    ),
  });
  const act = async (fn: () => Promise<unknown>) => {
    try {
      setMessage("");
      await fn();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };
  const makeSplit = () => {
    try {
      const split = actions.split({
        seed,
        fraction,
        groupColumn: groupColumn || undefined,
        stratumColumn: stratumColumn || undefined,
        ...(splitMode === "existing"
          ? { sourceColumn, developmentValue, holdoutValue }
          : {}),
      });
      setSplitId(split.id);
      setMessage(
        `Saved membership: ${split.development.length} development / ${split.holdout.length} holdout rows.`,
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="space-y-3 text-xs" data-guide="efa">
      <p>
        Ordinal common-factor analysis. Review category order, then preview the
        fitting sample. Numeric categories are proposed in ascending order; text
        needs an explicit order.
      </p>
      <input
        className={control}
        placeholder="Find items"
        aria-label="Find EFA items"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="flex gap-2">
        <button
          className={button}
          onClick={() =>
            setSelected(
              table.columns.filter(
                (c) =>
                  proposed[c] &&
                  proposed[c]!.length >= 2 &&
                  proposed[c]!.length <= 20,
              ),
            )
          }
        >
          Select ordinal candidates
        </button>
        <button className={button} onClick={() => setSelected([])}>
          Clear
        </button>
      </div>
      <div className="max-h-44 overflow-auto space-y-1 border border-[var(--border)] p-2">
        {table.columns
          .filter((c) => c.toLowerCase().includes(search.toLowerCase()))
          .map((c) => (
            <label className="block break-words" key={c}>
              <input
                type="checkbox"
                checked={selected.includes(c)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? [...selected, c]
                      : selected.filter((x) => x !== c),
                  )
                }
              />{" "}
              {c}
            </label>
          ))}
      </div>
      <details>
        <summary>
          Review category order and reverse keys · {selected.length} items
        </summary>
        <div className="max-h-56 overflow-auto space-y-2 py-2">
          {selected.map((c) => (
            <div key={c}>
              <label className="block break-words">
                {c}
                <input
                  aria-label={`Category order ${c}`}
                  className={control}
                  value={orders[c] ?? JSON.stringify(proposed[c] ?? [])}
                  onChange={(e) =>
                    setOrders({ ...orders, [c]: e.target.value })
                  }
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={reverse[c] ?? false}
                  onChange={(e) =>
                    setReverse({ ...reverse, [c]: e.target.checked })
                  }
                />{" "}
                Reverse key for this analysis
              </label>
            </div>
          ))}
        </div>
      </details>
      <div className="grid grid-cols-2 gap-2">
        <label className="col-span-2">
          Extraction
          <select
            className={control}
            aria-label="EFA extraction"
            value={extraction}
            onChange={(e) => setExtraction(e.target.value as EfaEstimator)}
          >
            <option value="minres">MINRES</option>
            <option value="dwls">DWLS · ordinal variance weights</option>
            <option value="wlsmv">WLSMV · DWLS + robust inference</option>
          </select>
        </label>
        {extraction === "wlsmv" && <EfaBackendControls value={compute} onChange={setCompute} service={service} disabled={!!busy} />}
        {extraction === "wlsmv" && compute.backend !== "cpu" && missing === "mice" && <p role="alert" className="col-span-2 text-xs">Accelerated MICE is not connected yet. Select Browser CPU explicitly to run imputation.</p>}
        <label>
          Factors
          <input
            className={control}
            type="number"
            min={1}
            max={499}
            value={factors}
            onChange={(e) => setFactors(+e.target.value)}
          />
        </label>
        <label>
          Rotation
          <select
            className={control}
            value={rotation}
            onChange={(e) => setRotation(e.target.value as Rotation)}
          >
            <option>oblimin</option>
            <option>promax</option>
            <option>varimax</option>
          </select>
        </label>
        <label>
          Missing values
          <select
            className={control}
            value={missing}
            aria-label="Missing values"
            onChange={(e) =>
              setMissing(e.target.value as "pairwise" | "complete" | "mice")
            }
          >
            <option value="pairwise">Pairwise deletion</option>
            <option value="complete">Complete cases</option>
            <option value="mice">
              Ordinal MICE · separate fitted imputations
            </option>
          </select>
        </label>
        <label>
          Run label
          <input
            className={control}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
      </div>
      {missing === "mice" && (
        <details open>
          <summary>Ordinal MICE settings</summary>
          <p className="my-2">
            Observed cells stay unchanged. Each completed imputation receives
            its own EFA; the summary describes between-imputation variation.
            Select predictors explicitly and inspect iteration traces after
            fitting.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <label>
              Imputations
              <input
                className={control}
                type="number"
                min={2}
                max={100}
                value={imputations}
                onChange={(e) => setImputations(+e.target.value)}
              />
            </label>
            <label>
              Sweeps per imputation
              <input
                className={control}
                type="number"
                min={1}
                max={100}
                value={sweeps}
                onChange={(e) => setSweeps(+e.target.value)}
              />
            </label>
            <label>
              Predictor coding
              <select
                className={control}
                value={predictorEncoding}
                aria-label="Predictor coding"
                onChange={(e) =>
                  setPredictorEncoding(
                    e.target.value as "ordered-polynomial" | "rank",
                  )
                }
              >
                <option value="ordered-polynomial">
                  Ordered-factor contrasts
                </option>
                <option value="rank">
                  Ordinal ranks · linear predictor effect
                </option>
              </select>
            </label>
            <label>
              Imputation seed
              <input
                className={control}
                type="number"
                value={seed}
                onChange={(e) => setSeed(+e.target.value)}
              />
            </label>
          </div>
          <p className="my-2">
            Ordered-factor contrasts use one column per category minus one.
            Large predictor sets can require substantial time and memory;
            predictors are never removed automatically.
          </p>
          {predictorTarget && (
            <>
              <label>
                Predictors for
                <select
                  className={control}
                  value={predictorTarget}
                  aria-label="Predictors for"
                  onChange={(e) => setTarget(e.target.value)}
                >
                  {selected.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <div className="flex gap-2 my-2">
                <button
                  className={button}
                  onClick={() =>
                    setPredictors({
                      ...predictors,
                      [predictorTarget]: selected.filter(
                        (c) => c !== predictorTarget,
                      ),
                    })
                  }
                >
                  All other selected items
                </button>
                <button
                  className={button}
                  onClick={() =>
                    setPredictors({ ...predictors, [predictorTarget]: [] })
                  }
                >
                  Intercept only
                </button>
              </div>
              <div className="max-h-32 overflow-auto border border-[var(--border)] p-2">
                {selected
                  .filter((c) => c !== predictorTarget)
                  .map((c) => (
                    <label className="block break-words" key={c}>
                      <input
                        type="checkbox"
                        checked={targetPredictors.includes(c)}
                        onChange={(e) =>
                          setPredictors({
                            ...predictors,
                            [predictorTarget]: e.target.checked
                              ? [...targetPredictors, c]
                              : targetPredictors.filter((x) => x !== c),
                          })
                        }
                      />{" "}
                      {c}
                    </label>
                  ))}
              </div>
            </>
          )}
        </details>
      )}
      <label className="block">
        Sample
        <select
          className={control}
          value={splitId}
          onChange={(e) => setSplitId(e.target.value)}
        >
          <option value="">All eligible respondents</option>
          {state.splits.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label} · {s.development.length}/{s.holdout.length}
            </option>
          ))}
        </select>
      </label>
      {splitId && (
        <label className="block">
          Partition
          <select
            className={control}
            value={partition}
            onChange={(e) =>
              setPartition(e.target.value as "development" | "holdout")
            }
          >
            <option value="development">Development</option>
            <option value="holdout">Holdout · structure exploration</option>
          </select>
        </label>
      )}
      <details>
        <summary>Create or choose a development / holdout split</summary>
        <div className="space-y-2 py-2">
          <select
            aria-label="Split method"
            className={control}
            value={splitMode}
            onChange={(e) => setSplitMode(e.target.value)}
          >
            <option value="create">Create random split</option>
            <option value="existing">Use existing split column</option>
          </select>
          <label>
            Saved seed
            <input
              className={control}
              type="number"
              value={seed}
              onChange={(e) => setSeed(+e.target.value)}
            />
          </label>
          {splitMode === "create" ? (
            <>
              <label>
                Development proportion
                <input
                  className={control}
                  type="number"
                  min={0.01}
                  max={0.99}
                  step={0.05}
                  value={fraction}
                  onChange={(e) => setFraction(+e.target.value)}
                />
              </label>
              {[
                ["Keep groups together", groupColumn, setGroupColumn],
                ["Stratify by", stratumColumn, setStratumColumn],
              ].map(([name, value, setter]) => (
                <label key={String(name)} className="block">
                  {String(name)}
                  <select
                    className={control}
                    value={String(value)}
                    onChange={(e) =>
                      (setter as (v: string) => void)(e.target.value)
                    }
                  >
                    <option value="">None</option>
                    {table.columns.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
              ))}
            </>
          ) : (
            <>
              <select
                className={control}
                aria-label="Existing split column"
                value={sourceColumn}
                onChange={(e) => setSourceColumn(e.target.value)}
              >
                <option value="">Choose column</option>
                {table.columns.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
              <label>
                Development value
                <input
                  className={control}
                  value={developmentValue}
                  onChange={(e) => setDevelopmentValue(e.target.value)}
                />
              </label>
              <label>
                Holdout value
                <input
                  className={control}
                  value={holdoutValue}
                  onChange={(e) => setHoldoutValue(e.target.value)}
                />
              </label>
            </>
          )}
          <button className={button} onClick={makeSplit}>
            Save split membership
          </button>
          <p>
            Grouping targets the proportion of independent groups. Actual
            respondent counts may differ. Membership persists across item edits.
          </p>
        </div>
      </details>
      <div className="flex gap-2">
        <button
          className={button}
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const p = await actions.preview(makeSpec());
              setPreview({ ...p, key: setupKey, columns: selected.slice() });
            })
          }
        >
          Preview sample
        </button>
        <button
          className={button}
          disabled={busy || selected.length < 3 || !previewCurrent}
          onClick={() =>
            void act(async () => {
              if (missing === "mice")
                setMiceResults(
                  await actions.impute(makeSpec(), makeMiceOptions()),
                );
              else setResults(await actions.run(makeSpec()));
            })
          }
        >
          {missing === "mice" ? "Run MICE + EFA" : "Run EFA"}
        </button>
        {busy && (
          <button className={button} onClick={actions.cancel}>
            Cancel
          </button>
        )}
      </div>
      {preview && (
        <details open>
          <summary>
            Preview: {preview.nRows} fitting rows
            {!previewCurrent ? " · settings changed; preview again" : ""}
          </summary>
          {previewCurrent && preview.inferencePlan && (
            <p className="my-2">
              {compute.correction === "estimated" ? "WLSMV with estimated MV correction" : "Exact WLSMV inference"}: about{" "}
              {Math.ceil(
                preview.inferencePlan.estimatedBytes / 1024 ** 2,
              ).toLocaleString()}{" "}
              MiB working estimate and{" "}
              {preview.inferencePlan.approximateMultiplyAdds.toLocaleString(
                undefined,
                { maximumFractionDigits: 0 },
              )}{" "}
              multiply-add operations. Large jobs may take substantially longer
              than DWLS point fitting.
              {missing === "mice"
                ? ` This is repeated separately for each of ${imputations} imputations.`
                : ""}
            </p>
          )}
          {runtimeAdvice && <div className="my-2 border p-2 text-xs" aria-label="Runtime guidance">
            <p className="font-bold">{runtimeAdvice.title}<InfoTip label="About runtime guidance" text="Uses the preview's fitting rows, item pairs, factors, probe count and memory plan. Arithmetic estimates are not device benchmarks. The choice remains yours; no backend or correction is changed automatically. Matrix structure determines estimation error, so there is no reliable rows × items accuracy cutoff." /></p>
            <p>{runtimeAdvice.detail}</p>
          </div>}
          <div className="max-h-32 overflow-auto">
            {preview.counts.map((counts, i) => (
              <p key={i}>
                {preview.columns[i]}: {counts.join(" / ")} responses per ordered
                category
              </p>
            ))}
          </div>
        </details>
      )}
      {job && (
        <p role="status">
          {job.progress.stage}: {job.progress.completed} / {job.progress.total}{" "}
          · {job.status}
          {job.error ? ` · ${job.error}` : ""}
        </p>
      )}
      <p role="alert" className="break-words">
        {message}
      </p>
      <details>
        <summary>Factor parallel analysis</summary>
        {missing === "mice" && (
          <p>
            Parallel analysis uses the observed responses with pairwise
            deletion. It does not combine null distributions across imputations.
          </p>
        )}
        <p>
          Explicit permutation batch; preserves each item’s missingness mask.
          The same one-factor MINRES communality convention is used for observed
          and null data. Large jobs can take substantially longer than a fit.
        </p>
        <label>
          Permutations
          <input
            className={control}
            type="number"
            min={1}
            max={1000}
            value={replicates}
            onChange={(e) => setReplicates(+e.target.value)}
          />
        </label>
        <button
          className={button}
          disabled={busy}
          onClick={() =>
            void act(async () =>
              setParallel(await actions.parallel(makeSpec(), replicates)),
            )
          }
        >
          Run parallel analysis
        </button>
        {simulation && (
          <div>
            <p>
              {simulation.completed}/{simulation.requested} successful
              replicates.{" "}
              {simulation.suggested === null
                ? "Incomplete: no factor-count suggestion."
                : `Sequential eigenvalue comparison suggests ${simulation.suggested} factors; review substantively.`}
            </p>
            <p>
              Observed: {simulation.observed.map(number).join(", ")}
              <br />
              95th percentile: {simulation.reference.map(number).join(", ")}
            </p>
            <button
              className={button}
              onClick={() =>
                download(
                  "parallel-analysis.json",
                  JSON.stringify(
                    state.parallelRuns?.at(-1) ?? simulation,
                    null,
                    2,
                  ),
                  "application/json",
                )
              }
            >
              Export simulation
            </button>
          </div>
        )}
      </details>
      {state.runs.length > 0 && (
        <button
          className={`${button} w-full`}
          onClick={() => setResults(state.runs.at(-1)!.id)}
        >
          Open EFA results · {state.runs.length} saved runs
        </button>
      )}
      {!!state.imputationRuns?.length && (
        <button
          className={`${button} w-full`}
          onClick={() => setMiceResults(state.imputationRuns!.at(-1)!.id)}
        >
          Open MICE results · {state.imputationRuns!.length} saved analyses
        </button>
      )}
      {miceResults && !!state.imputationRuns?.length && (
        <ImputationResults
          state={state}
          activeId={miceResults}
          onSelect={setMiceResults}
          onClose={() => setMiceResults("")}
          actions={actions}
          job={job}
        />
      )}
      {results && state.runs.length > 0 && (
        <Results
          state={state}
          activeId={results}
          onSelect={(id) => {
            setResults(id);
            actions.openHoldout(id);
          }}
          actions={actions}
          table={table}
          job={job}
          onClose={() => setResults("")}
        />
      )}
    </div>
  );
}
