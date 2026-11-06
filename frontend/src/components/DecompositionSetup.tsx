"use client";
import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { DataTable } from '@/lib/table';
import { numericColumnsOf } from '@/lib/profile';
import { deriveRunLabel, isPCColumn, type MissingStrategy } from '@/lib/pca';
import { isIdentifierColumn } from '@/lib/defaults';
import { inferMeasurement, type MeasurementChoice } from '@/lib/measurement';
import { InfoTip } from './InfoTip';
import { PanelChoiceButton } from './PanelChoiceButton';

export type SharedAnalysisSetup = {
  label: string;
  selected: string[];
  missing: MissingStrategy;
  measurements: Record<string, MeasurementChoice>;
};
export const MISSING_METHODS = [
  { value: 'pairwise', name: 'Pairwise deletion', info: 'Estimate each correlation or covariance from respondents observed on that pair. Pair sample sizes can differ. Incomplete rows have no PCA score.' },
  { value: 'complete', name: 'Complete cases', info: 'Use only respondents observed on every selected item. No missing values are filled.' },
  { value: 'mean', name: 'Column mean', info: 'Fit each column’s mean on the fitting sample. For ordered categorical items, map it to the nearest valid category (ties use the lower category); continuous columns retain the exact mean. Ordered text uses mean category rank.' },
  { value: 'median', name: 'Column median', info: 'Fit each column’s median on the fitting sample. Ordered categorical items use the lower middle observed category, so the fill is a valid category. Continuous columns use the ordinary numeric median, averaging the two middle values when needed.' },
  { value: 'mice', name: 'MICE', info: 'Generate multiple completed datasets with chained conditional models and fit each separately. This implementation uses ordered-category models. Review the separate fits; their results are not pooled standard errors.' },
  { value: 'iterative', name: 'Iterative PCA', info: 'Reconstruct missing cells from a low-rank PCA model, keeping observed cells unchanged. Available for PCA only.' },
] as const;

