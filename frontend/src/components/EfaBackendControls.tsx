"use client";
import { useEffect, useState } from "react";
import type { EfaService } from "@/lib/efa/service";
import type { EfaComputeSettings } from "@/lib/efa/backends/types";
const control = "block w-full border bg-[var(--input)] p-1.5 text-xs";
export function EfaBackendControls({ value, onChange, service, disabled }: { value: EfaComputeSettings; onChange: (value: EfaComputeSettings) => void; service: EfaService; disabled: boolean }) {
  const [, refresh] = useState(0), [url, setUrl] = useState("http://127.0.0.1:8787"), [token, setToken] = useState(""), [message, setMessage] = useState(""), [connecting, setConnecting] = useState(false);
  useEffect(() => service.subscribe(() => refresh(n => n + 1)), [service]);
  const connected = service.scalaConnected();
  return <fieldset disabled={disabled} className="col-span-2 space-y-2 border p-2">
    <legend className="text-xs">WLSMV correction and compute</legend>
    <label className="text-xs">MV correction
      <select aria-label="MV correction" className={control} value={value.correction ?? "exact"} onChange={e => onChange(e.target.value === "estimated" ? { ...value, backend: "webgpu", correction: "estimated", probes: value.probes ?? 128, probeSeed: value.probeSeed ?? 61001 } : { ...value, correction: "exact" })}>
        <option value="exact">Exact · default</option>
        <option value="estimated">Estimated · WebGPU random probes</option>
      </select>
    </label>
    <p className="text-xs opacity-75">Both options apply the MV correction. Estimation changes the second trace moment used for scaling and shift; loadings and standard errors use the same calculation. Exact CPU correction is often inexpensive for small item batteries.</p>
    {value.correction === "estimated" && <div className="grid grid-cols-2 gap-2 text-xs">
      <label>Probe count<input aria-label="MV probe count" className={control} type="number" step={1} min={16} max={4096} value={value.probes ?? 128} onChange={e => onChange({ ...value, probes: +e.target.value })} /></label>
      <label>Probe seed<input aria-label="MV probe seed" className={control} type="number" step={1} min={0} max={4294967295} value={value.probeSeed ?? 61001} onChange={e => onChange({ ...value, probeSeed: +e.target.value })} /></label>
      <p className="col-span-2 opacity-75">Uses browser WebGPU. The inspector shows probe progress and Monte Carlo uncertainty. A fixed probe count does not guarantee an accuracy level.</p>
    </div>}
    <label className="text-xs">Compute backend
      <select aria-label="EFA compute backend" className={control} value={value.backend} onChange={e => onChange({ backend: e.target.value as EfaComputeSettings["backend"], correction: value.correction ?? "exact", probes: value.probes, probeSeed: value.probeSeed })}>
        <option value="cpu" disabled={value.correction === "estimated"}>Browser CPU · Float64</option><option value="webgpu">WebGPU · portable precision</option><option value="scala" disabled={value.correction === "estimated"}>Scala · local native BLAS</option>
      </select>
    </label>
    <p className="text-xs opacity-75">Accelerates the WLSMV trace correction. Correlations, extraction, rotation and scores use browser workers. Each fresh accelerated computation checks its kernel against synthetic Float64 results before processing analysis data. No automatic fallback.</p>
    {value.backend === "scala" && <div className="space-y-2 text-xs">
      <p>{connected ? "Companion paired for this session." : "Start the companion on this computer, then pair it here. Selected ordinal responses and projection arrays stay on this computer and are sent to that process."}</p>
      <details><summary className="cursor-pointer">Local companion setup</summary><p className="my-2">From the frontend directory, with Java 21+ and native BLAS installed:</p><pre className="overflow-auto whitespace-pre-wrap">npm run efa:companion:setup{"\n"}npm run efa:companion -- --origin={typeof location !== "undefined" ? location.origin : "http://localhost:3000"}</pre><p>Copy the URL and token printed by the companion. The browser may request local-network access. Pairing is kept in memory and is never included in saved analyses or assistant results.</p></details>
      {connected ? <button type="button" className="border px-2 py-1" onClick={() => { service.disconnectScala(); setMessage("Disconnected."); }}>Disconnect companion</button> : <>
        <label>Companion URL<input className={control} value={url} onChange={e => setUrl(e.target.value)} autoComplete="off" /></label>
        <label>Pairing token<input className={control} type="password" value={token} onChange={e => setToken(e.target.value)} autoComplete="off" spellCheck={false} /></label>
        <button type="button" className="border px-2 py-1 disabled:opacity-40" disabled={connecting || !token} onClick={async () => { setConnecting(true); setMessage(""); const pairing = token.trim(); setToken(""); try { await service.connectScala({ url, token: pairing }); setMessage("Connected."); } catch (e) { setMessage(e instanceof Error ? e.message : "Connection failed."); } finally { setConnecting(false); } }}>{connecting ? "Connecting…" : "Connect local companion"}</button>
      </>}
      <p role="status">{message}</p>
    </div>}
    <details className="text-xs"><summary className="cursor-pointer">Memory and block settings</summary>
      <label>Block rows<select aria-label="EFA block rows" className={control} value={value.blockSize ?? (value.backend === "scala" ? 256 : value.backend === "webgpu" ? 128 : 32)} onChange={e => onChange({ ...value, blockSize: +e.target.value })}>{[32, 64, 128, 256].map(n => <option key={n}>{n}</option>)}</select></label>
      <label>Inference memory budget (MiB)<input className={control} type="number" min={256} max={4096} value={value.memoryMiB ?? (value.backend === "cpu" ? 1024 : 1536)} onChange={e => onChange({ ...value, memoryMiB: +e.target.value })} /></label>
      <p>Allocation estimate only; not a cap on total browser, JVM or GPU memory. Device limits can still stop a run.</p>
    </details>
  </fieldset>;
}
