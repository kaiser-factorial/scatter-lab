"use client";

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, X } from 'lucide-react';
import { convergenceRetryError, type ConvergenceIssue, type ConvergenceRetrySettings } from '@/lib/convergence';

export interface ConvergenceDialogProps {
  issue: ConvergenceIssue | null;
  theme?: string;
  onRetry: (settings: ConvergenceRetrySettings) => void;
  onKeep?: () => void;
  onDismiss: () => void;
  disabled?: boolean;
}

const metric = (value: number | null | undefined) => value == null ? 'Unavailable' : value.toPrecision(5);
const reasons = {
  'iteration-limit': 'Iteration limit reached',
  'line-search': 'No improving step found',
  stalled: 'Parameters stopped moving',
  'non-finite': 'Non-finite numerical result',
  mixed: 'Different stopping reasons',
  converged: 'Converged',
};

/** A failed numerical attempt is separate from the user's decision to retry. */
export function ConvergenceDialog(props: ConvergenceDialogProps) {
  if (!props.issue || typeof document === 'undefined') return null;
  // A newly failed attempt gets fresh controls; ordinary parent renders do not
  // overwrite edits to the currently displayed attempt.
  return <ConvergenceDialogContent key={JSON.stringify(props.issue)} {...props} issue={props.issue} />;
}

