"use client";

import type { DatasetSplitOptions } from "@/lib/datasetSplit";

export const DEFAULT_DATASET_SPLIT: DatasetSplitOptions = { fraction: 0.7, seed: 2026 };

export function DatasetSplitControls({ value, onChange, columns = [], nRows }: {
  value: DatasetSplitOptions;
  onChange: (value: DatasetSplitOptions) => void;
  columns?: string[];
  nRows?: number;
}) {
  const existing = value.sourceColumn !== undefined;
  const input = "w-full min-w-0 border border-[var(--border)] bg-[var(--input)] px-2 py-1.5";
  const update = (patch: Partial<DatasetSplitOptions>) => onChange({ ...value, ...patch });
  return <div className="space-y-3 text-xs">
    {!!columns.length && <label className="block space-y-1">
      <span>Split method</span>
      <select aria-label="Split method" className={input} value={existing ? "existing" : "random"}
        onChange={e => onChange(e.target.value === "existing"
          ? { ...DEFAULT_DATASET_SPLIT, sourceColumn: columns[0], developmentValue: "development", holdoutValue: "holdout" }
          : { ...DEFAULT_DATASET_SPLIT })}>
        <option value="random">Create random split</option>
        <option value="existing">Use existing split column</option>
      </select>
    </label>}
    {existing ? <>
      <label className="block space-y-1"><span>Split column</span><select aria-label="Split column" className={input} value={value.sourceColumn} onChange={e => update({ sourceColumn: e.target.value })}>
        {columns.map(c => <option key={c}>{c}</option>)}
      </select></label>
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1"><span>Development value</span><input className={input} value={value.developmentValue ?? ""} onChange={e => update({ developmentValue: e.target.value })} /></label>
        <label className="space-y-1"><span>Holdout value</span><input className={input} value={value.holdoutValue ?? ""} onChange={e => update({ holdoutValue: e.target.value })} /></label>
      </div>
    </> : <>
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1"><span>Development (%)</span><input aria-label="Development percentage" className={input} type="number" min="1" max="99" step="1" value={Number.isFinite(value.fraction) ? Math.round((value.fraction ?? 0.7) * 100) : ""} onChange={e => update({ fraction: e.target.value === "" ? NaN : Number(e.target.value) / 100 })} /></label>
        <label className="space-y-1"><span>Random seed</span><input aria-label="Split random seed" className={input} type="number" step="1" value={Number.isFinite(value.seed) ? value.seed : ""} onChange={e => update({ seed: e.target.value === "" ? NaN : Number(e.target.value) })} /></label>
      </div>
      {!!columns.length && <details>
        <summary className="cursor-pointer">Group and stratify</summary>
        <div className="grid grid-cols-2 gap-2 pt-2">
          <label className="space-y-1"><span>Keep groups together</span><select aria-label="Split group column" className={input} value={value.groupColumn ?? ""} onChange={e => update({ groupColumn: e.target.value || undefined })}><option value="">None</option>{columns.map(c => <option key={c}>{c}</option>)}</select></label>
          <label className="space-y-1"><span>Stratify by</span><select aria-label="Split stratum column" className={input} value={value.stratumColumn ?? ""} onChange={e => update({ stratumColumn: e.target.value || undefined })}><option value="">None</option>{columns.map(c => <option key={c}>{c}</option>)}</select></label>
        </div>
      </details>}
      {nRows !== undefined && Number.isFinite(value.fraction) && <p className="opacity-65">About {Math.round(nRows * (value.fraction ?? 0.7))} development / {nRows - Math.round(nRows * (value.fraction ?? 0.7))} holdout rows{value.groupColumn ? "; group membership determines the final counts" : ""}.</p>}
    </>}
    <p className="leading-relaxed opacity-70">Switch to Development after creating the split. Full and Holdout stay locked until you explicitly unlock them.</p>
  </div>;
}
