"use client";
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { DISCLOSURES, DISCLOSURE_SECTIONS, emphasisSegments } from '@/lib/disclosures';

// Disclosure lines may carry **emphasis**; render it, nothing more.
const DisclosureLine = ({ line }: { line: string }) => (
  <>{emphasisSegments(line).map((s, i) => s.bold ? <strong key={i}>{s.text}</strong> : <span key={i}>{s.text}</span>)}</>
);
import { METHODS } from '@/lib/methods';

// The long-form companion to the (i) tooltips.
//
// Every word here is READ from disclosures.ts and methods.ts — nothing is
// retyped. That is the whole point: the app already had the same facts written
// in three places and they had drifted apart (finding A3), so a fourth copy
// living in a React component would be the same mistake with better formatting.
// If a disclosure changes, the tooltip, this page and the assistant's reference
// all change together or none of them do.
//
// Portalled to <body> and `fixed`, for the reason InfoTip documents at length:
// the sidebar is `overflow-y-auto` and a positioned stacking context, and the
// plot is a WebGL canvas. Anything floating above both has to leave the tree.

type Tab = 'app' | 'methods';

export const InfoDialog = ({
  open,
  onClose,
  theme,
}: {
  open: boolean;
  onClose: () => void;
  theme?: string;
}) => {
  const [tab, setTab] = useState<Tab>('app');
  const panel = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    // Move focus into the dialog so Escape and Tab go somewhere sensible.
    closeBtn.current?.focus();
    // The page behind must not scroll while a full-height overlay is up.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  const bauhaus = theme === 'primary';

  // Terminal's --border is oklch(0.2 0 0) — nearly the same black as the card
  // it sits on. Every rule in here used to be drawn in it, which is why the
  // section dividers were invisible on that theme. Each theme now names its own
  // visible line colour and its own heading accent instead of sharing one token.
  const accent = bauhaus ? 'var(--p-blue)' : 'var(--system-green)';
  const rule = bauhaus
    ? 'var(--border)'
    : 'color-mix(in srgb, var(--system-green) 40%, transparent)';
  const softRule = bauhaus
    ? 'var(--border)'
    : 'color-mix(in srgb, var(--system-green) 22%, transparent)';

  const tabCls = (t: Tab) =>
    `px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide cursor-pointer border transition-colors duration-150 ${tab === t
      ? (bauhaus
        ? 'bg-[var(--p-yellow)] text-[#111111] border-[var(--border)]'
        : 'bg-[var(--system-green)] text-black border-[var(--system-green)]')
      : (bauhaus
        ? 'border-[var(--border)] opacity-60 hover:opacity-100'
        : 'border-[var(--system-green)]/40 text-[var(--system-green)]/70 hover:text-[var(--system-green)] hover:border-[var(--system-green)] hover:bg-[var(--system-green)]/10')
    }`;

  // One heading style, both themes: blue on primary, green on terminal, and a
  // rule underneath that is actually visible on each.
  const sectionTitle = (text: string) => (
    <h3
      className="text-[13px] font-bold uppercase tracking-wide pb-1 border-b"
      style={{ color: accent, borderColor: rule }}
    >
      {text}
    </h3>
  );

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="About Scatter Lab and its methods"
      className="fixed inset-0 z-[300] flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-8"
      onMouseDown={e => { if (!panel.current?.contains(e.target as Node)) onClose(); }}
    >
      <div
        ref={panel}
        className={`w-full max-w-3xl my-auto border bg-[var(--card)] text-[var(--foreground)] ${bauhaus ? 'border-[3px] border-[var(--border)]' : 'border-[var(--border)]'
          }`}
      >
        {/* On terminal the header borrows the "> upload data" button's own
            language — tinted green fill, solid green edge, green text. */}
        <header className={`flex items-center justify-between gap-3 px-4 py-3 border-b ${bauhaus
          ? 'bg-[var(--p-blue)] text-white border-[var(--border)]'
          : 'bg-[var(--system-green)]/15 border-[var(--system-green)] text-[var(--system-green)]'
          }`}>
          <h2 className="text-sm font-bold uppercase tracking-wide">About Scatter Lab</h2>
          {/* Primary had no hover feedback at all here. A filled chip carries the
              red→yellow change legibly against the blue header; plain red glyph
              on blue would be near-unreadable. */}
          <button
            ref={closeBtn}
            onClick={onClose}
            aria-label="Close"
            className={`cursor-pointer transition-all duration-150 ${bauhaus
              ? 'flex items-center justify-center w-6 h-6 border-2 border-[var(--border)] bg-[var(--p-red)] text-white hover:bg-[var(--p-yellow)] hover:text-[#111111] hover:-translate-y-px active:translate-y-0'
              : 'text-[var(--system-green)]/70 hover:text-[var(--system-green)] hover:scale-125'
              }`}
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="px-4 py-4 space-y-5 text-[12px] leading-relaxed">
          <p className="opacity-80">
            Scatter Lab is an <strong>exploratory data analysis</strong> tool. It plots high-dimensional data in
            two or three dimensions and runs PCA and clustering over it, so you can see what structure is there.
          </p>
          <p className="opacity-80">
            <strong>All computation happens in this browser tab.</strong> Parsing, PCA, clustering and
            statistics run on your own machine, your dataset is never uploaded to a server — there is no backend
            to send it to — and closing the tab discards it, so <strong>save a workspace</strong> if you want it back.
          </p>
          <p className="opacity-80">
            The assistant is the exception if you choose to connect an API key: your questions and a
            summary of the data will be sent to the model provider. The assistant can see:
          </p>
          <ul className="list-disc pl-5 space-y-1 opacity-80">
            <li>column names</li>
            <li>each numeric column&apos;s range, mean, standard deviation and quartiles</li>
            <li>the common values of categorical columns</li>
            <li>the results of the analyses it runs</li>
          </ul>
          <p className="opacity-80">
            <strong>It never sees individual rows.</strong> A categorical value is only named if it covers at
            least five rows, which reduces the chance of the model seeing an email address, name or
            free-text answer.
          </p>
          <p className="opacity-80">
            If this is more than you are comfortable with, leave the assistant disconnected; everything else
            here works without it.
          </p>


          <div className="flex justify-center gap-2 pt-1">
            <button className={tabCls('app')} onClick={() => setTab('app')}>Defaults &amp; trade-offs</button>
            <button className={tabCls('methods')} onClick={() => setTab('methods')}>Methods reference</button>
          </div>

          {tab === 'app' ? (
            <div className="space-y-5">
              <p className="opacity-70 text-[11px] text-center">
                The choices this app makes on your behalf, and what each one costs.{' '}
                <em>This page is an extension of the notes behind the <span className="font-bold">(i)</span> icons in the sidebar.</em>
              </p>
              {DISCLOSURE_SECTIONS.map(section => (
                <section key={section.heading} className="space-y-3">
                  {sectionTitle(section.heading)}
                  {section.keys.map(key => {
                    const d = DISCLOSURES[key];
                    // One list, two tiers: `text` is also what the tooltip shows,
                    // `more` is the detail that only belongs here. Dimming the
                    // second tier keeps the split legible without a subheading.
                    return (
                      <div key={key} className="space-y-1">
                        <h4 className="font-bold">{d.title}</h4>
                        <ul className="list-disc pl-5 space-y-1">
                          {d.text.map((line, i) => (
                            <li key={`t${i}`} className="opacity-80"><DisclosureLine line={line} /></li>
                          ))}
                          {(d as { more?: readonly string[] }).more?.map((line, i) => (
                            <li key={`m${i}`} className="opacity-60"><DisclosureLine line={line} /></li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </section>
              ))}
            </div>
          ) : (
            <div className="space-y-4">
              <p className="opacity-70 text-[11px] text-center">
                Background on the methods themselves, with citations.{' '}
                <em>
                  This is the same reference the assistant pulls from when you ask it to help interpret a
                  result, so its answers and this page cannot disagree.
                </em>
              </p>
              {Object.entries(METHODS).map(([key, chunk]) => (
                <div key={key}>
                  <h4 className="font-bold">{chunk.title}</h4>
                  <p className="opacity-80">{chunk.text}</p>
                </div>
              ))}
            </div>
          )}

          <p className="opacity-60 text-[11px] pt-2 border-t" style={{ borderColor: softRule }}>
            Demo dataset: Fisher&apos;s iris data, from the UCI Machine Learning Repository
            (<code>bezdekIris.data</code>, doi.org/10.24432/C56C76). Provenance and checksums are recorded in
            <code> public/demo/iris.SOURCE.md</code>.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default InfoDialog;
