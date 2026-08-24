"use client";
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import {
  codeTierLabel, describeCodeEntry, parseDeclaredCodes, scanForCodes,
  type CodeEntry, type RecodePlan,
} from '@/lib/recode';
import type { DataTable } from '@/lib/table';
import { InfoTip } from '@/components/InfoTip';

// Declaring missing-value codes and blanking them, per column — in two stages.
//
// STAGE 'ask' appears after an upload and costs nothing: it is one question and
// two buttons, and NO scan has run yet. Import used to scan every column for
// sentinel codes synchronously, which was measurable latency on wide survey
// tables; now the scan runs only when the user says yes.
//
// STAGE 'configure' runs the detector, takes declared codes, and offers a
// checkbox for every column/value pair. The choice is PER COLUMN on purpose:
// declaring that 9 means "Don't Know" finds it in a Likert item and in a
// child's age alike, and only the researcher can say which is which.
//
// The stage lives in the PARENT ('ask' | 'configure' | null), so opening from
// an upload starts at the question while the sidebar button jumps straight to
// the scan — and this component needs no state-syncing effect.
//
// JSX seam rule, learned twice now: the compiler trims leading whitespace per
// LINE of a multi-line text node, so a space after an inline tag survives only
// if the text stays on that line. Every seam below is either {' '} or a line
// break directly after the tag (a newline adjacent to text becomes one space).

export type RecodeStage = 'ask' | 'configure';