function ConvergenceDialogContent({ issue, theme, onRetry, onKeep, onDismiss, disabled = false }: ConvergenceDialogProps & { issue: ConvergenceIssue }) {
  const titleId = useId(), descriptionId = useId(), panel = useRef<HTMLDivElement>(null), firstInput = useRef<HTMLInputElement>(null);
  const dismissRef = useRef(onDismiss), disabledRef = useRef(disabled);
  const [settings, setSettings] = useState<ConvergenceRetrySettings>(() => ({ ...issue.settings,
    maxIterations: issue.reason === 'iteration-limit'
      ? Math.min(20000, Math.max(issue.method === 'iterative-pca' ? 1000 : 0, issue.settings.maxIterations * 2))
      : issue.settings.maxIterations,
  }));
  const pca = issue.method === 'iterative-pca', primary = theme === 'primary';
  const name = pca ? 'Iterative PCA' : issue.method.toUpperCase();
  const validation = convergenceRetryError(issue.method, settings);
  const control = 'mt-1 w-full border border-[var(--border)] bg-[var(--input)] p-2 text-sm text-[var(--foreground)] focus-visible:outline-2 focus-visible:outline-offset-2';
  const button = `px-3 py-2 text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer ${primary ? 'bauhaus-btn' : 'border border-[var(--border)] transition-colors hover:bg-[var(--input)]'}`;
  const update = (key: keyof ConvergenceRetrySettings, value: number) => setSettings(previous => ({ ...previous, [key]: value }));

  useEffect(() => { dismissRef.current = onDismiss; disabledRef.current = disabled; }, [onDismiss, disabled]);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null, previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    firstInput.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (!disabledRef.current) dismissRef.current();
      }
      if (event.key !== 'Tab') return;
      const focusable = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary, [tabindex="0"]') ?? [])]
        .filter(element => !element.closest('fieldset:disabled') &&
          (!element.closest('details:not([open])') || element.tagName === 'SUMMARY'));
      const first = focusable[0], last = focusable.at(-1);
      if (!first) { event.preventDefault(); panel.current?.focus(); return; }
      if (!panel.current?.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  const explanation = issue.reason === 'iteration-limit'
    ? pca
      ? 'The reconstruction reached its iteration limit before meeting the stopping criterion.'
      : 'None of the starting points met the requested gradient tolerance within the iteration limit.'
    : issue.reason === 'line-search'
      ? 'The optimizer could not find a further improving step while the gradient remained above tolerance.'
      : issue.reason === 'stalled'
        ? 'The parameters stopped changing at numerical precision before the gradient met the requested tolerance.'
        : issue.reason === 'non-finite'
          ? 'The calculation stopped without a finite numerical solution.'
          : 'The starting points stopped for different reasons before meeting the requested tolerance.';

  return createPortal(
    <div className="fixed inset-0 z-[450] flex items-center justify-center bg-black/60 p-4" onMouseDown={event => {
      if (event.target === event.currentTarget && !disabled) onDismiss();
    }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}
        className={`max-h-[90vh] w-full max-w-xl overflow-y-auto bg-[var(--card)] text-[var(--foreground)] shadow-xl ${primary ? 'border-[3px] border-[var(--border)]' : 'border border-[var(--border)]'}`}>
        <header className={`flex items-center gap-2 border-b border-[var(--border)] px-4 py-3 ${primary ? 'bg-[var(--p-blue)] text-white' : 'bg-[var(--input)]'}`}>
          <CircleAlert size={20} aria-hidden="true" />
          <h2 id={titleId} className="flex-1 text-sm font-bold">{name} did not converge</h2>
          <button type="button" onClick={onDismiss} disabled={disabled} aria-label="Close convergence dialog"
            className={`flex h-7 w-7 items-center justify-center cursor-pointer disabled:opacity-40 ${primary ? 'bauhaus-btn bg-[var(--p-red)] text-white hover:bg-[var(--p-yellow)] hover:text-black' : 'border border-[var(--border)] hover:bg-[var(--card)]'}`}><X size={16} /></button>
        </header>
        <form noValidate className="space-y-4 p-4 text-xs" onSubmit={event => {
          event.preventDefault();
          if (!disabled && !validation) onRetry({ ...settings });
        }}>
          <div id={descriptionId} className="space-y-2 leading-relaxed">
            <p>{explanation}</p>
            <p>{pca && issue.partialAvailable
              ? 'An unconverged result is available locally. It has not been added to the dataset.'
              : 'No fitted model was saved.'}</p>
            <p className="font-bold">Would you like to adjust the settings and retry?</p>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-y border-[var(--border)] py-3 tabular-nums">
            <div><dt className="opacity-70">{issue.bestStart ? `Iterations · best attempt ${issue.bestStart}` : 'Iterations used'}</dt><dd className="font-bold">{issue.iterations} / {issue.settings.maxIterations}</dd></div>
            <div><dt className="opacity-70">{pca ? 'Relative objective change' : 'Projected gradient'}</dt><dd className="font-bold">{metric(pca ? issue.criterion : issue.gradient)}</dd></div>
            <div><dt className="opacity-70">Requested tolerance</dt><dd>{metric(issue.settings.tolerance)}</dd></div>
            <div><dt className="opacity-70">{pca ? 'Reconstruction objective' : 'Mean negative log likelihood'}</dt><dd>{metric(issue.objective)}</dd></div>
          </dl>
          <fieldset disabled={disabled} className="grid grid-cols-2 gap-3">
            <legend className="mb-2 font-bold">Retry settings</legend>
            <label>Iteration limit<input ref={firstInput} aria-label="Retry iteration limit" className={control} type="number" min={pca ? 1 : 10} max={20000} step={1}
              value={Number.isNaN(settings.maxIterations) ? '' : settings.maxIterations} onChange={event => update('maxIterations', event.currentTarget.valueAsNumber)} /></label>
            <label>Tolerance<input aria-label="Retry tolerance" className={control} type="number" min={pca ? 1e-12 : 1e-10} max={pca ? 1e-2 : 1e-3} step="any"
              value={Number.isNaN(settings.tolerance) ? '' : settings.tolerance} onChange={event => update('tolerance', event.currentTarget.valueAsNumber)} /></label>
            {!pca && <label>Starting points<input aria-label="Retry starting points" className={control} type="number" min={1} max={20} step={1}
              value={settings.starts === undefined || Number.isNaN(settings.starts) ? '' : settings.starts} onChange={event => update('starts', event.currentTarget.valueAsNumber)} /></label>}
            <p className="col-span-2 opacity-75">{settings.maxIterations > issue.settings.maxIterations ? 'A larger iteration limit is prefilled. ' : ''}Tolerance keeps its previous value unless you edit it. A larger tolerance accepts a less precise stopping condition.</p>
            <details className="col-span-2">
              <summary className="cursor-pointer font-bold">Advanced settings</summary>
              {pca ? <label className="mt-2 block">Imputation rank<input aria-label="Retry imputation rank" className={control} type="number" min={1} step={1}
                value={settings.rank === undefined || Number.isNaN(settings.rank) ? '' : settings.rank} onChange={event => update('rank', event.currentTarget.valueAsNumber)} /><span className="mt-1 block opacity-75">Changing rank changes the reconstruction model. It is limited by the available items and rows.</span></label>
                : <label className="mt-2 block">Relative uniqueness floor<input aria-label="Retry uniqueness floor" className={control} type="number" min={1e-8} max={.1} step="any"
                  value={settings.uniquenessFloor === undefined || Number.isNaN(settings.uniquenessFloor) ? '' : settings.uniquenessFloor} onChange={event => update('uniquenessFloor', event.currentTarget.valueAsNumber)} /><span className="mt-1 block opacity-75">Relative to each item’s observed variance. Changing this floor changes the fit’s constraints.</span></label>}
            </details>
          </fieldset>
          {issue.starts && <details><summary className="cursor-pointer">Starting-point diagnostics</summary>
            <div className="mt-2 max-h-40 overflow-auto"><table className="w-full text-left tabular-nums"><thead><tr><th>Start</th><th>Iterations</th><th>Gradient</th><th>Stopped because</th></tr></thead>
              <tbody>{issue.starts.map(start => <tr key={start.start}><td>{start.start}</td><td>{start.iterations}</td><td>{metric(start.gradient)}</td><td>{reasons[start.reason]}</td></tr>)}</tbody></table></div>
          </details>}
          {validation && <p role="alert" className="font-bold">{validation}</p>}
          <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--border)] pt-3">
            <button type="button" className={button} disabled={disabled} onClick={onDismiss}>{pca ? 'Cancel' : 'Dismiss'}</button>
            {pca && issue.partialAvailable && onKeep && <button type="button" className={`${button} ${primary ? 'bg-[var(--p-yellow)] text-black' : ''}`} disabled={disabled} onClick={onKeep}>Keep unconverged result</button>}
            <button type="submit" disabled={disabled || !!validation} className={`${button} ${primary ? 'bg-[var(--p-blue)] text-white' : 'bg-[var(--system-green)] text-black hover:opacity-90'}`}>Retry with these settings</button>
          </div>
        </form>
      </div>
    </div>, document.body,
  );
}
