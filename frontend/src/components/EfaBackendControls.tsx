"use client";
import type { EfaComputeSettings } from "@/lib/efa/backends/types";
import { InfoTip } from "./InfoTip";
const control = "block w-full border bg-[var(--input)] p-1.5 text-xs";
export function EfaBackendControls({ value, onChange, disabled }: { value: EfaComputeSettings; onChange: (value: EfaComputeSettings) => void; disabled: boolean }) {
  return <fieldset disabled={disabled} className="col-span-2 space-y-2 border p-2">
    <legend className="text-xs">WLSMV correction and compute</legend>
    {!["cpu", "webgpu"].includes(value.backend) && <p role="alert" className="text-xs">This saved backend is no longer supported. Select Browser CPU or WebGPU explicitly before running; no backend has been substituted.</p>}
    <label className="text-xs">MV correction<InfoTip label="About MV correction" text="Both modes apply MV scaling and shift. Exact evaluates the complete second trace. Estimated uses random probes for that trace, leaving loadings and parameter standard errors unchanged." />
      <select aria-label="MV correction" className={control} value={value.correction ?? "exact"} onChange={e => onChange(e.target.value === "estimated" ? { ...value, backend: "webgpu", correction: "estimated", probes: value.probes ?? 128, probeSeed: value.probeSeed ?? 61001 } : { ...value, correction: "exact" })}>
        <option value="exact">Exact · default</option>
        <option value="estimated">Estimated · WebGPU random probes</option>
      </select>
    </label>
    <p className="text-xs opacity-75">Both modes apply MV scaling and shift. Loadings and standard errors are unchanged.</p>
    {value.correction === "estimated" && <div className="grid grid-cols-2 gap-2 text-xs">
      <label>Probe count<InfoTip label="About probe count" text="More probes take longer and reduce Monte Carlo variance in expectation, approximately in proportion to 1 / probe count. A particular estimate need not improve at every checkpoint. The inspector reports empirical uncertainty; it is not an accuracy guarantee." /><input aria-label="MV probe count" className={control} type="number" step={1} min={16} max={4096} value={value.probes ?? 128} onChange={e => onChange({ ...value, probes: +e.target.value })} /></label>
      <label>Probe seed<InfoTip label="About probe seed" text="Sets the reproducible random probe stream. It is separate from the rotation seed and saved with the result. Changing the seed reruns the estimated correction." /><input aria-label="MV probe seed" className={control} type="number" step={1} min={0} max={4294967295} value={value.probeSeed ?? 61001} onChange={e => onChange({ ...value, probeSeed: +e.target.value })} /></label>
      <p className="col-span-2 opacity-75">Uses browser WebGPU. The inspector shows probe progress and Monte Carlo uncertainty. A fixed probe count does not guarantee an accuracy level.</p>
    </div>}
    <fieldset className="space-y-1 text-xs" aria-label="EFA compute backend">
      <legend className="mb-1">Compute backend</legend>
      {([
        ["cpu", "Browser CPU · exact", "About Browser CPU", "Runs exact MV correction in browser workers using Float64. A good starting point for small batteries: it can use a small moment matrix and avoids GPU startup. No extra server is needed."],
        ["webgpu", `WebGPU · ${value.correction === "estimated" ? "estimated" : "exact"}`, "About WebGPU", value.correction === "estimated"
          ? "Estimates the second MV trace with random probes on your GPU, inside the browser. Most useful when a large exact trace would dominate runtime. A few dominant residual directions can cause large error even in a large dataset. Review Monte Carlo uncertainty in the inspector. Numerical self-checks run before analysis data."
          : "Runs exact MV trace calculation on your GPU, inside the browser. This mode does not use random-probe estimation. Large trace workloads can benefit; small jobs can be slower after startup and self-checks. Select Estimated MV correction to use probes."],
      ] as const).map(([backend, title, label, text]) => <div key={backend} className="flex items-center gap-1">
        <label className="flex min-w-0 items-center gap-2"><input type="radio" name="efa-compute-backend" aria-label={`EFA backend ${backend}`} checked={value.backend === backend} disabled={value.correction === "estimated" && backend !== "webgpu"} onChange={() => onChange({ backend, correction: value.correction ?? "exact", probes: value.probes, probeSeed: value.probeSeed })} />{title}</label>
        <InfoTip label={label} text={text} />
      </div>)}
      {value.correction === "estimated" && <p className="opacity-75">Select Exact above to use CPU.</p>}
    </fieldset>
    <p className="text-xs opacity-75">WebGPU accelerates the MV trace. Other stages run in browser workers. Fresh accelerated runs check their kernels before processing analysis data.</p>
    <details className="text-xs"><summary className="cursor-pointer">Memory and block settings</summary>
      <label>Block rows<InfoTip label="About block rows" text={value.correction === "estimated" ? "The probe operator uses its own bounded batches of at most 32 probes. This exact-trace block setting does not tune estimated-probe throughput." : "Controls the exact trace tile size. Larger tiles can reuse more data but consume more memory; the fastest size depends on the device."} /><select aria-label="EFA block rows" disabled={value.correction === "estimated"} className={control} value={value.blockSize ?? (value.backend === "webgpu" ? 128 : 32)} onChange={e => onChange({ ...value, blockSize: +e.target.value })}>{[32, 64, 128, 256].map(n => <option key={n}>{n}</option>)}</select></label>
      <label>Inference memory budget (MiB)<InfoTip label="About inference memory budget" text="Checks estimated working allocations before inference. This is not a cap on total browser or GPU memory; device allocation limits are checked separately." /><input className={control} type="number" min={256} max={4096} value={value.memoryMiB ?? (value.backend === "cpu" ? 1024 : 1536)} onChange={e => onChange({ ...value, memoryMiB: +e.target.value })} /></label>
      <p>Allocation estimate only; not a cap on total browser or GPU memory. Device limits can still stop a run.</p>
    </details>
  </fieldset>;
}
