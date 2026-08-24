"use client";
import { useEffect, useRef, useState, memo, useMemo, startTransition } from 'react';
import { createPortal } from 'react-dom';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { Sparkles, Settings2, Minus, CornerDownLeft, ThumbsUp, ThumbsDown, PanelRight, PanelBottom, PictureInPicture2, Compass, LayoutList, Lock, Globe } from 'lucide-react';
import {
  AppBridge, DEFAULT_BASE_URL, DEFAULT_MODEL, MUTATING_TOOLS, ModelInfo,
  runAssistantTurn, fetchModels, suggestModels, describeApiError, paintYield,
} from '@/lib/assistant';
import {
  WALKTHROUGH, WALKTHROUGH_STEPS, FIRST_STEP,
  walkthroughStep, walkthroughIndex, stepAnchorsChoice, assistantGreeting,
} from '@/lib/walkthrough';
import { WalkthroughStartDialog } from '@/components/WalkthroughStartDialog';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { startOpenRouterOAuth, completeOpenRouterOAuth } from '@/lib/openrouterAuth';
import { feedbackEnabled, submitFeedback, flushFeedback } from '@/lib/feedback';
import { InfoTip } from '@/components/InfoTip';
import type { Conversation, ConversationEntry } from '@/lib/workspaces';

// Chat entries for display; the wire-format history is kept separately.
// The shape (incl. `local`, which marks a message this component composed
// rather than a model — the handoff greeting — so it is never offered for
// thumbs feedback) is ConversationEntry, because entries persist in the
// autosaved session and in workspaces.
type ChatEntry = ConversationEntry;

// What the panel is showing. The menu is the front door on a first visit; after
// that the panel opens where the user works and the menu stays one click away
// in the header.
type PanelView = 'menu' | 'walkthrough' | 'chat';

// Lets the page read/replace the conversation for session autosave and
// workspace load — same mutable-ref pattern as askRef. `pending` covers the
// startup race: the panel is dynamically imported, so a session restore can
// finish before the panel exists to receive it; the value waits here and the
// panel applies it on mount.
export type ConversationHandle = {
  get: () => Conversation;
  set: (c: Conversation | null) => void;
};
export type ConversationBridge = { handle: ConversationHandle | null; pending?: Conversation | null };

const LS = {
  key: 'scatterlab.assistant.key',
  model: 'scatterlab.assistant.model',
  baseURL: 'scatterlab.assistant.baseurl',
  layout: 'scatterlab.assistant.layout',
  menuSeen: 'scatterlab.assistant.menuseen',
};

// Panel geometry: bottom-anchored, slidable along the bottom edge, resizable
// from the left/top edges. `right` is the distance from the container's right.
type Layout = { w: number; h: number; right: number };
const DEFAULT_LAYOUT: Layout = { w: 360, h: 560, right: 16 };
const MIN_W = 300, MAX_W = 760, MIN_H = 280;

// Compact markdown styling for assistant bubbles — inherits the chat's tiny
// type scale; neutral tints work on both themes
const MD_COMPONENTS = {
  p: (props: any) => <p className="my-1" {...props} />,
  h1: (props: any) => <div className="font-bold mt-2 mb-1 text-sm" {...props} />,
  h2: (props: any) => <div className="font-bold mt-2 mb-1" {...props} />,
  h3: (props: any) => <div className="font-bold mt-1.5 mb-0.5" {...props} />,
  ul: (props: any) => <ul className="list-disc pl-4 my-1 space-y-0.5" {...props} />,
  ol: (props: any) => <ol className="list-decimal pl-4 my-1 space-y-0.5" {...props} />,
  a: (props: any) => <a className="underline underline-offset-2" target="_blank" rel="noreferrer" {...props} />,
  code: (props: any) => <code className="px-1 bg-[var(--foreground)]/10 rounded-sm" {...props} />,
  pre: (props: any) => <pre className="p-2 my-1 overflow-x-auto text-[10px] bg-[var(--foreground)]/10" {...props} />,
  blockquote: (props: any) => <blockquote className="border-l-2 border-[var(--foreground)]/30 pl-2 my-1 opacity-80" {...props} />,
  hr: () => <hr className="my-2 border-[var(--foreground)]/20" />,
  table: (props: any) => <table className="my-1 text-[10px] border-collapse" {...props} />,
  th: (props: any) => <th className="border border-[var(--foreground)]/20 px-1.5 py-0.5 text-left font-bold" {...props} />,
  td: (props: any) => <td className="border border-[var(--foreground)]/20 px-1.5 py-0.5" {...props} />,
};

export type DockMode = 'right' | 'bottom' | 'float';

// Markdown parsing is memoized per message (finding F10).
//
// The remark pipeline measures ~1.06 ms for a 1 KB reply, and the transcript was
// re-parsed on every render of the panel — which during auto-rotation was sixty
// times a second. A ten-turn conversation therefore added ~11 ms per frame of
// pure re-parsing, and twenty turns blew the 16.7 ms budget on the 150-row iris
// demo. Nothing to do with the data: it was the largest rotation cost at small
// and medium sizes.
const AssistantMarkdown = memo(({ text }: { text: string }) => (
  <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={MD_COMPONENTS}>{text}</ReactMarkdown>
));
AssistantMarkdown.displayName = 'AssistantMarkdown';