export function DecompositionSetup({ table, fittingTable = table, method, onMethodChange, externalRun, children, ownedScores = [] }: {
  table: DataTable; fittingTable?: DataTable;
  method: 'pca' | 'efa'; onMethodChange: (method: 'pca' | 'efa') => void;
  externalRun?: { seq: number; vars: string[]; label: string; missing: MissingStrategy } | null;
  ownedScores?: string[];
  children: (setup: SharedAnalysisSetup) => ReactNode;
}) {
  const scoreKey = ownedScores.join('\u0000');
  const columns = useMemo(() => {
    const scores = new Set(scoreKey.split('\u0000'));
    return table.columns.filter(c => !isPCColumn(c) && c !== 'Cluster' && !scores.has(c));
  }, [table.columns, scoreKey]);
  const numeric = useMemo(() => new Set(numericColumnsOf(table)), [table]);
  const [selected, setSelected] = useState<string[]>(() => columns.filter(c => numeric.has(c) && !isIdentifierColumn(c)));
  const [label, setLabel] = useState('');
  const [missing, setMissing] = useState<MissingStrategy>('median');
  const [measurements, setMeasurements] = useState<Record<string, MeasurementChoice>>({});
  const [search, setSearch] = useState('');
  const [labelTouched, setLabelTouched] = useState(false);
  const anchor = useRef<{ column: string; checked: boolean } | null>(null);
  const [syncedSeq, setSyncedSeq] = useState(externalRun?.seq ?? 0);
  // An assistant-triggered run becomes the displayed setup. Render-time state
  // adjustment prevents one paint showing controls from the preceding run.
  if (externalRun && syncedSeq !== externalRun.seq) {
    setSyncedSeq(externalRun.seq);
    setSelected(externalRun.vars.filter(c => columns.includes(c)));
    setLabel(externalRun.label);
    setLabelTouched(true);
    setMissing(externalRun.missing);
  }
  const liveSelected = useMemo(() => selected.filter(c => columns.includes(c)), [selected, columns]);
  const visible = useMemo(() => columns.filter(c => c.toLowerCase().includes(search.toLowerCase())), [columns, search]);
  const suggestions = useMemo(() => Object.fromEntries(liveSelected.map(c => {
    try {
      const inferred = inferMeasurement(fittingTable.data[c] ?? [], { measurement: measurements[c] ?? 'auto' });
      return [c, inferred.kind === 'ordinal' ? 'categorical' : inferred.kind];
    } catch { return [c, 'Needs review']; }
  })), [liveSelected, fittingTable, measurements]);
  const missingPct = useMemo(() => Object.fromEntries(table.columns.map(c => {
    let missing = 0;
    for (let i = 0; i < fittingTable.nRows; i++) {
      const v = fittingTable.data[c]?.[i];
      if (v === null || v === undefined || v === '' || (typeof v === 'number' && !Number.isFinite(v))) missing++;
    }
    return [c, fittingTable.nRows ? missing / fittingTable.nRows * 100 : 0];
  })), [table.columns, fittingTable]);
  const choose = (next: string[]) => {
    setSelected(next);
    if (!labelTouched) setLabel(deriveRunLabel(next) ?? '');
  };
  const toggle = (column: string, shift: boolean) => {
    const checked = !liveSelected.includes(column);
    const begin = anchor.current ? visible.indexOf(anchor.current.column) : -1;
    const end = visible.indexOf(column);
    if (shift && begin >= 0 && end >= 0 && anchor.current) {
      const range = visible.slice(Math.min(begin, end), Math.max(begin, end) + 1);
      const set = new Set(liveSelected);
      range.forEach(c => anchor.current!.checked ? set.add(c) : set.delete(c));
      choose(columns.filter(c => set.has(c)));
    } else {
      anchor.current = { column, checked };
      choose(columns.filter(c => c === column ? checked : liveSelected.includes(c)));
    }
  };
  const missingMethod = MISSING_METHODS.find(m => m.value === missing)!;
  return <div className="space-y-3 text-xs" data-guide="decomposition-setup">
    <label className="block space-y-1"><span className="opacity-70">Run label</span>
      <input aria-label="Run label" type="text" value={label}
        onChange={e => { setLabelTouched(e.target.value.trim().length > 0); setLabel(e.target.value); }}
        placeholder="run label (optional)" className="w-full bg-[var(--input)] border border-[var(--border)] p-1.5 text-xs outline-none" />
    </label>
    <div className="space-y-1">
      <div className="flex items-center justify-between"><span className="opacity-60">{liveSelected.length}/{columns.length} items</span>
        <span className="flex gap-2">
          <button type="button" className="underline-offset-2 hover:underline opacity-60 hover:opacity-100 cursor-pointer" title="Select numeric items, excluding identifiers" onClick={() => { anchor.current = null; choose(columns.filter(c => numeric.has(c) && !isIdentifierColumn(c))); }}>all</button>
          <button type="button" className="underline-offset-2 hover:underline opacity-60 hover:opacity-100 cursor-pointer" onClick={() => { anchor.current = null; choose([]); }}>none</button>
        </span>
      </div>
      <input aria-label="Find analysis items" placeholder="Find items" value={search} onChange={e => { setSearch(e.target.value); anchor.current = null; }} className="w-full bg-[var(--input)] border border-[var(--border)]/30 p-1.5 text-xs" />
      <div className="max-h-36 overflow-y-auto space-y-0.5 pr-1 border border-[var(--border)]/30 p-1.5" role="group" aria-label="Analysis items">
        {visible.map(c => <label key={c} className="flex items-center gap-2 cursor-pointer hover:bg-[var(--foreground)]/5 select-none">
          <input type="checkbox" aria-label={`Select ${c}`} checked={liveSelected.includes(c)}
            onChange={e => toggle(c, (e.nativeEvent as MouseEvent).shiftKey ?? false)} />
          <span className="truncate flex-1" title={c}>{c}</span>
          {isIdentifierColumn(c) && <span className="text-[10px] opacity-50" title="Identifier: excluded from automatic selection">ID</span>}
          {missingPct[c] > 0 && <span className="flex-shrink-0 text-[10px] opacity-50" title={`${missingPct[c].toFixed(0)}% missing in the fitting sample`}>{missingPct[c].toFixed(0)}% NA</span>}
        </label>)}
        {!visible.length && <p className="opacity-50 p-1">No matching items.</p>}
      </div>
      <p className="text-[10px] opacity-50">Shift-click to select or clear a range.</p>
      <details><summary className="cursor-pointer text-[11px] opacity-70">Item types <InfoTip label="Automatic item types" text="A small repeated integer scale suggests ordered categories; other numeric columns suggest continuous measurements. This is a heuristic. Override it here; the actual fitting sample determines automatic fill rules. Text categories require an explicit order in EFA." /></summary>
        <div className="max-h-40 overflow-auto space-y-1 pt-2">{liveSelected.map(c => {
          return <label className="flex items-center gap-2" key={c}><span className="truncate flex-1" title={c}>{c}</span>
            <select aria-label={`Item type ${c}`} value={measurements[c] ?? 'auto'} onChange={e => setMeasurements(prev => ({ ...prev, [c]: e.target.value as MeasurementChoice }))} className="max-w-[11rem] bg-[var(--input)] border border-[var(--border)] px-1 py-0.5">
              <option value="auto">Auto · {suggestions[c]}</option><option value="ordinal">Ordered categorical</option><option value="continuous">Continuous</option>
            </select></label>;
        })}</div>
      </details>
    </div>
    <div className="flex gap-2" role="group" aria-label="Analysis method">
      {(['pca', 'efa'] as const).map(value => <PanelChoiceButton key={value} selected={method === value}
        onClick={() => { if (value === 'efa' && missing === 'iterative') setMissing('median'); onMethodChange(value); }}>{value.toUpperCase()}</PanelChoiceButton>)}
    </div>
    <div className="space-y-1"><label htmlFor="analysis-missing" className="opacity-70">Missing values</label>
      <div className="flex items-center gap-1"><select id="analysis-missing" aria-label="Missing values" value={missing} onChange={e => setMissing(e.target.value as MissingStrategy)} className="flex-1 min-w-0 bg-[var(--input)] border border-[var(--border)] p-1.5">
        {MISSING_METHODS.filter(m => method === 'pca' || m.value !== 'iterative').map(m => <option key={m.value} value={m.value}>{m.name}</option>)}
      </select><InfoTip label={missingMethod.name} text={missingMethod.info} /></div>
    </div>
    {children({ label, selected: liveSelected, missing, measurements })}
  </div>;
}
