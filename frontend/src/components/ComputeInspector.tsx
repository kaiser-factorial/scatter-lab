"use client";

import { useEffect, useRef, useState } from "react";
import type { EfaService } from "@/lib/efa/service";
import type { ComputeReport } from "@/lib/efa/telemetry";

const ms = (value: number) => value < 1000 ? `${value.toFixed(1)} ms` : `${(value / 1000).toFixed(2)} s`;
const bytes = (value: number) => `${(value / 1024 ** 2).toFixed(2)} MiB`;
const button = "border border-current px-3 py-1.5 text-xs cursor-pointer disabled:opacity-40";

function download(report: ComputeReport) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2) + "\n"], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url; link.download = `computation-${report.jobId}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Native dialog supplies focus containment, Escape, and an inert background.
 * Reports are cloned only while open; closed chrome uses cheap job metadata. */
export function ComputeInspector({ service, compact = false }: { service: EfaService; compact?: boolean }) {
  const [, refresh] = useState(0);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const [view, setView] = useState<"Timeline" | "Diagnostics" | "Logs">("Timeline");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => service.subscribe(() => refresh((n) => n + 1)), [service]);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => refresh((n) => n + 1), 500);
    return () => clearInterval(timer);
  }, [open]);
  const jobs = service.listJobs().slice().reverse();
  const active = jobs.some((j) => j.status === "running");
  const job = jobs.find((j) => j.id === selected) ?? jobs[0];
  const report = open && job ? service.report(job.id) : undefined;
  const close = () => setOpen(false);
  return <>
    <button className={`${button} ${compact ? "px-1" : "w-full text-left"}`} aria-label="Open computation inspector" aria-haspopup="dialog" onClick={() => setOpen(true)} title="Inspect background computations">
      {compact ? "CPU" : "Compute"}{active ? " ●" : ""}
      {!compact && <span className="float-right opacity-70">{active ? "Running" : jobs.length ? `${jobs.length} recent` : "Inspector"}</span>}
    </button>
    <dialog ref={dialog} onCancel={close} onClose={close} aria-labelledby="compute-title"
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), select, summary, [tabindex='0']")).filter((element) => element.getClientRects().length > 0);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}
      className="compute-inspector fixed inset-y-0 left-auto right-0 m-0 h-dvh max-h-dvh w-full max-w-[760px] border-l-2 bg-[var(--card)] text-[var(--foreground)] p-0 backdrop:bg-black/40">
      <div className="flex h-full flex-col">
        <header className="compute-inspector-header flex items-center justify-between gap-3 border-b p-4">
          <div><h2 id="compute-title" className="text-lg font-bold">Computation inspector</h2><p className="text-xs opacity-80">EFA jobs in this session</p></div>
          <button className={button} onClick={close} aria-label="Close computation inspector">Close</button>
        </header>
        <div className="flex-1 overflow-y-auto p-4 space-y-5 text-sm">
          {!report ? <p>No computations yet. Preview a sample or run an EFA analysis to see its execution here.</p> : <>
            <label className="block">Recent job
              <select className="mt-1 block w-full border bg-[var(--input)] p-2 text-xs" value={job.id} onChange={(e) => setSelected(e.target.value)}>
                {jobs.map((j) => <option value={j.id} key={j.id}>{j.id.slice(0, 8)} · {j.status} · {j.progress.stage}</option>)}
              </select>
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <strong>{report.status}</strong><span>{ms(report.elapsedMs)}</span>
              <span className="opacity-70">{report.backend} / {report.precision}</span>
              <button className={`${button} ml-auto`} onClick={() => download(report)}>Export diagnostics</button>
              {job.status === "running" && <button className={button} onClick={job.cancel}>Cancel job</button>}
            </div>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
              <dt>Analysis</dt><dd>{report.context.operation ?? "Preparing"} · {report.context.extraction ?? "—"} · {report.context.rotation ?? "—"}</dd>
              <dt>Sample</dt><dd>{report.context.partition ?? "—"} · {report.context.fittingRows ?? "—"} fitting / {report.context.eligibleRows ?? "—"} eligible rows</dd>
              <dt>Dimensions</dt><dd>{report.context.items ?? "—"} items · {report.context.factors ?? "—"} factors</dd>
              <dt>Missing data</dt><dd>{report.context.missing ?? "—"}</dd>
              <dt>Workers</dt><dd>{report.activeWorkers} active / {report.workersCreated} created</dd>
              <dt>Result acceptance</dt><dd>{report.publication === "not-requested" ? "No workspace write requested" : report.publication}</dd>
              <dt>Input fingerprint</dt><dd className="break-all">{report.context.inputSha256 ?? "Not available for this task"}</dd>
            </dl>
            {job.status === "running" && <p role="status" className="text-xs">{job.progress.stage}: {job.progress.completed} / {job.progress.total}</p>}
            {job.status === "failed" && <p role="alert">Computation failed. The analysis panel contains the error and suggested action. Diagnostic exports omit exception text and source values.</p>}
            <div className="flex gap-2" aria-label="Inspector views">
              {(["Timeline", "Diagnostics", "Logs"] as const).map((tab) => <button key={tab} className={`${button} ${tab === view ? "compute-selected" : ""}`} aria-pressed={tab === view} onClick={() => setView(tab)}>{tab}</button>)}
            </div>
            {view === "Timeline" && <>
              <p className="text-xs opacity-75">Elapsed stage timings measured inside workers, including awaited work, reported when each request returns. Times are summed across workers and can exceed job wall time. An interrupted request has no final worker timing.</p>
              <table className="w-full text-xs"><thead><tr><th className="text-left">Computation stage</th><th className="text-right">Worker time</th></tr></thead><tbody>{Object.entries(report.workerStages).map(([stage, duration]) => <tr className="border-b border-current/20" key={stage}><td>{stage}<div className="compute-duration mt-1 h-1" style={{ width: `${Math.max(0.5, 100 * duration / Math.max(1, ...Object.values(report.workerStages)))}%` }} /></td><td className="text-right">{ms(duration)}</td></tr>)}</tbody></table>
              <details><summary className="cursor-pointer text-xs">Coordinator progress timeline</summary>
              <p className="text-xs opacity-75">Coordinator wall time by stage. Parallel worker request durations can overlap; they are not additive elapsed time.</p>
              <table className="w-full text-xs"><thead><tr className="border-b"><th className="text-left pb-2">Stage</th><th>Progress</th><th className="text-right">Wall time</th></tr></thead>
                <tbody>{report.stages.map((s, i) => <tr key={i} className="border-b border-current/20"><td className="py-2 pr-2"><span>{s.stage}</span><div className="compute-duration mt-1 h-1" style={{ width: `${Math.max(0.5, 100 * s.durationMs / Math.max(1, report.elapsedMs))}%` }} /></td><td className="text-center">{s.completed} / {s.total}</td><td className="text-right whitespace-nowrap">{ms(s.durationMs)}</td></tr>)}</tbody>
              </table>
              {report.droppedStages > 0 && <p>{report.droppedStages} older stage segments omitted.</p>}
              </details>
              <details><summary className="cursor-pointer">Worker request timings</summary><div className="overflow-auto mt-2"><table className="w-full text-xs"><thead><tr><th className="text-left">Request</th><th>Count</th><th>Round trips</th><th>Worker elapsed</th><th>postMessage</th></tr></thead><tbody>{Object.entries(report.requests).map(([op, r]) => <tr key={op}><td>{op}</td><td className="text-center">{r.count}</td><td>{ms(r.roundTripMs)}</td><td>{ms(r.workerMs)}</td><td>{ms(r.postMessageMs)}</td></tr>)}</tbody></table></div></details>
            </>}
            {view === "Diagnostics" && <div className="space-y-4 text-xs">
              <p>Typed-array payloads sent: {bytes(report.transport.sentTypedBufferBytes)}; received: {bytes(report.transport.receivedTypedBufferBytes)}.</p>
              <p className="opacity-75">{report.transport.description} Per-worker resident memory and CPU utilization are not measured.</p>
              {report.numerical ? <>
                <table className="w-full"><thead><tr><th className="text-left">Fit</th><th>Converged</th><th>Iterations</th><th>Objective</th><th>Gradient</th></tr></thead><tbody>{(["extraction", "rotation"] as const).map((name) => { const c = report.numerical![name]; return <tr key={name}><td>{name}</td><td className="text-center">{String(c.converged)}</td><td className="text-center">{c.iterations}</td><td>{c.objective.toPrecision(5)}</td><td>{c.gradient.toPrecision(5)}</td></tr>; })}</tbody></table>
                <p>Boundary items: {report.numerical.boundaryItems}. Matrix condition number: {report.numerical.conditionNumber.toPrecision(5)}. Residual RMS: {report.numerical.residualRms.toPrecision(5)}.</p>
                {report.numerical.inferenceEstimatedBytes !== undefined && <p>WLSMV working-memory estimate: {bytes(report.numerical.inferenceEstimatedBytes)}. This is an allocation estimate, not measured peak memory.</p>}
              </> : <p>Numerical convergence diagnostics appear after a completed fit.</p>}
            </div>}
            {view === "Logs" && <>
              <p className="text-xs opacity-75">At most 512 recent events per job. {report.droppedEvents} older events omitted. Request totals remain available above.</p>
              <ol className="space-y-1 text-xs break-words">{report.events.map((e) => <li key={e.sequence}><span className="opacity-60">{ms(e.elapsedMs)}</span> {e.worker ? `Worker ${e.worker} · ` : ""}{e.action}{e.count !== undefined ? ` (${e.count})` : ""}{e.durationMs !== undefined ? ` · ${ms(e.durationMs)}` : ""}</li>)}</ol>
            </>}
          </>}
          <p className="text-xs opacity-65 border-t pt-3">Recent execution records stay in this tab and are not saved in workspaces. Exports contain operational timings and aggregate fit diagnostics, without respondent responses, item names, category counts, or row membership.</p>
        </div>
      </div>
    </dialog>
  </>;
}