const AssistantPanelInner = ({ bridgeRef, theme, askRef, convRef, onConversationChange, dock, onDockChange, onWalkthroughChange, exitWalkthroughRef, startWalkthroughRef, accessMode = 'private', onAccessClick }: {
  bridgeRef: React.MutableRefObject<AppBridge>,
  theme: string | undefined,
  askRef?: React.MutableRefObject<((q: string) => void) | null>,
  convRef?: React.MutableRefObject<ConversationBridge>,
  onConversationChange?: () => void,
  dock: DockMode,
  onDockChange: (d: DockMode) => void,
  // The page disables uploading while the walkthrough drives the workbench, and
  // offers its own way out next to the disabled control.
  onWalkthroughChange?: (active: boolean) => void,
  exitWalkthroughRef?: React.MutableRefObject<(() => void) | null>,
  // "Load demo" on the empty state opens the panel straight into the tour,
  // which loads the data itself as its first act.
  startWalkthroughRef?: React.MutableRefObject<(() => void) | null>,
  // What the assistant may see, decided by the loaded datasets' data modes:
  // 'open' = every dataset open (row tools available), 'mixed' = some open but
  // at least one private (runs private), 'private' = aggregates only.
  accessMode?: 'private' | 'open' | 'mixed',
  // Opens the access-info dialog for the active dataset (the mode itself is
  // locked at upload); absent = nothing loaded to describe.
  onAccessClick?: () => void,
}) => {
  const [open, setOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [baseURL, setBaseURL] = useState(DEFAULT_BASE_URL);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const historyRef = useRef<ChatCompletionMessageParam[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout>(DEFAULT_LAYOUT);
  // Undo: view-state snapshot taken before the last mutating turn
  const [undoSnap, setUndoSnap] = useState<unknown>(null);
  // OAuth failure to surface inside the settings view (chat may be hidden there)
  const [authError, setAuthError] = useState('');
  // Per-message feedback state, keyed by chat index
  const [fb, setFb] = useState<Record<number, { rating: 'up' | 'down'; eventId: string; askWhy: boolean; done: boolean }>>({});

  // --- walkthrough ----------------------------------------------------------
  const [view, setView] = useState<PanelView>('menu');
  const [wtStepId, setWtStepId] = useState<string>(FIRST_STEP);
  const [wtLog, setWtLog] = useState<ChatEntry[]>([]);
  const [wtBusy, setWtBusy] = useState(false);
  const [startDialog, setStartDialog] = useState(false);
  // The held pointer ring, and the state to put back if the walkthrough ran
  // over someone's own workspace.
  const wtHighlight = useRef<(() => void) | null>(null);
  const wtSnap = useRef<unknown>(null);
  const [wtUndo, setWtUndo] = useState<unknown>(null);
  const wtScrollRef = useRef<HTMLDivElement>(null);
  // Set when a key is saved from the settings form, so the chat that replaces it
  // opens with the same greeting the menu route gives.
  const greetRef = useRef(false);

  // Replace the whole conversation (session restore / workspace load). Chat
  // only — walkthrough progress is its own thing and deliberately not persisted.
  const applyConversation = (c: Conversation | null) => {
    setChat((c?.entries ?? []) as ChatEntry[]);
    historyRef.current = (c?.history ?? []) as ChatCompletionMessageParam[];
    setFb({});          // feedback state indexes into the old transcript
    setUndoSnap(null);  // the snapshot refers to app state that no longer exists
  };

  useEffect(() => {
    // A restore that finished before this panel loaded left its conversation
    // waiting in the bridge — apply it now.
    if (convRef && convRef.current.pending !== undefined) {
      applyConversation(convRef.current.pending ?? null);
      convRef.current.pending = undefined;
    }
    setApiKey(localStorage.getItem(LS.key) ?? '');
    // The menu is the front door exactly once. Landing a returning user back on
    // it every time would put a choice in front of them they already made, and
    // "remember the walkthrough" would re-run a demo they have seen.
    setView(localStorage.getItem(LS.menuSeen) === '1' ? 'chat' : 'menu');
    setModel(localStorage.getItem(LS.model) ?? DEFAULT_MODEL);
    setBaseURL(localStorage.getItem(LS.baseURL) ?? DEFAULT_BASE_URL);
    try {
      const saved = JSON.parse(localStorage.getItem(LS.layout) ?? 'null');
      if (saved && typeof saved.w === 'number') setLayout(saved);
    } catch { /* keep defaults */ }
    void flushFeedback(); // retry any feedback buffered while offline
    // Returning from OpenRouter's OAuth approval? Exchange the code for a key.
    completeOpenRouterOAuth()
      .then(key => {
        if (!key) return;
        localStorage.setItem(LS.key, key);
        localStorage.setItem(LS.baseURL, DEFAULT_BASE_URL);
        setApiKey(key);
        setBaseURL(DEFAULT_BASE_URL);
        setShowSettings(false);
        setOpen(true);
        // Coming back from an OAuth redirect is an unambiguous "I chose the
        // assistant" — land in chat rather than the menu they left from.
        setView('chat');
        localStorage.setItem(LS.menuSeen, '1');
        setChat(prev => [...prev, { kind: 'tool', text: 'connected to OpenRouter — you’re all set' }]);
      })
      .catch(err => {
        setOpen(true);
        setAuthError(`Connect failed: ${err?.message ?? err} Try again, or paste a key manually.`);
      });
    // convRef is a stable ref prop — listed to satisfy the lint, never changes
  }, [convRef]);

  useEffect(() => {
    // OpenRouter's catalog is public — fetch even before a key exists so the
    // model suggestions render during first-time setup
    if (open) fetchModels(baseURL, apiKey).then(setModels);
  }, [apiKey, baseURL, open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [chat]);

  useEffect(() => {
    wtScrollRef.current?.scrollTo({ top: wtScrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [wtLog]);

  // Drop the held pointer if the panel unmounts mid-step — it lives on <body>
  // and nothing else would ever clean it up.
  useEffect(() => () => { wtHighlight.current?.(); }, []);

  // --- drag & resize ---------------------------------------------------------
  const beginDrag = (mode: 'move' | 'w' | 'h' | 'wh') => (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const start = layout;
    const container = panelRef.current?.parentElement;
    const cw = container?.clientWidth ?? window.innerWidth;
    const ch = container?.clientHeight ?? window.innerHeight;
    let latest = start;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      const next = { ...start };
      if (mode === 'move') {
        next.right = Math.min(Math.max(start.right - dx, 8), Math.max(8, cw - start.w - 8));
      }
      if (mode === 'w' || mode === 'wh') {
        const maxW = dock === 'right' ? Math.max(MIN_W, cw * 0.75) : Math.min(MAX_W, cw - start.right - 8);
        next.w = Math.min(Math.max(start.w - dx, MIN_W), maxW);
      }
      if (mode === 'h' || mode === 'wh') {
        const maxH = dock === 'bottom' ? Math.max(200, ch * 0.8) : ch - 24;
        next.h = Math.min(Math.max(start.h - dy, dock === 'bottom' ? 200 : MIN_H), maxH);
      }
      latest = next;
      setLayout(next);
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      localStorage.setItem(LS.layout, JSON.stringify(latest));
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  const saveSettings = (key: string, mdl: string, url: string) => {
    localStorage.setItem(LS.key, key);
    localStorage.setItem(LS.model, mdl);
    localStorage.setItem(LS.baseURL, url);
    setApiKey(key); setModel(mdl); setBaseURL(url);
    greetRef.current = true; // the chat renders next; greet it once it does
  };

  const clearKey = () => {
    localStorage.removeItem(LS.key);
    setApiKey('');
    setChat([]);
    historyRef.current = [];
    onConversationChange?.();
  };

  const send = async (preset?: string) => {
    const text = (preset ?? input).trim();
    if (!text || busy || !apiKey) return;
    setInput('');
    if (composerRef.current) composerRef.current.style.height = 'auto';
    setChat(prev => [...prev, { kind: 'user', text }, { kind: 'assistant', text: '' }]);
    setBusy(true);
    // Paint the keystroke's frame (user bubble, cleared composer) BEFORE the
    // heavy start of the turn — building the system prompt scans every column
    // of the active table, which blocked the Enter press for ~500ms on large
    // datasets (the composer's INP flag on the preview deployment).
    await paintYield();
    const snapBefore = bridgeRef.current.snapshot();
    let mutated = false;
    try {
      historyRef.current = await runAssistantTurn(
        apiKey, baseURL, model, historyRef.current, text, bridgeRef,
        {
          onText: delta => setChat(prev => {
            const next = [...prev];
            // stream into the trailing assistant bubble, adding one after tool chips
            if (next[next.length - 1]?.kind !== 'assistant') next.push({ kind: 'assistant', text: '' });
            next[next.length - 1] = { kind: 'assistant', text: next[next.length - 1].text + delta };
            return next;
          }),
          onToolUse: (name, argsSummary) => {
            if (MUTATING_TOOLS.has(name)) mutated = true;
            setChat(prev => {
              const next = prev.filter((e, i) => !(i === prev.length - 1 && e.kind === 'assistant' && e.text === ''));
              const label = argsSummary ? `${name.replaceAll('_', ' ')} · ${argsSummary}` : name.replaceAll('_', ' ');
              return [...next, { kind: 'tool', text: label }];
            });
          },
        },
      );
    } catch (err) {
      setChat(prev => [...prev, { kind: 'error', text: describeApiError(err) }]);
    } finally {
      // drop an empty trailing assistant bubble if the turn ended on a tool/error
      setChat(prev => prev.filter((e, i) => !(i === prev.length - 1 && e.kind === 'assistant' && e.text === '')));
      setUndoSnap(mutated ? snapBefore : null);
      setBusy(false);
      onConversationChange?.();
    }
  };

  // The user message and tool calls belonging to the assistant message at idx
  const turnContext = (idx: number) => {
    let userMsg: string | null = null;
    const tools: string[] = [];
    for (let i = idx - 1; i >= 0; i--) {
      const e = chat[i];
      if (e.kind === 'user') { userMsg = e.text; break; }
      if (e.kind === 'tool') tools.unshift(e.text.split(' · ')[0]);
    }
    return { userMsg, tools };
  };

  const rate = (idx: number, rating: 'up' | 'down') => {
    if (fb[idx]) return;
    const eventId = crypto.randomUUID();
    const { tools } = turnContext(idx);
    // Instant row carries metadata only — conversation text goes with the
    // optional "why" step, where the user can see and exclude it
    void submitFeedback({ event_id: eventId, rating, model, tools });
    setFb(prev => ({ ...prev, [idx]: { rating, eventId, askWhy: true, done: false } }));
  };

  const sendReason = (idx: number, reason: string, includeExchange: boolean) => {
    const f = fb[idx];
    if (!f) return;
    const { userMsg, tools } = turnContext(idx);
    void submitFeedback({
      event_id: f.eventId,
      rating: f.rating,
      reason: reason.trim() || null,
      model,
      tools,
      user_message: includeExchange ? userMsg : null,
      assistant_message: includeExchange ? chat[idx]?.text ?? null : null,
    });
    setFb(prev => ({ ...prev, [idx]: { ...f, askWhy: false, done: true } }));
  };

  const undo = () => {
    if (!undoSnap) return;
    bridgeRef.current.restore(undoSnap);
    setUndoSnap(null);
    setChat(prev => [...prev, { kind: 'tool', text: 'reverted the assistant’s changes' }]);
    onConversationChange?.();
  };

  // --- the walkthrough runner -----------------------------------------------

  const dropHighlight = () => { wtHighlight.current?.(); wtHighlight.current = null; };

  const enterStep = async (id: string) => {
    const step = walkthroughStep(id);
    if (!step) return;
    dropHighlight();
    setWtStepId(id);
    setWtBusy(true);
    // Let the click's own frame paint (pressed button, busy state) BEFORE the
    // step's actions run. Without this, loading the demo or running a PCA
    // executes in the same task as the click and blocks that first paint —
    // a ~200ms INP on the "Begin" button, measured on the Vercel preview.
    await paintYield();
    const notes: ChatEntry[] = [];
    for (const action of step.run ?? []) {
      try {
        // bridgeRef.current per action, and a paint yield after it: the bridge
        // closes over the page's state and is rebuilt on every commit, so a
        // second call against a stale one runs against pre-commit state.
        notes.push({ kind: 'tool', text: await action(bridgeRef.current) });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        notes.push({ kind: 'error', text: `That step didn’t complete: ${msg}` });
      }
      await paintYield();
    }
    setWtLog(prev => [...prev, ...notes, { kind: 'assistant', text: step.say, local: true }]);
    setWtBusy(false);
    // After the step's own effects have painted: the section being pointed at
    // may not have existed until this step loaded the data that reveals it.
    if (step.highlight) {
      await paintYield();
      // Anchored steps bring the coach bubble, whose tail is the pointer —
      // the ring's own arrow would be a second one aimed at the same spot.
      wtHighlight.current = bridgeRef.current.holdHighlight(step.highlight, { arrow: !stepAnchorsChoice(step) });
    }
  };

  const launchWalkthrough = async () => {
    setStartDialog(false);
    localStorage.setItem(LS.menuSeen, '1');
    // Snapshotted before anything moves, and offered back on the way out. The
    // walkthrough is the one place in the panel that mutates the workbench
    // without being asked turn by turn.
    wtSnap.current = bridgeRef.current.snapshot();
    setWtUndo(null);
    setWtLog([]);
    setView('walkthrough');
    onWalkthroughChange?.(true);
    await enterStep(FIRST_STEP);
  };

  const beginWalkthrough = () => {
    // Loading Iris over someone's own data is the one destructive path here, so
    // it asks first — and offers the save inline, since "go save your work"
    // that costs you the dialog is advice nobody takes.
    if (bridgeRef.current.getState().datasets.length > 0) setStartDialog(true);
    else void launchWalkthrough();
  };

  const greet = () => {
    setChat(prev => {
      if (prev.length > 0) return prev;
      const text = assistantGreeting(bridgeRef.current.getState());
      // Also into the wire history, so a "yes please" to the greeting's offer
      // reaches a model that knows what it offered.
      historyRef.current = [{ role: 'assistant', content: text }];
      return [{ kind: 'assistant', text, local: true }];
    });
  };

  useEffect(() => {
    if (!apiKey || !greetRef.current) return;
    greetRef.current = false;
    greet();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  const endWalkthrough = (to: 'assistant' | 'exit') => {
    dropHighlight();
    onWalkthroughChange?.(false);
    localStorage.setItem(LS.menuSeen, '1');
    // Only offer the revert if there was something of theirs to revert to.
    const snap = wtSnap.current as { datasets?: unknown[] } | null;
    setWtUndo(snap?.datasets?.length ? snap : null);
    wtSnap.current = null;
    if (to === 'assistant') {
      setView('chat');
      if (apiKey) greet();
    } else {
      // "The live workspace" means the workspace, not another panel screen.
      setView('chat');
      setOpen(false);
    }
  };

  const startAssistant = () => {
    localStorage.setItem(LS.menuSeen, '1');
    setView('chat');
    if (apiKey) greet();
  };

  const undoWalkthrough = () => {
    if (!wtUndo) return;
    bridgeRef.current.restore(wtUndo);
    setWtUndo(null);
    setChat(prev => [...prev, { kind: 'tool', text: 'restored the workspace you had before the walkthrough' }]);
  };

  // Let the page quit the walkthrough from beside the controls it disables
  if (exitWalkthroughRef) exitWalkthroughRef.current = () => endWalkthrough('exit');
  // …and start it from the empty state's "Load demo"
  if (startWalkthroughRef) startWalkthroughRef.current = () => {
    setOpen(true);
    setShowSettings(false);
    beginWalkthrough();
  };

  // Allow the rest of the app to open the panel with a prefilled question
  if (askRef) askRef.current = (q: string) => {
    if (view === 'walkthrough') endWalkthrough('assistant');
    setOpen(true);
    setView('chat');
    if (!apiKey) {
      // send() drops text without a key; keep the question waiting in the
      // composer and open setup so it survives connecting a key.
      setInput(q);
      setShowSettings(true);
      return;
    }
    setShowSettings(false);
    send(q);
  };
  // ...and to read/replace the conversation (session autosave, workspace load).
  // Reassigned every render so `get` sees the current transcript.
  if (convRef) {
    convRef.current.handle = {
      get: () => ({ entries: chat, history: historyRef.current }),
      set: applyConversation,
    };
  }

  const primary = theme === 'primary';
  const panelCls = primary
    ? 'bg-white border-[3px] border-[#111111] shadow-[6px_6px_0px_#111111]'
    : 'bg-black/85 border border-[var(--system-green)]/50';
  const headerCls = primary
    ? 'bg-[#111111] text-white'
    : 'bg-transparent text-[var(--system-green)] border-b border-[var(--system-green)]/30';
  const inputCls = primary
    ? 'bg-white border border-[#111111] text-[#111111]'
    : 'bg-[var(--input)] border border-[var(--border)] text-[var(--foreground)]';

  if (!open) {
    // Filled red on both themes. Terminal's --primary is its red; the
    // outlined-green version this replaces read as one more piece of panel
    // chrome rather than the way in to the assistant.
    return (
      <button
        // startTransition: mounting the whole panel (dynamic chunks, markdown
        // pipeline) in the click's own task blocked the pressed-state frame
        // for ~300ms — the launcher's INP flag on the preview deployment.
        onClick={() => startTransition(() => setOpen(true))}
        title="Open the assistant"
        className={`absolute bottom-4 z-40 flex items-center gap-2 px-3 py-2 text-xs font-bold uppercase tracking-wider cursor-pointer transition-all duration-150 ${primary
          ? 'bauhaus-btn bg-[var(--p-red)] text-white'
          : 'bg-[var(--primary)] border border-[var(--primary)] text-white hover:brightness-110'}`}
        style={{ right: layout.right }}
      >
        <Sparkles className="w-4 h-4" /> Assistant
      </button>
    );
  }

  const settingsMode = view === 'chat' && (!apiKey || showSettings);
  // The menu sizes to its content; a transcript needs the full panel height.
  const chatMode = view === 'walkthrough' || (view === 'chat' && !settingsMode);

  const rootProps = dock === 'float'
    ? {
        className: `absolute bottom-4 z-40 flex flex-col ${panelCls}`,
        style: {
          width: layout.w,
          right: layout.right,
          ...(chatMode ? { height: layout.h } : {}),
          maxHeight: 'calc(100% - 2rem)',
        } as React.CSSProperties,
      }
    : dock === 'right'
      ? {
          className: `relative z-40 flex flex-col flex-shrink-0 h-full min-h-0 ${panelCls}`,
          style: { width: layout.w } as React.CSSProperties,
        }
      : {
          className: `relative z-40 flex flex-col flex-shrink-0 w-full min-h-0 ${panelCls}`,
          style: { height: layout.h } as React.CSSProperties,
        };

  return (
    <div ref={panelRef} {...rootProps}>
      {/* resize handles per dock mode */}
      {(dock === 'float' || dock === 'right') && (
        <div onPointerDown={beginDrag('w')} className="absolute -left-1 top-0 bottom-0 w-2 cursor-ew-resize z-20" title="Drag to resize" />
      )}
      {(dock === 'float' || dock === 'bottom') && (
        <div onPointerDown={beginDrag('h')} className="absolute top-[-4px] left-0 right-0 h-2 cursor-ns-resize z-20" title="Drag to resize" />
      )}
      {dock === 'float' && (
        <div onPointerDown={beginDrag('wh')} className="absolute -left-1.5 top-[-6px] w-5 h-5 cursor-nwse-resize z-30" title="Drag to resize" />
      )}

      {/* header — in float mode, drag to slide the panel along the bottom */}
      <div
        onPointerDown={dock === 'float' ? beginDrag('move') : undefined}
        className={`flex items-center justify-between px-3 py-1 flex-shrink-0 select-none ${dock === 'float' ? 'cursor-grab active:cursor-grabbing' : ''} ${headerCls}`}
        title={dock === 'float' ? 'Drag to move' : undefined}
      >
        <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest">
          {view === 'walkthrough'
            ? <><Compass className="w-3.5 h-3.5" /> Walkthrough</>
            : <><Sparkles className="w-3.5 h-3.5" /> Assistant</>}
          {view !== 'walkthrough' && (
            // Session-level data access at a glance: just the icon. 'mixed'
            // runs private (the minimum of the loaded datasets' modes) and the
            // title says why. Clicking opens the access-info dialog for the
            // active dataset — modes themselves are locked at upload.
            <button
              onClick={onAccessClick}
              disabled={!onAccessClick}
              className={`p-0.5 border border-current/30 opacity-70 ${onAccessClick ? 'hover:opacity-100 cursor-pointer' : 'cursor-default'}`}
              aria-label={accessMode === 'open' ? 'Full data access — click for details' : 'Aggregates only — click for details'}
              title={(accessMode === 'open'
                ? 'Full data access: every loaded dataset is marked public/open, so the assistant may read raw rows.'
                : accessMode === 'mixed'
                  ? 'Aggregates only: some datasets are open, but at least one is private, so the whole conversation runs at the private level.'
                  : 'Aggregates only: the assistant sees column summaries, never raw rows.')
                + (onAccessClick ? ' Click for details — modes are set when a dataset is added.' : '')}
            >
              {accessMode === 'open' ? <Globe className="w-3 h-3" /> : <Lock className="w-3 h-3" />}
            </button>
          )}
        </span>
        <span className="flex items-center gap-1" onPointerDown={e => e.stopPropagation()}>
          {/* The menu stops being the front door after the first visit, so it
              needs a way back — otherwise the walkthrough is unreachable to
              anyone who picked the assistant once. */}
          {view !== 'menu' && (
            <button
              onClick={() => { if (view === 'walkthrough') endWalkthrough('assistant'); setShowSettings(false); setView('menu'); }}
              title="Back to the menu"
              className="p-1 opacity-40 hover:opacity-80 cursor-pointer"
            >
              <LayoutList className="w-3.5 h-3.5" />
            </button>
          )}
          <span data-guide="assistant-dock" className="flex items-center">
            {([['right', PanelRight, 'Dock to the right'], ['bottom', PanelBottom, 'Dock to the bottom'], ['float', PictureInPicture2, 'Float (drag anywhere along the bottom)']] as const).map(([m, Icon, label]) => (
              <button
                key={m}
                onClick={() => onDockChange(m)}
                title={label}
                className={`p-1 cursor-pointer ${dock === m ? 'opacity-100' : 'opacity-40 hover:opacity-80'}`}
              >
                <Icon className="w-3.5 h-3.5" />
              </button>
            ))}
          </span>
          <span className="w-1" />
          {view !== 'walkthrough' && (
            <button onClick={() => { setView('chat'); setShowSettings(s => !s); }} title="Assistant settings" className="p-1 hover:opacity-60 cursor-pointer">
              <Settings2 className="w-4 h-4" />
            </button>
          )}
          <button onClick={() => setOpen(false)} title="Minimize — your conversation is kept" className="p-1 hover:opacity-60 cursor-pointer">
            <Minus className="w-4 h-4" />
          </button>
        </span>
      </div>

      {view === 'menu' ? (
        <PanelMenu primary={primary} hasKey={!!apiKey} onWalkthrough={beginWalkthrough} onAssistant={startAssistant} />
      ) : view === 'walkthrough' ? (
        <WalkthroughView
          primary={primary}
          log={wtLog}
          stepId={wtStepId}
          busy={wtBusy}
          scrollRef={wtScrollRef}
          onChoose={choice => {
            if (!choice.next) return endWalkthrough(choice.then ?? 'exit');
            // Echo the press as a user turn before the next beat arrives, so the
            // transcript reads as an exchange and each step has a visible start.
            setWtLog(prev => [...prev, { kind: 'user', text: choice.label }]);
            void enterStep(choice.next);
          }}
          onSkip={() => endWalkthrough('exit')}
        />
      ) : settingsMode ? (
        <SettingsForm
          primary={primary}
          inputCls={inputCls}
          apiKey={apiKey} model={model} baseURL={baseURL} models={models}
          authError={authError}
          onConnect={() => { setAuthError(''); startOpenRouterOAuth(); }}
          onSave={(k, m, u) => { saveSettings(k, m, u); setShowSettings(false); setAuthError(''); }}
          onClearKey={clearKey}
        />
      ) : (
        <>
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-2 min-h-[120px]">
            {chat.length === 0 && (
              <div className="space-y-2 pt-1">
                <p className="text-[11px] opacity-50 leading-snug">
                  Ask about your variables, or tell me what to show — e.g. “plot PC1 vs PC2 colored
                  by Orientation”, “cluster this with k=4 and tell me what the clusters look like”.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {['Give me a tour', 'What can you do?', 'Suggest what to explore'].map(sugg => (
                    <button
                      key={sugg}
                      onClick={() => send(sugg)}
                      className={`px-2 py-1 text-[10px] cursor-pointer ${primary
                        ? 'border border-[#111111] hover:bg-[var(--p-yellow)]'
                        : 'border border-[var(--system-green)]/40 text-[var(--system-green)] hover:bg-[var(--system-green)]/10'}`}
                    >
                      {sugg}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {chat.map((e, i) => (
              e.kind === 'tool' ? (
                <div key={i} className={`text-[10px] uppercase tracking-wider ${primary ? 'text-[var(--p-blue)]' : 'text-[var(--system-green)]/70'}`}>
                  ▸ {e.text}
                </div>
              ) : (
                <div key={i} className={`text-xs leading-relaxed ${e.kind === 'assistant' ? '' : 'whitespace-pre-wrap'} ${e.kind === 'user'
                  ? (primary ? 'font-bold' : 'text-[var(--system-green)]')
                  : e.kind === 'error' ? 'text-red-500' : ''}`}>
                  {e.kind === 'user' && <span className="opacity-50">&gt; </span>}
                  {e.kind === 'assistant'
                    ? <AssistantMarkdown text={e.text} />
                    : e.text}
                  {busy && i === chat.length - 1 && e.kind === 'assistant' && <span className="animate-pulse">▌</span>}
                  {feedbackEnabled() && e.kind === 'assistant' && e.text && !e.local && !(busy && i === chat.length - 1) && (
                    <FeedbackControls
                      primary={primary}
                      state={fb[i]}
                      onRate={r => rate(i, r)}
                      onReason={(reason, include) => sendReason(i, reason, include)}
                      onDismiss={() => setFb(prev => ({ ...prev, [i]: { ...prev[i], askWhy: false } }))}
                    />
                  )}
                </div>
              )
            ))}
          </div>
          <div className="px-3 pb-2 pt-1 flex-shrink-0 space-y-1.5">
            {wtUndo != null && !busy && (
              <button
                onClick={undoWalkthrough}
                title="Put back the datasets, axes and pins you had before the walkthrough ran"
                className={`w-full py-1 text-[10px] font-bold uppercase tracking-wider cursor-pointer ${primary
                  ? 'border-2 border-[#111111] hover:bg-[var(--p-yellow)]'
                  : 'border border-[var(--system-green)]/40 text-[var(--system-green)] hover:bg-[var(--system-green)]/10'}`}
              >
                ↩ Restore my pre-walkthrough workspace
              </button>
            )}
            {undoSnap != null && !busy && (
              <button
                onClick={undo}
                className={`w-full py-1 text-[10px] font-bold uppercase tracking-wider cursor-pointer ${primary
                  ? 'border-2 border-[#111111] hover:bg-[var(--p-yellow)]'
                  : 'border border-[var(--system-green)]/40 text-[var(--system-green)] hover:bg-[var(--system-green)]/10'}`}
              >
                ↩ Undo assistant changes
              </button>
            )}
            <div className="flex gap-1.5 items-end">
              <textarea
                ref={composerRef}
                rows={1}
                value={input}
                onChange={e => {
                  setInput(e.target.value);
                  // auto-grow up to ~5 lines, then scroll
                  e.target.style.height = 'auto';
                  e.target.style.height = Math.min(e.target.scrollHeight, 110) + 'px';
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
                }}
                aria-label="Message the assistant"
                placeholder={busy ? 'Working…' : 'Ask or instruct…'}
                title="Enter sends · Shift+Enter for a new line"
                disabled={busy}
                className={`flex-1 min-w-0 px-2 py-1.5 text-xs outline-none resize-none leading-snug overflow-y-auto ${inputCls}`}
              />
              <button
                onClick={() => send()}
                disabled={busy || !input.trim()}
                title="Send"
                className={`px-2.5 py-1.5 disabled:opacity-30 cursor-pointer ${primary ? 'bauhaus-btn bg-[var(--p-blue)] text-white' : 'border border-[var(--system-green)]/60 text-[var(--system-green)] hover:bg-[var(--system-green)]/10'}`}
              >
                <CornerDownLeft className="w-3.5 h-3.5" />
              </button>
            </div>
            <p className="text-[9px] leading-snug opacity-40">
              Sends column names &amp; summary stats to {baseURL.includes('openrouter') ? 'OpenRouter' : 'your API endpoint'} — never raw data rows.
            </p>
          </div>
        </>
      )}

      {startDialog && <WalkthroughStartDialog
        theme={theme}
        datasetNames={bridgeRef.current.getState().datasets.map(d => d.name)}
        onSaveWorkspace={name => bridgeRef.current.saveWorkspaceAs(name)}
        onStart={() => void launchWalkthrough()}
        onCancel={() => setStartDialog(false)}
      />}
    </div>
  );
};

// The front door: two ways in, and the one that costs nothing comes first.
//
// Before this, a visitor without an API key met the settings form and nothing
// else — the app asked for a credential before showing what it was for. The
// walkthrough needs no key, no account and no network, so it leads.
const PanelMenu = ({ primary, hasKey, onWalkthrough, onAssistant }: {
  primary: boolean,
  hasKey: boolean,
  onWalkthrough: () => void,
  onAssistant: () => void,
}) => {
  const card = primary
    ? 'border-2 border-[#111111] hover:bg-[var(--p-yellow)]'
    : 'border border-[var(--system-green)]/40 text-[var(--system-green)] hover:bg-[var(--system-green)]/10';
  return (
    <div className="px-3 py-3 space-y-2.5 overflow-y-auto">
      <p className="text-[11px] leading-snug opacity-60">
        Two ways in — take the tour, or drive the workbench by asking.
      </p>
      <button onClick={onWalkthrough} className={`w-full p-3 text-left cursor-pointer ${card}`}>
        <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider">
          <Compass className="w-3.5 h-3.5" /> Guided walkthrough
        </span>
        <span className="block mt-1 text-[10px] leading-snug opacity-70">
          {WALKTHROUGH_STEPS} steps on the built-in Iris demo. Click through at your own pace —
          no API key, nothing leaves your browser.
        </span>
      </button>
      <button onClick={onAssistant} className={`w-full p-3 text-left cursor-pointer ${card}`}>
        <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider">
          <Sparkles className="w-3.5 h-3.5" /> {hasKey ? 'Start the assistant' : 'Set up the assistant'}
        </span>
        <span className="block mt-1 text-[10px] leading-snug opacity-70">
          {hasKey
            ? 'Ask questions about your data, or tell it what to plot, cluster and export.'
            : 'Connect an API key of your own, then ask questions and give instructions in plain language.'}
        </span>
      </button>
    </div>
  );
};

// The walkthrough transcript: the same bubbles and "▸" tool chips the chat uses,
// driven by buttons instead of typing.
// The coach-mark bubble for sidebar-pointing steps (stepAnchorsChoice): ONE
// floating callout carrying the step's title, prose, and advance button, with
// a tail pointing at the highlighted control — so reading, looking, and
// acting all happen at the thing being taught, instead of text on the right,
// ring on the left, and a lone button in between. Portal to body, fixed
// position, tracking the anchor's rect on the highlight ring's 100ms cadence;
// renders nothing while the anchor is off screen.
const CALLOUT_W = 300;
const AnchoredCallout = ({ target, title, say, label, disabled, primary, onClick }: {
  target: string,
  title: string,
  say: string,
  label: string,
  disabled: boolean,
  primary: boolean,
  onClick: () => void,
}) => {
  const [pos, setPos] = useState<{ left: number; top: number; tailTop: number } | null>(null);
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const place = () => {
      const el = document.querySelector(`[data-guide="${target}"]`);
      if (!el) return setPos(null);
      const r = el.getBoundingClientRect();
      // Beside the ring (12px pad + tail), vertically centered on the target,
      // clamped into the viewport; the tail keeps aiming at the target's
      // center even when the card had to slide to stay on screen.
      const M = 8;
      const h = card.current?.offsetHeight ?? 200;
      const left = Math.min(Math.round(r.right + 28), window.innerWidth - CALLOUT_W - M);
      const top = Math.max(M, Math.min(Math.round(r.top + r.height / 2 - h / 2), window.innerHeight - h - M));
      const tailTop = Math.max(10, Math.min(Math.round(r.top + r.height / 2 - top - 8), h - 26));
      setPos(prev => {
        const next = { left, top, tailTop };
        return prev && prev.left === next.left && prev.top === next.top && prev.tailTop === next.tailTop ? prev : next;
      });
    };
    place();
    const tracker = setInterval(place, 100);
    return () => clearInterval(tracker);
  }, [target]);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={card}
      role="dialog"
      aria-label={title}
      style={{
        position: 'fixed', left: pos?.left ?? -9999, top: pos?.top ?? -9999,
        width: CALLOUT_W, zIndex: 96,
        ['--wt-glow' as string]: primary ? 'rgba(255, 214, 0, 0.5)' : 'rgba(16, 255, 80, 0.4)',
      }}
      className={`wt-anchored-glow p-3 text-xs leading-relaxed ${primary
        ? 'bg-white border-[3px] border-[#111111] text-[#111111]'
        : 'bg-black border border-[var(--system-green)]/60 text-[var(--foreground)]'}`}
    >
      {/* The tail replaces the ring's bouncing arrow for these steps. */}
      <span
        aria-hidden
        style={{ position: 'absolute', left: -10, top: pos?.tailTop ?? 10, width: 0, height: 0,
          borderTop: '8px solid transparent', borderBottom: '8px solid transparent',
          borderRight: primary ? '10px solid #111111' : '10px solid var(--system-green)' }}
      />
      <div className={`text-[10px] uppercase tracking-widest font-bold mb-1.5 ${primary ? 'text-[var(--p-red)]' : 'text-[var(--system-green)]'}`}>
        {title}
      </div>
      <AssistantMarkdown text={say} />
      <button
        onClick={onClick}
        disabled={disabled}
        className={`mt-2.5 w-full py-2 px-3 text-[11px] font-bold disabled:opacity-30 cursor-pointer ${primary
          ? 'bauhaus-btn bg-[var(--p-yellow)] text-[#111111]'
          : 'border border-[var(--system-green)]/60 bg-black text-[var(--system-green)] hover:bg-[var(--system-green)]/10'}`}
      >
        Next: {label}
      </button>
    </div>,
    document.body,
  );
};

const WalkthroughView = ({ primary, log, stepId, busy, scrollRef, onChoose, onSkip }: {
  primary: boolean,
  log: ChatEntry[],
  stepId: string,
  busy: boolean,
  scrollRef: React.RefObject<HTMLDivElement | null>,
  onChoose: (choice: { label: string; next: string | null; then?: 'assistant' | 'exit' }) => void,
  onSkip: () => void,
}) => {
  const index = walkthroughIndex(stepId);
  const step = walkthroughStep(stepId);
  const anchored = !!step && stepAnchorsChoice(step);
  const accent = primary ? 'var(--p-red)' : 'var(--system-green)';

  return (
    <>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-2 min-h-[120px]">
        {/* The button you pressed is echoed as your turn, and rules off the beat
            above it. Without the break the whole tour ran together as one wall
            of text with no seam between one step and the next. */}
        {log.map((e, i) => (
          // The CURRENT anchored step's prose lives in its bubble, not here —
          // rendering it twice is the split-attention problem again. It joins
          // the transcript as history once the step advances.
          anchored && !busy && i === log.length - 1 && e.kind === 'assistant' && e.text === step?.say ? null :
          e.kind === 'user' ? (
            <div
              key={i}
              className={`pt-2.5 mt-2.5 text-xs ${primary
                ? 'border-t border-[#111111]/15 font-bold'
                : 'border-t border-[var(--system-green)]/20 text-[var(--system-green)]'}`}
            >
              <span className="opacity-50">&gt; </span>{e.text}
            </div>
          ) : e.kind === 'tool' ? (
            <div key={i} className={`text-[10px] uppercase tracking-wider ${primary ? 'text-[var(--p-blue)]' : 'text-[var(--system-green)]/70'}`}>
              ▸ {e.text}
            </div>
          ) : (
            <div key={i} className={`text-xs leading-relaxed ${e.kind === 'error' ? 'text-red-500 whitespace-pre-wrap' : ''}`}>
              {e.kind === 'error' ? e.text : <AssistantMarkdown text={e.text} />}
            </div>
          )
        ))}
        {busy && <div className="text-xs opacity-50"><span className="animate-pulse">▌</span></div>}

        {/* Where you are and what is left. An in-app tour of unknown length is
            the one people abandon, so the whole shape of it is on screen. */}
        {!busy && (
          <div className={`mt-3 pt-2 space-y-1 ${primary ? 'border-t border-[#111111]/20' : 'border-t border-[var(--system-green)]/20'}`}>
            <div className="text-[9px] uppercase tracking-widest opacity-40">
              Step {index + 1} of {WALKTHROUGH_STEPS}
            </div>
            {WALKTHROUGH.map((s, i) => (
              <div
                key={s.id}
                className={`flex items-center gap-1.5 text-[10px] ${i < index ? 'opacity-35' : i === index ? 'font-bold' : 'opacity-80'}`}
                style={i === index ? { color: accent } : undefined}
                aria-current={i === index ? 'step' : undefined}
              >
                <span className="w-3 flex-shrink-0 text-center">{i < index ? '✓' : i === index ? '▸' : '·'}</span>
                <span className={i < index ? 'line-through' : ''}>{s.title}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="px-3 pb-2 pt-1 flex-shrink-0 space-y-1.5">
        {/* Buttons sit ABOVE the composer: they are how you move, and the
            composer below them is visibly not. */}
        <div className="space-y-1.5">
          {anchored && step?.highlight ? (
            // This step's text AND way forward live in the bubble beside the
            // highlighted control — the panel keeps the timeline and history.
            <>
              {!busy && (
                <AnchoredCallout
                  target={step.highlight}
                  title={step.title}
                  say={step.say}
                  label={step.choices[0].label}
                  disabled={busy}
                  primary={primary}
                  onClick={() => onChoose(step.choices[0])}
                />
              )}
              <div className="text-[10px] opacity-60 py-1.5 px-2">
                ▸ Follow the bubble next to the highlighted area in the sidebar.
              </div>
            </>
          ) : (step?.choices ?? []).map(choice => (
            <button
              key={choice.label}
              onClick={() => onChoose(choice)}
              disabled={busy}
              className={`w-full py-1.5 px-2 text-[11px] font-bold text-left disabled:opacity-30 cursor-pointer ${primary
                ? 'bauhaus-btn bg-[var(--p-blue)] text-white'
                : 'border border-[var(--system-green)]/60 text-[var(--system-green)] hover:bg-[var(--system-green)]/10'}`}
            >
              {choice.next ? `Next: ${choice.label}` : choice.label}
            </button>
          ))}
        </div>

        {/* The way out lives on the end of the dead composer rather than as a
            link under it: that row is where the eye already goes when typing
            turns out not to work. */}
        <div className="flex gap-1.5 items-stretch">
          {/* An input, not a textarea: a textarea wraps its placeholder and then
              clips the second line against the one-row height. Nothing is being
              typed here anyway. */}
          <input
            type="text"
            disabled
            value=""
            readOnly
            aria-label="Typing is disabled during the walkthrough"
            placeholder="Use buttons above for walkthrough"
            // A notch smaller than the live composer so the whole sentence fits
            // beside the Exit button at the panel's minimum width.
            className={`flex-1 min-w-0 px-2 py-1.5 text-[10px] outline-none leading-snug cursor-not-allowed opacity-50 ${primary
              ? 'bg-black/[0.06] border border-[#111111]/30 text-[#111111]'
              : 'bg-[var(--input)] border border-[var(--border)] text-[var(--foreground)]'}`}
          />
          <button
            onClick={onSkip}
            title="Leave the walkthrough and use the workbench yourself"
            className={`flex-shrink-0 px-2 text-[10px] font-bold uppercase tracking-wider cursor-pointer ${primary
              ? 'border-2 border-[#111111] hover:bg-[var(--p-yellow)]'
              : 'border border-[var(--system-green)]/50 text-[var(--system-green)] hover:bg-[var(--system-green)]/10'}`}
          >
            Exit demo
          </button>
        </div>
      </div>
    </>
  );
};

// Small ⓘ with the long-form explanation as a native tooltip
const SettingsForm = ({ primary, inputCls, apiKey, model, baseURL, models, authError, onConnect, onSave, onClearKey }: {
  primary: boolean, inputCls: string,
  apiKey: string, model: string, baseURL: string, models: ModelInfo[],
  authError: string,
  onConnect: () => void,
  onSave: (key: string, model: string, baseURL: string) => void,
  onClearKey: () => void,
}) => {
  const [key, setKey] = useState(apiKey);
  const [mdl, setMdl] = useState(model);
  const [url, setUrl] = useState(baseURL);
  const [modelError, setModelError] = useState('');
  const labelCls = 'text-[10px] font-bold uppercase tracking-wider opacity-60';
  const ids = models.map(m => m.id);
  const suggested = suggestModels(models);

  const trySave = () => {
    if (!key.trim() || !mdl.trim() || !url.trim()) return;
    // The catalog is already filtered to tool-capable models; a typed model
    // outside it cannot drive the app. Endpoints without a catalog (local
    // runtimes) skip this check.
    if (ids.length && !ids.includes(mdl.trim())) {
      setModelError(`"${mdl.trim()}" doesn't support tool calling on this endpoint, so it can't drive the app. Pick a suggested model or one from the list.`);
      return;
    }
    setModelError('');
    onSave(key.trim(), mdl.trim(), url.trim().replace(/\/$/, ''));
  };

  return (
    <div className="px-3 py-3 space-y-2.5 overflow-y-auto">
      {!apiKey && (
        <p className="text-[11px] leading-snug opacity-80">
          <strong>Your key, stored only in this browser.</strong>
          <InfoTip text="One OpenRouter account covers Claude, GPT, Gemini, and more. The key never appears in exported workspaces and is only ever sent to the API endpoint you configure below." />
        </p>
      )}
      {authError && <p className="text-[11px] leading-snug text-red-500">{authError}</p>}
      <button
        onClick={onConnect}
        className={`w-full py-2 text-xs font-bold cursor-pointer ${primary
          ? 'bauhaus-btn bg-[var(--p-blue)] text-white'
          : 'border border-[var(--system-green)]/60 text-[var(--system-green)] hover:bg-[var(--system-green)]/10'}`}
      >
        {apiKey ? 'Reconnect OpenRouter' : 'Connect OpenRouter'}
      </button>
      <p className="text-[10px] opacity-50 leading-snug">
        <strong>One click</strong> — approve on openrouter.ai, done. Or paste a key below.
      </p>
      <div className="space-y-1">
        <div className={labelCls}>API key</div>
        <input type="password" value={key} onChange={e => setKey(e.target.value)}
          placeholder="sk-or-…" className={`w-full px-2 py-1.5 text-xs outline-none ${inputCls}`} />
      </div>
      <div className="space-y-1">
        <div className={labelCls}>
          Model
          <InfoTip text="Suggestions are the newest full-strength model per family. Only models that support tool calling are allowed — others can't drive the app." />
        </div>
        {suggested.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {suggested.map(id => (
              <button
                key={id}
                onClick={() => { setMdl(id); setModelError(''); }}
                title={id}
                className={`px-1.5 py-0.5 text-[9px] cursor-pointer ${mdl === id
                  ? (primary ? 'bg-[#111111] text-white border border-[#111111]' : 'bg-[var(--system-green)] text-black border border-[var(--system-green)]')
                  : (primary ? 'border border-[#111111]/40 hover:border-[#111111]' : 'border border-[var(--system-green)]/30 text-[var(--system-green)] hover:border-[var(--system-green)]')}`}
              >
                {id.split('/')[1] ?? id}
              </button>
            ))}
          </div>
        )}
        <input type="text" value={mdl} onChange={e => { setMdl(e.target.value); setModelError(''); }} list="assistant-models"
          placeholder="provider/model-id — type to search"
          className={`w-full px-2 py-1.5 text-xs outline-none ${inputCls}`} />
        <datalist id="assistant-models">
          {ids.map(id => <option key={id} value={id} />)}
        </datalist>
        {modelError && <p className="text-[10px] leading-snug text-red-500">{modelError}</p>}
      </div>
      <div className="space-y-1">
        <div className={labelCls}>
          Endpoint
          <InfoTip text="Any OpenAI-compatible endpoint works. Default is OpenRouter; point it at a local runtime (e.g. Ollama) for a fully offline assistant." />
        </div>
        <input type="text" value={url} onChange={e => setUrl(e.target.value)}
          className={`w-full px-2 py-1.5 text-xs outline-none ${inputCls}`} />
      </div>
      <div className="flex gap-2">
        <button
          onClick={trySave}
          disabled={!key.trim() || !mdl.trim() || !url.trim()}
          className={`flex-1 py-1.5 text-xs font-bold disabled:opacity-30 cursor-pointer ${primary
            ? 'bauhaus-btn bg-[var(--p-blue)] text-white'
            : 'border border-[var(--system-green)]/60 text-[var(--system-green)] hover:bg-[var(--system-green)]/10'}`}
        >
          Save
        </button>
        {apiKey && (
          <button onClick={onClearKey} className="px-3 py-1.5 text-xs underline-offset-2 hover:underline opacity-60 cursor-pointer">
            Remove key
          </button>
        )}
      </div>
    </div>
  );
};

const FeedbackControls = ({ primary, state, onRate, onReason, onDismiss }: {
  primary: boolean,
  state?: { rating: 'up' | 'down'; askWhy: boolean; done: boolean },
  onRate: (r: 'up' | 'down') => void,
  onReason: (reason: string, includeExchange: boolean) => void,
  onDismiss: () => void,
}) => {
  const [reason, setReason] = useState('');
  const [include, setInclude] = useState(true);
  const chosen = state?.rating;
  const whyRef = useRef<HTMLDivElement>(null);
  // the box appears below the fold when rating the last message — bring it into view
  useEffect(() => {
    if (state?.askWhy) whyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [state?.askWhy]);

  return (
    <div className="mt-1 select-none">
      <div className="flex justify-end gap-1.5">
        {(['up', 'down'] as const).map(r => {
          const Icon = r === 'up' ? ThumbsUp : ThumbsDown;
          const active = chosen === r;
          return (
            <button
              key={r}
              onClick={() => onRate(r)}
              disabled={!!chosen}
              title={chosen ? 'Feedback recorded' : r === 'up' ? 'Helpful' : 'Not helpful'}
              className={`p-0.5 transition-opacity cursor-pointer disabled:cursor-default ${active
                ? (primary ? 'text-[var(--p-blue)] opacity-100' : 'text-[var(--system-green)] opacity-100')
                : chosen ? 'opacity-15' : 'opacity-30 hover:opacity-80'}`}
            >
              <Icon className="w-3 h-3" />
            </button>
          );
        })}
        {state?.done && <span className="text-[9px] opacity-40 self-center">thanks ✓</span>}
      </div>
      {state?.askWhy && (
        <div ref={whyRef} className={`mt-1 p-2 space-y-1.5 text-[10px] ${primary ? 'border border-[#111111]/30 bg-black/[0.03]' : 'border border-[var(--system-green)]/25 bg-[var(--system-green)]/5'}`}>
          <div className="opacity-70">Mind saying why? (optional)</div>
          <textarea
            rows={2}
            value={reason}
            onChange={e => setReason(e.target.value)}
            className={`w-full px-1.5 py-1 text-[10px] outline-none resize-none ${primary ? 'bg-white border border-[#111111]/40' : 'bg-[var(--input)] border border-[var(--border)] text-[var(--foreground)]'}`}
            placeholder={chosen === 'up'
              ? 'e.g. did exactly what I meant, clear interpretation, good parameter pick…'
              : 'e.g. wrong column, k didn\u2019t match the data, explanation unclear…'}
          />
          <label className="flex items-start gap-1.5 cursor-pointer opacity-70">
            <input type="checkbox" checked={include} onChange={e => setInclude(e.target.checked)} className="mt-0.5" />
            <span>Include this exchange (your message + the reply — may contain column names/summaries) to help debugging</span>
          </label>
          <div className="flex gap-2 justify-end">
            <button onClick={onDismiss} className="underline-offset-2 hover:underline opacity-50 cursor-pointer">no thanks</button>
            <button
              onClick={() => onReason(reason, include)}
              className={`px-2 py-0.5 font-bold cursor-pointer ${primary ? 'bauhaus-btn bg-[var(--p-blue)] text-white' : 'border border-[var(--system-green)]/60 text-[var(--system-green)] hover:bg-[var(--system-green)]/10'}`}
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// Memoized (finding F10). The panel is not affected by the camera, so a
// rotation frame — or a slider tick, or a workspace-name keystroke — has no
// business re-rendering a ten-turn transcript. `bridgeRef` and `askRef` are refs
// and `onDockChange` is stable at the call site, so the props really do hold.
export const AssistantPanel = memo(AssistantPanelInner);
AssistantPanel.displayName = 'AssistantPanel';