export const RecodeDialog = ({
  stage, table, theme, onProceed, onClose, onApply,
}: {
  stage: RecodeStage | null;
  table: DataTable | null;
  theme?: string;
  /** Advance from the question to the scan. */
  onProceed: () => void;
  onClose: () => void;
  /** Applies the plan and returns a plain-language account of what changed. */
  onApply: (plan: RecodePlan) => string[];
}) => {
  const bauhaus = theme === 'primary';
  const [declaredText, setDeclaredText] = useState('');
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [report, setReport] = useState<string[] | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);

  const open = stage !== null;
  const declared = useMemo(() => parseDeclaredCodes(declaredText), [declaredText]);

  // The scan runs only in the configure stage — the question itself is free.
  const hits = useMemo(
    () => (stage === 'configure' && table ? scanForCodes(table, declared) : []),
    [stage, table, declared],
  );

  // Each value's default comes from the EVIDENCE for it (`entry.suggested`), so
  // a code the detector is confident about starts ticked and a bare possibility
  // does not. That is DERIVED, not seeded into state by an effect: `checked`
  // holds only the boxes the user has explicitly toggled, and absent means
  // "whatever the evidence suggested".
  const keyOf = (column: string, value: number) => `${column} ${value}`;
  const isOn = (column: string, e: CodeEntry) => checked[keyOf(column, e.value)] ?? e.suggested;
  const setAll = (v: boolean | null) => setChecked(
    v === null ? {} : Object.fromEntries(hits.flatMap(h => h.entries.map(e => [keyOf(h.column, e.value), v]))),
  );

  // Closing ends the transaction: the report, the declared codes and every
  // hand-toggled box go with it. Found in a browser run — the declaration box
  // kept "9" after the dataset was cleared and a DIFFERENT file loaded, so a
  // stale declaration silently pre-selected columns in a table the user had never
  // declared anything about. Same for `checked`, whose keys are column names and
  // so collide across files. An event handler, not an effect keyed on `open`.
  const close = () => { setReport(null); setDeclaredText(''); setChecked({}); onClose(); };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    closeBtn.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  const accent = bauhaus ? 'var(--p-blue)' : 'var(--system-green)';
  const rule = bauhaus ? 'var(--border)' : 'color-mix(in srgb, var(--system-green) 40%, transparent)';

  const plan: RecodePlan = { byColumn: {} };
  let totalCells = 0;
  for (const h of hits) {
    const on = h.entries.filter(e => isOn(h.column, e));
    if (!on.length) continue;
    plan.byColumn[h.column] = on.map(e => e.value);
    for (const e of on) totalCells += e.count;
  }
  const nCols = Object.keys(plan.byColumn).length;

  // Tier styling stays inside the theme's own palette: the accent for a code the
  // detector stands behind, plain dimmed text for one it is merely raising.
  const tierStyle = (e: CodeEntry) =>
    e.confidence === 'certain' ? { color: accent, opacity: 1 }
    : e.confidence === 'likely' ? { color: accent, opacity: 0.75 }
    : { opacity: 0.55 };

  const btn = (kind: 'go' | 'quiet') =>
    `px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide cursor-pointer border disabled:opacity-40 ${
      kind === 'go'
        ? (bauhaus ? 'bauhaus-btn bg-[var(--p-blue)] text-white border-[var(--border)]'
                   : 'bg-[var(--system-green)] text-black border-[var(--system-green)]')
        : (bauhaus ? 'border-[var(--border)] bg-[var(--input)]'
                   : 'border-[var(--system-green)]/40 bg-[var(--input)] text-[var(--system-green)]/80')
    }`;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Missing value codes"
      className="fixed inset-0 z-[320] flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-8"
      onMouseDown={e => { if (!panel.current?.contains(e.target as Node)) close(); }}
    >
      <div
        ref={panel}
        className={`w-full ${stage === 'ask' ? 'max-w-md' : 'max-w-2xl'} my-auto border bg-[var(--card)] text-[var(--foreground)] ${
          bauhaus ? 'border-[3px] border-[var(--border)]' : 'border-[var(--border)]'}`}
      >
        <header className={`flex items-center justify-between gap-3 px-4 py-3 border-b ${
          bauhaus ? 'bg-[var(--p-blue)] text-white border-[var(--border)]'
                  : 'bg-[var(--system-green)]/15 border-[var(--system-green)] text-[var(--system-green)]'}`}>
          <h2 className="text-sm font-bold uppercase tracking-wide">
            Missing value codes
          </h2>
          <button
            ref={closeBtn}
            onClick={close}
            aria-label="Close"
            className={`cursor-pointer transition-all duration-150 ${
              bauhaus ? 'flex items-center justify-center w-6 h-6 border-2 border-[var(--border)] bg-[var(--p-red)] text-white hover:bg-[var(--p-yellow)] hover:text-[#111111]'
                      : 'text-[var(--system-green)]/70 hover:text-[var(--system-green)] hover:scale-125'}`}
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {stage === 'ask' ? (
          <div className="px-4 py-4 space-y-4 text-[12px] leading-relaxed">
            <p className="opacity-90">
              Scan for sentinel codes?{' '}
              <span className="opacity-70">(e.g. 9 = &ldquo;Don&apos;t Know&rdquo;)</span>
              <InfoTip topic="missing_value_codes" />
            </p>
            <div className="flex justify-end gap-2">
              <button className={btn('quiet')} onClick={close}>No thanks</button>
              <button className={btn('go')} onClick={onProceed}>Yes, check</button>
            </div>
          </div>
        ) : (
          <div className="px-4 py-4 space-y-4 text-[12px] leading-relaxed">
            <p className="opacity-80">
              <strong>Choose per column</strong>{' '}
              — the same code can be real data in one variable and a code in another. Boxes start
              ticked only where the evidence is strong.
              <InfoTip topic="missing_value_codes" />
            </p>

            <label className="block">
              <span className="opacity-70">Known sentinel codes (optional — comma separated)</span>
              <input
                type="text"
                value={declaredText}
                onChange={e => setDeclaredText(e.target.value)}
                placeholder="e.g. 9, 99, -99"
                className="mt-1 w-full bg-[var(--input)] border border-[var(--border)] p-2 text-sm outline-none"
              />
              <span className="opacity-60 text-[11px]">
                Declared codes are matched exactly, with no plausibility test. Anything the detector spotted on
                its own is listed below already.
              </span>
            </label>

            {hits.length === 0 ? (
              <p>
                <span className={`font-bold ${bauhaus ? 'text-[var(--p-red)]' : 'text-red-400'}`}>Nothing found.</span>{' '}
                <span className="opacity-70">
                  Type the codes your survey used above, and any column containing them will appear here.
                </span>
              </p>
            ) : (
              <>
                <div className="flex items-center gap-2 text-[11px] opacity-70">
                  <span>Tick:</span>
                  <button className="underline cursor-pointer hover:opacity-100" onClick={() => setAll(true)}>all</button>
                  <button className="underline cursor-pointer hover:opacity-100" onClick={() => setAll(false)}>none</button>
                  <button className="underline cursor-pointer hover:opacity-100" onClick={() => setAll(null)}>suggested</button>
                </div>
                <div className="space-y-2 max-h-[46vh] overflow-y-auto pr-1">
                  {hits.map(h => (
                    <div key={h.column} className="border-b pb-2" style={{ borderColor: rule }}>
                      <div className="font-bold" style={{ color: accent }}>{h.column}</div>
                      <div className="mt-1 space-y-1">
                        {h.entries.map(e => {
                          const k = keyOf(h.column, e.value);
                          const why = describeCodeEntry(e);
                          return (
                            <label key={e.value} className="flex items-start gap-1.5 cursor-pointer">
                              <input
                                type="checkbox"
                                className="mt-[3px] shrink-0"
                                checked={isOn(h.column, e)}
                                onChange={ev => setChecked(c => ({ ...c, [k]: ev.target.checked }))}
                              />
                              <span className="min-w-0">
                                <b>{e.value}</b>
                                <span className="opacity-60">
                                  {` · ${e.count} row${e.count === 1 ? '' : 's'} · `}
                                </span>
                                <span className="uppercase tracking-wide text-[10px]" style={tierStyle(e)}>
                                  {codeTierLabel(e)}
                                </span>
                                {why !== '' && (
                                  <span className="block opacity-55 text-[11px] leading-snug">{why}</span>
                                )}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {report && (
              <div className="border p-2 space-y-1" style={{ borderColor: rule }}>
                <div className="font-bold" style={{ color: accent }}>What changed</div>
                {report.map((line, i) => (
                  <div key={i} className={/INTERNAL ERROR/.test(line) ? 'text-[var(--p-red)] font-bold' : 'opacity-80'}>
                    {line}
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="opacity-60 text-[11px]">
                {nCols === 0
                  ? 'Nothing selected.'
                  : `${totalCells} cell${totalCells === 1 ? '' : 's'} in ${nCols} column${nCols === 1 ? '' : 's'} will be blanked.`}
              </span>
              <div className="flex gap-2">
                <button className={btn('quiet')} onClick={close}>
                  {report ? 'Done' : 'Not now'}
                </button>
                <button
                  className={btn('go')}
                  disabled={nCols === 0}
                  onClick={() => setReport(onApply(plan))}
                >
                  Replace with blanks
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};

export default RecodeDialog;
