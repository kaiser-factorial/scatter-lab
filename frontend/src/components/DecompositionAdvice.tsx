"use client";
import { useEffect, useRef, useState } from 'react';
import type { DataTable } from '@/lib/table';
import type { AdvicePatch, DecompositionAdvice as Advice, DecompositionAdviceOptions } from '@/lib/decomposition-advice';
import { analyzeItemsAsync } from '@/lib/decomposition-advice-service';
import { InfoTip } from './InfoTip';

const button = 'scatterlab-action-button border border-[var(--border)] bg-[var(--input)] px-2 py-1 text-xs font-bold disabled:opacity-40';
export function DecompositionAdvice({ table, columns, options, contextKey = '', onApply }: {
  table: DataTable; columns: string[]; options: DecompositionAdviceOptions; contextKey?: string;
  onApply: (patch: AdvicePatch) => void;
}) {
  const key = JSON.stringify({ columns, options, contextKey });
  const abort = useRef<AbortController | null>(null);
  const [pending, setPending] = useState<{ key: string; table: DataTable } | null>(null);
  const [saved, setSaved] = useState<{ key: string; table: DataTable; report: Advice } | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => () => { abort.current?.abort(); }, [key, table]);
  const busy = pending?.key === key && pending.table === table;
  const report = saved?.key === key && saved.table === table ? saved.report : undefined;
  const analyze = async () => {
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    setPending({ key, table }); setMessage('');
    try {
      const report = await analyzeItemsAsync(table, columns, options, controller.signal);
      if (!controller.signal.aborted) setSaved({ key, table, report });
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : 'Item analysis failed.');
    } finally { if (abort.current === controller) { setPending(null); abort.current = null; } }
  };
  return <section className="space-y-2 border border-[var(--border)]/50 p-2" aria-label="Item and method guidance">
    <div className="flex items-center gap-1">
      <button type="button" className={button + ' flex-1'} disabled={columns.length < 2 || busy} onClick={() => void analyze()}>{busy ? 'Analyzing items…' : 'Analyze selected items'}</button>
      <InfoTip label="About method guidance" text="Profiles the selected items in the current fitting sample. Measurement levels are suggestions until confirmed. Distribution diagnostics do not establish a Gaussian joint model or reveal why responses are missing. Applying a suggestion changes controls; it does not run an analysis." />
      {busy && <button type="button" className={button} onClick={() => { abort.current?.abort(); setPending(null); }}>Cancel</button>}
    </div>
    {saved && !report && <p className="text-[11px] opacity-70">Items, settings or fitting rows changed. Analyze again for current guidance.</p>}
    {report && <div className="space-y-2" aria-live="polite">
      <p>{report.itemCount} items · {report.sample.rows.toLocaleString()} fitting rows · {(report.sample.missingRate * 100).toFixed(1)}% missing cells</p>
      <p className="text-[11px] opacity-75">Complete cases: {report.sample.completeRows.toLocaleString()} retained, {report.sample.incompleteRows.toLocaleString()} dropped. Minimum observed pair: {report.sample.pairSupportChecked ? report.sample.minimumObservedPairN?.toLocaleString() : 'not checked at this size'}. Missingness patterns: {report.sample.missingnessPatternsTruncated ? '≥' : ''}{report.sample.missingnessPatternCount.toLocaleString()}.</p>
      <details><summary className="cursor-pointer">Item types and distributions</summary>
        <div className="max-h-52 overflow-auto mt-2"><table className="w-full text-[11px]"><thead><tr className="text-left"><th>Item</th><th>Type</th><th>Shape</th></tr></thead><tbody>
          {report.items.map(item => <tr key={item.column} className="border-t border-[var(--border)]/20"><td className="max-w-28 truncate py-1" title={item.column}>{item.column}</td><td>{item.classification.replace(/-/g, ' ')}<InfoTip label={`${item.column} type`} text={item.basis} /></td><td>{item.distribution?.assessed ? [item.distribution.skewed ? 'Skewed' : 'No strong skew flag', item.distribution.heavyTailed ? 'Heavy tails' : ''].filter(Boolean).join(' · ') : 'Not assessed'}</td></tr>)}
        </tbody></table></div>
      </details>
      {report.issues.map((issue, index) => <p key={`${issue.code}-${index}`} className={issue.severity === 'blocker' ? 'font-bold' : 'opacity-80'}>{issue.message}</p>)}
      {report.recommendations.map(recommendation => <details key={recommendation.id} open={recommendation.priority === 'primary'} className="border-t border-[var(--border)]/30 pt-1">
        <summary className="cursor-pointer font-bold">{recommendation.title}</summary>
        <div className="space-y-1 py-2">
          {recommendation.reasons.map(reason => <p key={reason}>{reason}</p>)}
          {recommendation.assumptions.map(assumption => <p key={assumption} className="opacity-75">{assumption}</p>)}
          {!!Object.keys(recommendation.patch).length && <p className="font-bold">Settings: {Object.entries(recommendation.patch).map(([name, value]) => `${name}: ${value}`).join(' · ')}</p>}
          {!!Object.keys(recommendation.patch).length && <button type="button" className={button} disabled={report.issues.some(issue => issue.severity === 'blocker')} onClick={() => { onApply(recommendation.patch); setMessage('Suggested settings applied. Review the setup before running.'); }}>Apply these settings</button>}
        </div>
      </details>)}
      <details><summary className="cursor-pointer opacity-70">How this was assessed</summary>{report.diagnosticBasis.map(text => <p key={text} className="mt-1 opacity-70">{text}</p>)}</details>
    </div>}
    {message && <p role="status">{message}</p>}
  </section>;
}
