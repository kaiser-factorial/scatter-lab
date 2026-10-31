"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CSV_BOM, csvCell } from "@/lib/csv";
import type { DataTable } from "@/lib/table";
import type { EfaState, EfaRun, ItemReview } from "@/lib/efa/types";
import type { EfaJob } from "@/lib/efa/service";
import type { EfaActions } from "./EfaPanel";
const button =
  "border border-[var(--border)] bg-[var(--input)] rounded px-3 py-1 text-xs font-bold disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2";
const control =
  "border border-[var(--border)] bg-[var(--input)] rounded px-2 py-1 text-xs";
const num = (x: number | null | undefined) => (x == null ? "—" : x.toFixed(3));
const color = (x: number | null | undefined, limit: number) =>
  x == null
    ? {}
    : {
        backgroundColor: `color-mix(in srgb, ${x < 0 ? "#b35806" : "#0571b0"} ${Math.min(80, (Math.abs(x) / Math.max(limit, 0.001)) * 80)}%, var(--background))`,
      };
function download(name: string, value: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([value], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const csv = (rows: unknown[][]) =>
  CSV_BOM +
  rows
    .map((row) =>
      row.map((v) => csvCell(v as string | number | null)).join(","),
    )
    .join("\r\n");
function BatchDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (dialog.current?.contains(document.activeElement)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key === "Tab") {
        event.preventDefault();
        dialog.current
          ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
          ?.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  return createPortal(
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-4 z-[120] flex flex-col bg-[var(--background)] text-[var(--foreground)] border-2 border-[var(--border)] shadow-xl rounded p-5 gap-3 overflow-hidden"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        if (e.key === "Tab") {
          const nodes = Array.from(
              e.currentTarget.querySelectorAll<HTMLElement>(
                "button:not(:disabled),input:not(:disabled),select:not(:disabled),summary",
              ),
            ).filter((n) => n.getClientRects().length),
            first = nodes[0],
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
    >
      <div className="flex justify-between gap-3">
        <h2 className="font-bold text-xl">{title}</h2>
        <button autoFocus className={button} onClick={onClose}>
          Close results
        </button>
      </div>
      {children}
    </div>,
    document.body,
  );
}
export function ImputationResults({
  state,
  activeId,
  onSelect,
  onClose,
  actions,
  job,
}: {
  state: EfaState;
  activeId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  actions: EfaActions;
  job?: EfaJob;
}) {
  const run =
      state.imputationRuns!.find((r) => r.id === activeId) ??
      state.imputationRuns!.at(-1)!,
    r = run.result;
  const [view, setView] = useState<"pattern" | "structure">("pattern"),
    [chain, setChain] = useState("summary"),
    [scroll, setScroll] = useState(0),
    [query, setQuery] = useState(""),
    [message, setMessage] = useState(""),
    [reasons, setReasons] = useState(""),
    [traceItem, setTraceItem] = useState(0),
    [tracePage, setTracePage] = useState(0);
  useEffect(() => actions.openHoldout(run.id), [actions, run.id]);
  const indices = run.spec.items
      .map((_, i) => i)
      .filter((i) =>
        run.spec.items[i].column.toLowerCase().includes(query.toLowerCase()),
      ),
    first = Math.max(
      0,
      Math.min(indices.length - 1, Math.floor(scroll / 42) - 3),
    ),
    visible = indices.slice(first, first + 22);
  const selected = r.aligned.find((f) => String(f.replicate) === chain),
    limit = r.aligned.reduce(
      (m, a) =>
        [...a.pattern, ...a.structure].reduce(
          (max, row) => row.reduce((v, x) => Math.max(v, Math.abs(x)), max),
          m,
        ),
      0.001,
    );
  const review = (column: string, change: Partial<ItemReview>) =>
    actions.imputationReviews(run.id, {
      ...run.reviews,
      [column]: {
        ...(run.reviews[column] ?? { status: "retain", note: "" }),
        ...change,
      },
    });
  const activeTraceItem = Math.min(traceItem, run.spec.items.length - 1);
  const traces = r.trace.filter((t) => t.item === activeTraceItem),
    traceStart = Math.min(tracePage * 20, Math.max(0, traces.length - 1));
  const exportCsv = () =>
    download(
      `${run.spec.label}-imputations.csv`,
      csv([
        [
          "imputation",
          "item",
          ...Array.from(
            { length: run.spec.nFactors },
            (_, i) => `pattern_F${i + 1}`,
          ),
          ...Array.from(
            { length: run.spec.nFactors },
            (_, i) => `structure_F${i + 1}`,
          ),
          "communality",
          "uniqueness",
          "status",
          "note",
        ],
        ...r.aligned.flatMap((f) =>
          run.spec.items.map((item, i) => [
            f.replicate + 1,
            item.column,
            ...f.pattern[i],
            ...f.structure[i],
            f.communalities[i],
            f.uniquenesses[i],
            run.reviews[item.column]?.status ?? "retain",
            run.reviews[item.column]?.note ?? "",
          ]),
        ),
      ]),
      "text/csv",
    );
  const refit = async () => {
    try {
      setMessage("Refitting separate imputations…");
      const retained = run.spec.items.flatMap((item, i) =>
          run.reviews[item.column]?.status === "exclude" ? [] : [i],
        ),
        mapping = new Map(retained.map((i, j) => [i, j]));
      const options = {
        ...r.options,
        predictors: retained.map((i) =>
          r.options.predictors[i].flatMap((j) =>
            mapping.has(j) ? [mapping.get(j)!] : [],
          ),
        ),
      };
      const id = await actions.impute(
        {
          ...run.spec,
          items: retained.map((i) => run.spec.items[i]),
          sample: { ...run.spec.sample, fixedRows: r.fittingRows },
        },
        options,
        { parentId: run.id, reviews: run.reviews, reasons },
      );
      onSelect(id);
      setMessage("Saved a new imputation analysis.");
      setChain("summary");
      setScroll(0);
    } catch (error) {
      setMessage(String(error));
    }
  };
  return (
    <BatchDialog
      title={`Ordinal MICE · ${run.spec.label} · revision ${run.revision}`}
      onClose={onClose}
    >
      <div className="flex flex-wrap gap-3 text-xs items-end">
        <label>
          Saved analysis{" "}
          <select
            aria-label="Saved imputation analysis"
            className={control}
            value={run.id}
            onChange={(e) => {
              onSelect(e.target.value);
              setScroll(0);
              setChain("summary");
            }}
          >
            {state.imputationRuns!.map((x) => (
              <option key={x.id} value={x.id}>
                {x.spec.label} r{x.revision}
              </option>
            ))}
          </select>
        </label>
        <label>
          Show{" "}
          <select
            aria-label="Imputation view"
            className={control}
            value={selected ? chain : "summary"}
            onChange={(e) => setChain(e.target.value)}
          >
            <option value="summary">Between-imputation summary</option>
            {r.aligned.map((x) => (
              <option key={x.replicate} value={x.replicate}>
                Imputation {x.replicate + 1}
              </option>
            ))}
          </select>
        </label>
        <button className={button} onClick={exportCsv}>
          Export per-imputation CSV
        </button>
        <button
          className={button}
          onClick={() =>
            download(
              `${run.spec.label}-mice.json`,
              JSON.stringify(run, null, 2),
            )
          }
        >
          Export complete MICE JSON
        </button>
      </div>
      <p className="text-xs">
        {r.completed}/{r.requested} fitted imputations ·{" "}
        {r.fittingRows.length.toLocaleString()} fitting respondents ·{" "}
        {r.missingPositions.length.toLocaleString()} imputed cells per completed
        chain · {r.options.iterations} sweeps · {r.options.predictorEncoding}{" "}
        predictors. Factors are aligned by signs and order.
      </p>
      <p className="text-xs">
        {selected
          ? "Values from one independently fitted imputation."
          : "Cells show mean ± between-imputation SD. These are descriptive summaries, not Rubin-pooled estimates or confidence intervals."}{" "}
        {r.provisional
          ? "Some imputations failed; all summaries are provisional and use only the displayed successful count."
          : ""}
      </p>
      <div className="flex flex-wrap gap-3 items-center text-xs">
        <button
          className={button}
          aria-pressed={view === "pattern"}
          onClick={() => setView("pattern")}
        >
          Pattern
        </button>
        <button
          className={button}
          aria-pressed={view === "structure"}
          onClick={() => setView("structure")}
        >
          Structure
        </button>
        <label>
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
        <span>
          Shared heatmap scale −{limit.toFixed(2)} to +{limit.toFixed(2)}; zero
          is neutral.
        </span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto space-y-3">
        {r.completed > 0 ? (
          <div
            key={`${run.id}-${query}`}
            className="overflow-auto border border-[var(--border)] max-h-[48vh]"
            onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
          >
            <table
              aria-label={`MICE ${view} heatmap`}
              aria-rowcount={indices.length + 1}
              className="w-full text-xs border-collapse"
            >
              <thead className="sticky top-0 bg-[var(--background)] z-20">
                <tr>
                  <th className="p-2 text-left sticky left-0 bg-[var(--background)]">
                    Item
                  </th>
                  {Array.from({ length: run.spec.nFactors }, (_, i) => (
                    <th key={i}>F{i + 1}</th>
                  ))}
                  <th scope="col">h²</th>
                  <th scope="col">u²</th>
                  <th scope="col">Review</th>
                  <th scope="col">Substantive note</th>
                </tr>
              </thead>
              <tbody>
                {first > 0 && (
                  <tr aria-hidden="true">
                    <td
                      colSpan={run.spec.nFactors + 5}
                      style={{ height: first * 42 }}
                    />
                  </tr>
                )}
                {visible.map((i) => (
                  <tr
                    key={run.spec.items[i].column}
                    style={{ height: 42 }}
                    className="border-t border-[var(--border)]"
                  >
                    <th
                      scope="row"
                      className="p-2 text-left sticky left-0 bg-[var(--background)] max-w-56 truncate"
                      title={run.spec.items[i].column}
                    >
                      {run.spec.items[i].column}
                    </th>
                    {r[view][i].map((d, f) => (
                      <td
                        key={f}
                        className="p-2 text-right tabular-nums whitespace-nowrap"
                        style={color(
                          selected ? selected[view][i][f] : d.mean,
                          limit,
                        )}
                      >
                        {selected
                          ? num(selected[view][i][f])
                          : `${num(d.mean)} ± ${num(d.sd)}`}
                      </td>
                    ))}
                    <td className="p-2 whitespace-nowrap">
                      {selected
                        ? num(selected.communalities[i])
                        : `${num(r.communalities[i].mean)} ± ${num(r.communalities[i].sd)}`}
                    </td>
                    <td className="p-2 whitespace-nowrap">
                      {selected
                        ? num(selected.uniquenesses[i])
                        : `${num(r.uniquenesses[i].mean)} ± ${num(r.uniquenesses[i].sd)}`}
                    </td>
                    <td>
                      <select
                        className={control}
                        aria-label={`MICE review ${run.spec.items[i].column}`}
                        value={
                          run.reviews[run.spec.items[i].column]?.status ??
                          "retain"
                        }
                        onChange={(e) =>
                          review(run.spec.items[i].column, {
                            status: e.target.value as ItemReview["status"],
                          })
                        }
                      >
                        {["retain", "investigate", "exclude"].map((x) => (
                          <option key={x}>{x}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        className={control}
                        aria-label={`MICE note ${run.spec.items[i].column}`}
                        value={
                          run.reviews[run.spec.items[i].column]?.note ?? ""
                        }
                        onChange={(e) =>
                          review(run.spec.items[i].column, {
                            note: e.target.value,
                          })
                        }
                      />
                    </td>
                  </tr>
                ))}
                {first + visible.length < indices.length && (
                  <tr aria-hidden="true">
                    <td
                      colSpan={run.spec.nFactors + 5}
                      style={{
                        height: (indices.length - first - visible.length) * 42,
                      }}
                    />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <p>
            No imputation produced an admissible fit. Review the failures below.
          </p>
        )}
        <details>
          <summary>Iteration traces and failures</summary>
          <p className="text-xs">
            Mean rank, SD and category counts describe imputed cells after each
            sweep. A fixed sweep count does not establish convergence; compare
            chains and inspect drift.
          </p>
          <div className="flex gap-3 my-2">
            <label>
              Trace item{" "}
              <select
                className={control}
                value={activeTraceItem}
                aria-label="Trace item"
                onChange={(e) => {
                  setTraceItem(+e.target.value);
                  setTracePage(0);
                }}
              >
                {run.spec.items.map((item, i) => (
                  <option key={item.column} value={i}>
                    {item.column}
                  </option>
                ))}
              </select>
            </label>
            <button
              className={button}
              disabled={!tracePage}
              onClick={() => setTracePage(tracePage - 1)}
            >
              Previous traces
            </button>
            <button
              className={button}
              disabled={(tracePage + 1) * 20 >= traces.length}
              onClick={() => setTracePage(tracePage + 1)}
            >
              Next traces
            </button>
          </div>
          <table
            aria-label="Imputation iteration traces"
            className="text-xs w-full"
          >
            <thead>
              <tr>
                <th scope="col">Imputation</th>
                <th scope="col">Sweep</th>
                <th scope="col">Mean rank</th>
                <th scope="col">SD</th>
                <th scope="col">Category counts</th>
              </tr>
            </thead>
            <tbody>
              {traces.slice(traceStart, traceStart + 20).map((t) => (
                <tr key={`${t.imputation}-${t.iteration}`}>
                  <td>{t.imputation + 1}</td>
                  <td>{t.iteration}</td>
                  <td>{num(t.mean)}</td>
                  <td>{num(t.sd)}</td>
                  <td>{t.counts.join(" / ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!traces.length && (
            <p>
              No trace entries for this item. It may have complete responses, or
              its chains may have stopped earlier.
            </p>
          )}
          {r.failures.map((f) => (
            <p key={f.imputation} role="status">
              Imputation {f.imputation + 1} · {f.stage}: {f.error}
            </p>
          ))}
        </details>
        <details>
          <summary>
            Factor correlations, fit and predictor specification
          </summary>
          {r.fits.map((f) => (
            <div className="text-xs" key={f.imputation}>
              <p>
                Imputation {f.imputation + 1}: RMS residual {num(f.result.rmsr)}
                ; Φ rows{" "}
                {r.aligned
                  .find((a) => a.replicate === f.imputation)
                  ?.phi.map((row) => row.map(num).join(", "))
                  .join(" | ")}
                .
              </p>
              {f.result.diagnostics.map((diagnostic, i) => (
                <p key={`${diagnostic.code}-${i}`}>
                  {diagnostic.code}: {diagnostic.message}
                </p>
              ))}
            </div>
          ))}
          {run.spec.items.map((item, i) => (
            <p className="text-xs" key={item.column}>
              {item.column} ←{" "}
              {r.options.predictors[i]
                .map((j) => run.spec.items[j].column)
                .join(", ") || "intercept only"}
            </p>
          ))}
        </details>
      </div>
      <div className="flex flex-wrap gap-3 items-center text-xs border-t border-[var(--border)] pt-3">
        <input
          className={`${control} min-w-72`}
          placeholder="Reasons for this candidate"
          aria-label="MICE refit reasons"
          value={reasons}
          onChange={(e) => setReasons(e.target.value)}
        />
        <button
          className={button}
          disabled={job?.status === "running"}
          onClick={() => void refit()}
        >
          Refit MICE selection
        </button>
        {job?.status === "running" && (
          <button className={button} onClick={actions.cancel}>
            Cancel
          </button>
        )}
        <p>
          Refits keep fitting rows, rerun separate imputations and remove
          excluded items from predictor sets.
        </p>
      </div>
      <p role="status" className="text-xs">
        {job?.status === "running"
          ? `${job.progress.stage}: ${job.progress.completed}/${job.progress.total}`
          : message}
      </p>
    </BatchDialog>
  );
}
export function StabilityPanel({
  state,
  run,
  table,
  actions,
  job,
}: {
  state: EfaState;
  run: EfaRun;
  table: DataTable;
  actions: EfaActions;
  job?: EfaJob;
}) {
  const saved = (state.stabilityRuns ?? []).filter((r) => r.runId === run.id),
    [active, setActive] = useState(""),
    [replicates, setReplicates] = useState(100),
    [seed, setSeed] = useState(run.spec.seed),
    [confidence, setConfidence] = useState(0.95),
    [threshold, setThreshold] = useState(0.3),
    [group, setGroup] = useState(""),
    [message, setMessage] = useState(""),
    [factor, setFactor] = useState(0),
    [view, setView] = useState<"pattern" | "structure">("pattern"),
    [offset, setOffset] = useState(0);
  const selected = saved.find((r) => r.id === active) ?? saved.at(-1),
    result = selected?.result,
    f = Math.min(factor, run.spec.nFactors - 1);
  const start = async () => {
    try {
      setMessage("");
      setActive(
        await actions.stability(
          run.id,
          { replicates, seed, confidence, crossLoadingThreshold: threshold },
          group || undefined,
        ),
      );
    } catch (error) {
      setMessage(String(error));
    }
  };
  const exportCsv = () => {
    if (!result) return;
    download(
      `${run.spec.label}-stability.csv`,
      csv([
        [
          "item",
          "factor",
          "pattern_mean",
          "pattern_sd",
          "pattern_lower",
          "pattern_upper",
          "structure_mean",
          "structure_sd",
          "structure_lower",
          "structure_upper",
          "communality_mean",
          "uniqueness_mean",
          "primary_agreement",
          "cross_loading_frequency",
          "completed",
          "requested",
        ],
        ...run.spec.items.flatMap((item, i) =>
          Array.from({ length: run.spec.nFactors }, (_, j) => [
            item.column,
            j + 1,
            result.pattern[i][j].mean,
            result.pattern[i][j].sd,
            result.pattern[i][j].lower,
            result.pattern[i][j].upper,
            result.structure[i][j].mean,
            result.structure[i][j].sd,
            result.structure[i][j].lower,
            result.structure[i][j].upper,
            result.communalities[i].mean,
            result.uniquenesses[i].mean,
            result.primaryAgreement[i],
            result.crossLoadingFrequency[i],
            result.completed,
            result.requested,
          ]),
        ),
      ]),
      "text/csv",
    );
  };
  return (
    <div className="space-y-3 text-xs">
      <p>
        Resample respondents or whole groups and refit the complete EFA. Factors
        are matched by signs and order. Percentile intervals describe this
        exploratory resampling distribution.
      </p>
      <div className="flex flex-wrap gap-3 items-end">
        <label>
          Resamples{" "}
          <input
            className={`${control} w-20`}
            type="number"
            min={2}
            max={1000}
            value={replicates}
            onChange={(e) => setReplicates(+e.target.value)}
          />
        </label>
        <label>
          Seed{" "}
          <input
            className={`${control} w-28`}
            type="number"
            value={seed}
            onChange={(e) => setSeed(+e.target.value)}
          />
        </label>
        <label>
          Interval level{" "}
          <input
            className={`${control} w-20`}
            type="number"
            min={0.01}
            max={0.99}
            step={0.01}
            value={confidence}
            onChange={(e) => setConfidence(+e.target.value)}
          />
        </label>
        <label>
          Cross-loading |λ|{" "}
          <input
            className={`${control} w-20`}
            type="number"
            min={0}
            step={0.05}
            value={threshold}
            onChange={(e) => setThreshold(+e.target.value)}
          />
        </label>
        <label>
          Resampling unit{" "}
          <select
            className={`${control} max-w-56`}
            value={group}
            onChange={(e) => setGroup(e.target.value)}
          >
            <option value="">Respondent</option>
            {table.columns.map((c) => (
              <option key={c} value={c}>
                Group: {c}
              </option>
            ))}
          </select>
        </label>
        <button
          className={button}
          disabled={job?.status === "running"}
          onClick={() => void start()}
        >
          Run resampling stability
        </button>
        {job?.status === "running" && (
          <button className={button} onClick={actions.cancel}>
            Cancel
          </button>
        )}
      </div>
      <p role="status">
        {job?.status === "running"
          ? `${job.progress.stage}: ${job.progress.completed}/${job.progress.total}`
          : message}
      </p>
      {result && (
        <>
          <div className="flex flex-wrap gap-3">
            <label>
              Saved resampling{" "}
              <select
                className={control}
                value={selected!.id}
                onChange={(e) => setActive(e.target.value)}
              >
                {saved.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.result.requested} draws · seed {s.result.options.seed} ·{" "}
                    {s.groupColumn ?? "respondents"}
                  </option>
                ))}
              </select>
            </label>
            <button className={button} onClick={exportCsv}>
              Export stability CSV
            </button>
            <button
              className={button}
              onClick={() =>
                download(
                  `${run.spec.label}-stability.json`,
                  JSON.stringify({ analysis: selected, parent: run }, null, 2),
                )
              }
            >
              Export complete stability JSON
            </button>
          </div>
          <p>
            {result.completed}/{result.requested} successful refits.{" "}
            {result.provisional
              ? "Provisional: failed replicates remain in the record; summaries use only successful refits."
              : "All requested refits completed."}{" "}
            Cross-loading frequency uses at least two pattern coefficients with
            |λ| ≥ {result.options.crossLoadingThreshold}.{" "}
            {Math.round(result.options.confidence * 100)}% percentile intervals
            use the same successful-refit denominator.
          </p>
          <p>
            {
              result.replicas.filter((r) => r.diagnostics?.boundaryItems.length)
                .length
            }{" "}
            refits reached a uniqueness bound;{" "}
            {result.replicas.filter((r) => r.diagnostics?.improper).length} had
            negative uniquenesses. These refits remain in the displayed
            summaries.
            {result.replicas.some((r) => !r.diagnostics)
              ? " Some older refits lack recorded boundary diagnostics."
              : ""}
          </p>
          <div className="flex flex-wrap gap-3">
            <label>
              Matrix{" "}
              <select
                className={control}
                value={view}
                onChange={(e) =>
                  setView(e.target.value as "pattern" | "structure")
                }
              >
                <option value="pattern">Pattern</option>
                <option value="structure">Structure</option>
              </select>
            </label>
            <label>
              Factor{" "}
              <select
                className={control}
                value={f}
                onChange={(e) => setFactor(+e.target.value)}
              >
                {Array.from({ length: run.spec.nFactors }, (_, i) => (
                  <option key={i} value={i}>
                    F{i + 1}
                  </option>
                ))}
              </select>
            </label>
            <label>
              First item{" "}
              <input
                className={`${control} w-24`}
                type="number"
                min={1}
                max={run.spec.items.length}
                value={offset + 1}
                onChange={(e) =>
                  setOffset(
                    Math.max(
                      0,
                      Math.min(run.spec.items.length - 1, +e.target.value - 1),
                    ),
                  )
                }
              />
            </label>
          </div>
          <div className="overflow-auto">
            <table
              aria-label="Stability item intervals"
              className="w-full text-xs border-collapse"
            >
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col">Mean</th>
                  <th scope="col">SD</th>
                  <th scope="col">Percentile interval</th>
                  <th scope="col">h² mean</th>
                  <th scope="col">u² mean</th>
                  <th scope="col">Primary factor agreement</th>
                  <th scope="col">Cross-loading frequency</th>
                </tr>
              </thead>
              <tbody>
                {run.spec.items.slice(offset, offset + 25).map((item, j) => {
                  const i = offset + j,
                    d = result[view][i][f];
                  return (
                    <tr
                      className="border-t border-[var(--border)]"
                      key={item.column}
                    >
                      <th
                        className="p-2 max-w-56 truncate text-left"
                        title={item.column}
                      >
                        {item.column}
                      </th>
                      <td>{num(d.mean)}</td>
                      <td>{num(d.sd)}</td>
                      <td>
                        {num(d.lower)} to {num(d.upper)}
                      </td>
                      <td>{num(result.communalities[i].mean)}</td>
                      <td>{num(result.uniquenesses[i].mean)}</td>
                      <td>{num(result.primaryAgreement[i])}</td>
                      <td>{num(result.crossLoadingFrequency[i])}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <details>
            <summary>Failures and factor congruence</summary>
            {result.failures.map((x) => (
              <p key={x.replicate}>
                Replicate {x.replicate + 1}: {x.error}
              </p>
            ))}
            <p>
              Factor F{f + 1} congruence across successful refits:{" "}
              {result.replicas.map((r) => num(r.congruence[f])).join(", ") ||
                "No successful refits"}
              .
            </p>
          </details>
        </>
      )}
    </div>
  );
}
