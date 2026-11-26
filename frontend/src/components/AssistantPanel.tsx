"use client";
import { useEffect, useEffectEvent, useImperativeHandle, useLayoutEffect, useRef, useState, memo, useMemo, startTransition } from 'react';
import { createPortal } from 'react-dom';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { ArrowLeft, Sparkles, Settings2, Minus, CornerDownLeft, ThumbsUp, ThumbsDown, PanelRight, PanelBottom, PictureInPicture2, Compass, LayoutList } from 'lucide-react';
import {
  AppBridge, DEFAULT_BASE_URL, DEFAULT_MODEL, MUTATING_TOOLS, ModelInfo,
  runAssistantTurn, fetchModels, suggestModels, describeApiError, paintYield,
} from '@/lib/assistant';
import {
  WALKTHROUGH, WALKTHROUGH_STEPS, FIRST_STEP, DEMO_ENTRY, type WalkthroughStep,
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
type TourEntry = ChatEntry & { summary?: string };
type TourChoice = WalkthroughStep['choices'][number];

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

const AssistantPanelInner = ({ bridgeRef, theme, askRef, convRef, onConversationChange, dock, onDockChange, onWalkthroughChange, exitWalkthroughRef, tourPlotScoresRef, demoRequest = 0, undoScopeKey = '[]' }: {
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
  tourPlotScoresRef?: React.MutableRefObject<(() => Promise<void>) | null>,
  exitWalkthroughRef?: React.MutableRefObject<(() => void) | null>,
  demoRequest?: number,
  undoScopeKey?: string,
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
  const [undoSnap, setUndoSnap] = useState<{ snapshot: unknown; scope: string } | null>(null);
  // OAuth failure to surface inside the settings view (chat may be hidden there)
  const [authError, setAuthError] = useState('');
  // Per-message feedback state, keyed by chat index
  const [fb, setFb] = useState<Record<number, { rating: 'up' | 'down'; eventId: string; askWhy: boolean; done: boolean }>>({});

  // --- walkthrough ----------------------------------------------------------
  const [view, setView] = useState<PanelView>('menu');
  const [wtStepId, setWtStepId] = useState<string>(FIRST_STEP);
  const [wtLog, setWtLog] = useState<TourEntry[]>([]);
  const handledDemoRequest = useRef(0);
  const preparedDataset = useRef<number | null>(null);
  const [wtBusy, setWtBusy] = useState(false);
  const [wtFailed, setWtFailed] = useState(false);
  const wtGeneration = useRef(0);
  const visits = useRef(new Map<string, { log: TourEntry[]; plot: ReturnType<AppBridge['captureTourPlot']> }>());
  const [startDialog, setStartDialog] = useState(false);
  // The held pointer ring, and the state to put back if the walkthrough ran
  // over someone's own workspace.
  const wtHighlight = useRef<(() => void) | null>(null);
  const wtSnap = useRef<unknown>(null);
  const [wtUndo, setWtUndo] = useState<unknown>(null);
  const wtScrollRef = useRef<HTMLDivElement>(null);
  const tourNext = useRef<HTMLButtonElement>(null);
  const panelToggle = useRef<HTMLButtonElement>(null);
  // Set when a key is saved from the settings form, so the chat that replaces it
  // opens with the same greeting the menu route gives.
  const greetRef = useRef(false);

  const entriesRef = useRef(chat);
  useLayoutEffect(() => { entriesRef.current = chat; }, [chat]);

  // Restore may finish while React is still rendering the lazy panel. Only a
  // committed instance can accept the conversation or answer an autosave.
  useLayoutEffect(() => {
    if (!convRef) return;
    const bridge = convRef.current;
    const handle: ConversationHandle = {
      get: () => ({ entries: entriesRef.current, history: historyRef.current }),
      set: conversation => {
        const entries = conversation?.entries ?? [];
        entriesRef.current = entries;
        historyRef.current = (conversation?.history ?? []) as ChatCompletionMessageParam[];
        setChat(entries);
        setFb({});
        setUndoSnap(null);
      },
    };
    bridge.handle = handle;
    if (bridge.pending !== undefined) {
      handle.set(bridge.pending);
      delete bridge.pending;
    }
    return () => {
      if (bridge.handle === handle) {
        bridge.pending = handle.get();
        bridge.handle = null;
      }
    };
  }, [convRef]);

  useEffect(() => {
    setApiKey(localStorage.getItem(LS.key) ?? '');
    // The menu is the front door exactly once. Landing a returning user back on
    // it every time would put a choice in front of them they already made, and
    // "remember the walkthrough" would re-run a demo they have seen.
    if (wtGeneration.current === 0) setView(localStorage.getItem(LS.menuSeen) === '1' ? 'chat' : 'menu');
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
  }, []);

  useEffect(() => {
    // OpenRouter's catalog is public — fetch even before a key exists so the
    // model suggestions render during first-time setup
    if (open && view !== 'walkthrough') fetchModels(baseURL, apiKey).then(setModels);
  }, [apiKey, baseURL, open, view]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [chat]);

  useEffect(() => {
    wtScrollRef.current?.scrollTo({ top: wtScrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [wtLog, open]);

  useEffect(() => {
    if (view === 'walkthrough' && !wtBusy && document.activeElement === document.body) {
      const next = tourNext.current;
      const target = next && (!open || panelRef.current?.contains(next)) ? next : panelToggle.current;
      target?.focus({ preventScroll: true });
    }
  }, [view, wtBusy, wtStepId, open]);

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
      setUndoSnap(mutated ? { snapshot: snapBefore, scope: undoScopeKey } : null);
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
    if (!undoSnap || undoSnap.scope !== undoScopeKey) return;
    bridgeRef.current.restore(undoSnap.snapshot);
    setUndoSnap(null);
    setChat(prev => [...prev, { kind: 'tool', text: 'reverted the assistant’s changes' }]);
    onConversationChange?.();
  };

  // --- the walkthrough runner -----------------------------------------------

  const dropHighlight = () => { wtHighlight.current?.(); wtHighlight.current = null; };

  const enterStep = async (id: string, choiceLabel?: string) => {
    const step = walkthroughStep(id);
    if (!step) return;
    // Capture the view as the reader leaves the latest step, including last-minute axis choices.
    const previous = visits.current.get(wtStepId);
    const latest = Array.from(visits.current.keys()).at(-1);
    if (previous && wtStepId === latest) previous.plot = bridgeRef.current.captureTourPlot();

    dropHighlight();
    const generation = ++wtGeneration.current;
    setWtFailed(false);
    setWtStepId(id);
    if (step !== DEMO_ENTRY) setOpen(!stepAnchorsChoice(step));
    setWtBusy(true);
    const saved = visits.current.get(id);
    const prior = id === DEMO_ENTRY.id ? [] : wtLog;
    const log: TourEntry[] = saved ? [...saved.log] : [...prior];
    if (!saved && choiceLabel) log.push({ kind: 'user', text: choiceLabel });
    setWtLog([...log]);
    await paintYield();
    if (generation !== wtGeneration.current) return;
    try {
      if (saved) {
        if (saved.plot) bridgeRef.current.showTourPlot(saved.plot, id !== latest);
      } else {
        for (const [summary, action] of step.run ?? []) {
          log.push({ kind: 'tool', summary, text: await action(bridgeRef.current) });
          await paintYield();
          if (generation !== wtGeneration.current) return;
        }
        if (step.say && !stepAnchorsChoice(step)) log.push({ kind: 'assistant', text: step.say, local: true });
        if (id !== DEMO_ENTRY.id) visits.current.set(id, { log, plot: bridgeRef.current.captureTourPlot() });
      }
    } catch (err: unknown) {
      if (generation !== wtGeneration.current) return;
      const message = err instanceof Error ? err.message : String(err);
      setWtLog([...log, { kind: 'error', text: `That step didn’t complete: ${message}` }]);
      setWtFailed(true);
      setOpen(true);
      setWtBusy(false);
      return;
    }
    setWtLog(log);
    setWtBusy(false);
    // After the step's own effects have painted: the section being pointed at
    // may not have existed until this step loaded the data that reveals it.
    if (step.highlight) {
      await paintYield();
      if (generation !== wtGeneration.current) return;
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
    visits.current.clear();
    wtSnap.current = bridgeRef.current.snapshot();
    setWtUndo(null);
    setWtLog([]);
    setView('walkthrough');
    preparedDataset.current = null;
    const generation = wtGeneration.current + 1;
    await enterStep(DEMO_ENTRY.id);
    if (generation !== wtGeneration.current) return;
    preparedDataset.current = (bridgeRef.current.snapshot() as { activeId: number | null }).activeId;
    setOpen(true);
  };

  const beginWalkthrough = () => {
    // Loading Iris over someone's own data is the one destructive path here, so
    // it asks first — and offers the save inline, since "go save your work"
    // that costs you the dialog is advice nobody takes.
    if (bridgeRef.current.getState().datasets.length > 0) {
      setOpen(true);
      setStartDialog(true);
    } else void launchWalkthrough();
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
    ++wtGeneration.current;
    dropHighlight();
    onWalkthroughChange?.(false);
    localStorage.setItem(LS.menuSeen, '1');
    // Only offer the revert if there was something of theirs to revert to.
    const snap = wtSnap.current as { datasets?: unknown[] } | null;
    setWtUndo(snap?.datasets?.length ? snap : null);
    wtSnap.current = null;
    visits.current.clear();
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
    const restored = bridgeRef.current.restore(wtUndo, 'walkthrough');
    setWtUndo(null);
    setChat(prev => [...prev, { kind: 'tool', text: restored === false ? 'Dataset locks changed. Your current workspace was kept.' : 'Restored your pre-walkthrough workspace.' }]);
  };

  // Let the page quit the walkthrough from beside the controls it disables
  const canAdvanceToScores = view === 'walkthrough' && wtStepId === 'efa' && !wtBusy;
  useImperativeHandle(canAdvanceToScores ? tourPlotScoresRef : null, () => () => enterStep('scores', 'Plot respondent scores'));
  useImperativeHandle(exitWalkthroughRef, () => () => endWalkthrough('exit'));
  const openRequestedDemo = useEffectEvent(() => {
    setShowSettings(false);
    beginWalkthrough();
  });
  useEffect(() => {
    if (handledDemoRequest.current === demoRequest) return;
    handledDemoRequest.current = demoRequest;
    openRequestedDemo();
  }, [demoRequest]);

  // Allow the rest of the app to open the panel with a prefilled question
  useImperativeHandle(askRef, () => (q: string) => {
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
  });

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

  const chooseStep = (choice: TourChoice) => {
    if (!choice.next) return endWalkthrough(choice.then ?? 'exit');
    if (wtStepId === DEMO_ENTRY.id) {
      if (choice.next === DEMO_ENTRY.id || preparedDataset.current !== (bridgeRef.current.snapshot() as { activeId: number | null }).activeId) {
        beginWalkthrough();
        return;
      }
      onWalkthroughChange?.(true);
      void enterStep(FIRST_STEP);
      return;
    }
    void enterStep(choice.next, choice.label);
  };

  const step = walkthroughStep(wtStepId);
  const previous = WALKTHROUGH[walkthroughIndex(wtStepId) - 1];
  const back = view === 'walkthrough' && !wtBusy && !wtFailed && previous && visits.current.has(previous.id)
    ? <PreviousStepButton previous={previous.title} primary={primary} onClick={() => void enterStep(previous.id)} />
    : undefined;
  const nextLabel = (choice: TourChoice) => choice.next && visits.current.has(choice.next)
    ? walkthroughStep(choice.next)?.title ?? choice.label : choice.label;
  const callout = view === 'walkthrough' && !wtBusy && !wtFailed && step?.highlight && stepAnchorsChoice(step)
    ? <AnchoredCallout nextStep={step.choices[0].next} target={step.highlight} title={step.title} say={step.say} label={nextLabel(step.choices[0])}
        back={back} primary={primary} nextRef={tourNext} onClick={() => chooseStep(step.choices[0])} />
    : null;

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

  const panel = open ? (
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
          <button ref={panelToggle} onClick={() => setOpen(false)} title="Minimize — your conversation is kept" className="p-1 hover:opacity-60 cursor-pointer">
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
          failed={wtFailed}
          scrollRef={wtScrollRef}
          onChoose={chooseStep} back={back} nextLabel={nextLabel} nextRef={tourNext}
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
                <div key={i} role={e.kind === 'error' ? 'alert' : undefined} className={`text-xs leading-relaxed ${e.kind === 'assistant' ? '' : 'whitespace-pre-wrap'} ${e.kind === 'user'
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
            {undoSnap != null && undoSnap.scope === undoScopeKey && !busy && (
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
              Sends chat and permitted summaries to {baseURL.includes('openrouter') ? 'OpenRouter' : 'your API endpoint'}.
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
  ) : (
    <button
      ref={panelToggle}
      onClick={() => startTransition(() => setOpen(true))}
      title={view === 'walkthrough' ? 'Open the walkthrough panel' : 'Open the assistant'}
      className={`absolute bottom-4 z-40 flex items-center gap-2 px-3 py-2 text-xs font-bold uppercase tracking-wider cursor-pointer transition-all duration-150 ${primary
        ? 'bauhaus-btn bg-[var(--p-red)] text-white'
        : 'bg-[var(--primary)] border border-[var(--primary)] text-white hover:brightness-110'}`}
      style={{ right: layout.right }}
    >
      {view === 'walkthrough' ? <><Compass className="w-4 h-4" /> Walkthrough</> : <><Sparkles className="w-4 h-4" /> Assistant</>}
    </button>
  );
  return <>{callout}{panel}</>;
};

// The front door: two ways in, and the one that costs nothing comes first.
//
// Before this, a visitor without an API key met the settings form and nothing
// else — the app asked for a credential before showing what it was for. The
// walkthrough needs no model key or account; it loads the demo from the app host.
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
          {WALKTHROUGH_STEPS} steps with Iris and a synthetic survey. Click through at your own pace —
          no API key or model calls; analysis runs in your browser.
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
const PreviousStepButton = ({ previous, primary, onClick }: { previous: string; primary: boolean; onClick: () => void }) => (
  <button type="button" onClick={onClick} aria-label={`Previous step: ${previous}`} title={`Back to ${previous}`}
    className={`flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-sm hover:bg-current/10 focus-visible:outline-2 ${primary ? 'text-[var(--p-red)]' : 'text-[var(--system-green)]'}`}>
    <ArrowLeft size={15} strokeWidth={2.25} aria-hidden="true" />
  </button>
);

const AnchoredCallout = ({ target, title, say, label, primary, back, nextRef, nextStep, onClick }: {
  nextStep: string | null,
  back?: React.ReactNode,
  target: string,
  title: string,
  say: string,
  label: string,
  nextRef: React.RefObject<HTMLButtonElement | null>,
  primary: boolean,
  onClick: () => void,
}) => {
  const [pos, setPos] = useState<{ left: number; top: number; tailTop: number } | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const scoreStep = target === 'factor-score-rows';
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
      data-walkthrough-target={target}
      role="dialog"
      aria-label={title}
      style={{
        position: 'fixed', left: pos?.left ?? -9999, top: pos?.top ?? -9999,
        width: CALLOUT_W, zIndex: 96,
        ['--wt-glow' as string]: primary ? 'rgba(255, 214, 0, 0.5)' : 'rgba(16, 255, 80, 0.4)',
      }}
      className={`${scoreStep ? '' : 'wt-anchored-glow'} p-3 text-xs leading-relaxed ${primary
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
      <div className={`flex items-center justify-between gap-2 text-[10px] uppercase tracking-widest font-bold mb-1.5 ${primary ? 'text-[var(--p-red)]' : 'text-[var(--system-green)]'}`}>
        {title}{back}
      </div>
      <AssistantMarkdown text={say} />
      <button
        onClick={onClick}
        ref={nextRef}
        data-next-step={nextStep}
        className={`${scoreStep ? 'wt-next-action' : ''} mt-2.5 w-full py-2 px-3 text-[11px] font-bold disabled:opacity-30 cursor-pointer ${primary
          ? 'bauhaus-btn bg-[var(--p-yellow)] text-[#111111]'
          : 'border border-[var(--system-green)]/60 bg-black text-[var(--system-green)] hover:bg-[var(--system-green)]/10'}`}
      >
        Next: {label}
      </button>
    </div>,
    document.body,
  );
};

const WalkthroughView = ({ primary, log, stepId, busy, failed, scrollRef, onChoose, onSkip, back, nextLabel, nextRef }: {
  back?: React.ReactNode,
  nextLabel: (choice: TourChoice) => string,
  nextRef: React.RefObject<HTMLButtonElement | null>,
  primary: boolean,
  log: TourEntry[],
  stepId: string,
  busy: boolean,
  failed: boolean,
  scrollRef: React.RefObject<HTMLDivElement | null>,
  onChoose: (choice: TourChoice) => void,
  onSkip: () => void,
}) => {
  const index = walkthroughIndex(stepId);
  const step = walkthroughStep(stepId);
  const anchored = !failed && !!step && stepAnchorsChoice(step);
  const accent = primary ? 'var(--p-red)' : 'var(--system-green)';

  const receipt = (entry: TourEntry, index: number) => (
    <details key={index} className={`text-xs ${primary ? 'text-[var(--p-blue)]' : 'text-[var(--system-green)]'}`}>
      <summary className="list-item cursor-pointer font-medium">{entry.summary}</summary>
      <p className="mt-1 pl-4 whitespace-pre-wrap text-[var(--foreground)]">{entry.text}</p>
    </details>
  );

  if (step === DEMO_ENTRY) return (
    <div className="space-y-3 p-3">
      {busy ? <p role="status" className="text-xs">Loading Iris…</p> : failed ? <>
        <p role="alert" className="text-xs">{log.at(-1)?.text}</p>
        <button type="button" className="underline" onClick={() => onChoose({ label: 'Retry', next: DEMO_ENTRY.id })}>Retry</button>
        <button type="button" className="ml-3 underline" onClick={onSkip}>Exit demo</button>
      </> : <>
        {log.filter(entry => entry.kind === 'tool').map(receipt)}
        <button type="button" ref={nextRef} onClick={() => onChoose(DEMO_ENTRY.choices[0])}
          style={{ ['--wt-glow' as string]: 'rgba(255, 214, 0, 0.5)' }}
          className="wt-anchored-glow w-full cursor-pointer border-2 border-black bg-[#ffd600] px-3 py-2.5 text-sm font-bold text-black focus-visible:outline-2 focus-visible:outline-offset-2">
          {DEMO_ENTRY.choices[0].label}
        </button>
      </>}
    </div>
  );

  return (
    <>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-2 min-h-[120px]">
        {/* The button you pressed is echoed as your turn, and rules off the beat
            above it. Without the break the whole tour ran together as one wall
            of text with no seam between one step and the next.
            When a reader reopens the panel during a bubble, show the step list.
            Panel-led steps show their transcript and navigation here. */}
        {!anchored && back && <div className="sticky top-0 z-10 float-right ml-2 bg-[var(--background)]">{back}</div>}
        {!anchored && log.map((e, i) => (
          e.kind === 'user' ? (
            <div
              key={i}
              className={`pt-2.5 mt-2.5 text-xs ${primary
                ? 'border-t border-[#111111]/15 font-bold'
                : 'border-t border-[var(--system-green)]/20 text-[var(--system-green)]'}`}
            >
              <span className="opacity-50">&gt; </span>{e.text}
            </div>
          ) : e.kind === 'tool' ? receipt(e, i) : (
            <div key={i} role={e.kind === 'error' ? 'alert' : undefined} className={`text-xs leading-relaxed ${e.kind === 'error' ? 'text-red-500 whitespace-pre-wrap' : ''}`}>
              {e.kind === 'error' ? e.text : <AssistantMarkdown text={e.text} />}
            </div>
          )
        ))}
        {busy && <div className="text-xs opacity-50"><span className="animate-pulse">▌</span></div>}

        {/* Where you are and what is left. An in-app tour of unknown length is
            the one people abandon, so the whole shape of it is on screen. */}
        {!busy && !failed && (
          <div className={`space-y-1 ${anchored ? '' : `mt-3 pt-2 ${primary ? 'border-t border-[#111111]/20' : 'border-t border-[var(--system-green)]/20'}`}`}>
            <details><summary className="list-item cursor-pointer text-[10px] uppercase tracking-widest opacity-70">
              Step {index + 1} of {WALKTHROUGH_STEPS}
            </summary>
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
            </details>
            {stepId === FIRST_STEP && <details className="text-xs"><summary className="list-item cursor-pointer">Tip: move this panel</summary>Use the dock buttons in the header to move it to the right, bottom, or a floating window.</details>}
            {/* In-chat steps (no bubble to anchor to) put the way forward HERE,
                right under the timeline the eye is already on — the same big
                yellow glowing button the bubbles use, not a small blue one lost
                at the panel's very bottom. */}
            {!anchored && (step?.choices ?? []).map(choice => (
              <button
                key={choice.label}
                ref={choice === step?.choices[0] ? nextRef : undefined}
                onClick={() => onChoose(choice)}
                style={{ ['--wt-glow' as string]: primary ? 'rgba(255, 214, 0, 0.5)' : 'rgba(16, 255, 80, 0.4)' }}
                className={`wt-anchored-glow mt-2 w-full py-2.5 px-3 text-xs font-bold cursor-pointer ${primary
                  ? 'bauhaus-btn bg-[var(--p-yellow)] text-[#111111]'
                  : 'border border-[var(--system-green)]/60 bg-black text-[var(--system-green)] hover:bg-[var(--system-green)]/10'}`}
              >
                {choice.next ? `Next: ${nextLabel(choice)}` : choice.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="px-3 pb-2 pt-1 flex-shrink-0 space-y-1.5">
        {anchored && <p className="text-[10px] opacity-60 py-1.5 px-2">Follow the highlighted bubble.</p>}

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
          <InfoTip text="Choose a suggested model or search your endpoint’s tool-capable models." />
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
          <InfoTip text="Any OpenAI-compatible endpoint works. Default is OpenRouter. A local runtime (e.g. Ollama) can perform model inference on this computer; this setting does not disable feedback or other browser requests." />
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
            <span>Include this exchange (your message + the reply, including any data they contain) with feedback</span>
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
