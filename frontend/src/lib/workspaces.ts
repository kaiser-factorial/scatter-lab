// Workspace persistence in IndexedDB (localStorage tops out ~5MB; snapshots
// with embedded tables can exceed that easily). Same four operations the old
// backend REST endpoints exposed, plus file export/import for sharing.

export type WorkspaceMeta = { name: string; saved_at: string; bytes: number };

const DB_NAME = 'scatter-lab';
const STORE = 'workspaces';
// v2 adds the session store: the continuously-autosaved "where you left off"
// record, kept apart from named workspaces so autosave can never overwrite a
// deliberate checkpoint.
const SESSION_STORE = 'session';
const DB_VERSION = 2;

const openDB = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      if (!req.result.objectStoreNames.contains(SESSION_STORE)) req.result.createObjectStore(SESSION_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const tx = async <T>(store: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const db = await openDB();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
  });
};

type Stored = { payload: any; saved_at: string; bytes: number };

export const listWorkspaces = async (): Promise<WorkspaceMeta[]> => {
  const [keys, values] = await Promise.all([
    tx<IDBValidKey[]>(STORE, 'readonly', s => s.getAllKeys()),
    tx<Stored[]>(STORE, 'readonly', s => s.getAll()),
  ]);
  return keys
    .map((k, i) => ({ name: String(k), saved_at: values[i]?.saved_at ?? '', bytes: values[i]?.bytes ?? 0 }))
    .sort((a, b) => b.saved_at.localeCompare(a.saved_at));
};

/**
 * Approximate the stored size from the table dimensions instead of serialising
 * the payload to measure it (finding F21).
 *
 * `bytes` is display-only — it renders as "12.4 MB" beside the workspace name —
 * and buying it with a full JSON.stringify meant every save serialised the whole
 * payload twice: once to measure, once again when IndexedDB structured-cloned
 * it. On a 200k × 30 table that measured 510 ms to stringify a 38.6 MB string
 * plus 1,080 ms to clone: about 1.6 s of blocked main thread and +77 MB
 * transient, for a number nothing reads back.
 *
 * The estimate walks only the table shapes, not the cells. Roughly 12 bytes per
 * cell is what mixed numeric/short-string JSON averages; being off by a third on
 * a label is immaterial, and it is honest about being an estimate.
 */
const estimateBytes = (payload: unknown): number => {
  const p = payload as { tables?: Record<string, { columns?: unknown[]; nRows?: number }> };
  let cells = 0;
  for (const t of Object.values(p?.tables ?? {})) {
    cells += (t?.columns?.length ?? 0) * (t?.nRows ?? 0);
  }
  // 2 KB covers the settings, notes and axis labels riding alongside.
  return cells * 12 + 2048;
};

export const saveWorkspace = async (name: string, payload: any): Promise<void> => {
  const stored: Stored = { payload, saved_at: new Date().toISOString().slice(0, 19), bytes: estimateBytes(payload) };
  await tx(STORE, 'readwrite', s => s.put(stored, name));
};

export const loadWorkspace = async (name: string): Promise<any | null> => {
  const stored = await tx<Stored | undefined>(STORE, 'readonly', s => s.get(name));
  return stored?.payload ?? null;
};

export const deleteWorkspace = async (name: string): Promise<void> => {
  await tx(STORE, 'readwrite', s => s.delete(name));
};

// --- session continuity ------------------------------------------------------
// One record, autosaved as the user works, restored on the next load. Same
// payload shape as a workspace so validateWorkspace/applyWorkspace cover both.

const SESSION_KEY = 'current';

export const saveSession = async (payload: unknown): Promise<void> => {
  await tx(SESSION_STORE, 'readwrite', s => s.put({ payload, saved_at: new Date().toISOString().slice(0, 19) }, SESSION_KEY));
};

export const loadSession = async (): Promise<unknown> => {
  const stored = await tx<{ payload: unknown } | undefined>(SESSION_STORE, 'readonly', s => s.get(SESSION_KEY));
  return stored?.payload ?? null;
};

export const clearSession = async (): Promise<void> => {
  await tx(SESSION_STORE, 'readwrite', s => s.delete(SESSION_KEY));
};

export const exportWorkspaceFile = (name: string, payload: any) => {
  const blob = new Blob([JSON.stringify({ name, ...payload })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name}.scatterlab.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};

/** The payload shape this build knows how to apply. */
export const WORKSPACE_VERSION = 1;

// `unknown` rather than `any` throughout: this is the one place in the app that
// handles a value nobody typed, so the narrowing has to be real.
type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

const isTable = (t: unknown): boolean => {
  if (!isRecord(t)) return false;
  return Array.isArray(t.columns)
    && t.columns.every((c: unknown) => typeof c === 'string')
    && isRecord(t.data)
    && typeof t.nRows === 'number' && Number.isFinite(t.nRows) && t.nRows >= 0;
};

/**
 * Reject a workspace this build cannot apply, with a reason.
 *
 * The check used to be `!parsed.version` and nothing else, so a truncated,
 * hand-edited or half-written file got as far as `applyWorkspace`, which
 * rehydrated a dangling table reference to `undefined` and left render to
 * dereference `d.table.nRows`. That threw inside React and white-screened the
 * app with no way back except a reload (finding C11). Everything below is
 * cheap; the point is that it happens BEFORE any state is replaced.
 */
export const validateWorkspace = (parsed: unknown): void => {
  if (!isRecord(parsed)) {
    throw new Error('Not a workspace file — expected a JSON object.');
  }
  if (typeof parsed.version !== 'number' || !Number.isFinite(parsed.version)) {
    throw new Error('Not a workspace file — it has no version number.');
  }
  // version is written on save and was never read back, so there was no
  // forward-compatibility story either. Now a newer file says so plainly
  // instead of failing somewhere further in.
  if (parsed.version > WORKSPACE_VERSION) {
    throw new Error(`This workspace was saved by a newer version of Scatter Lab (format ${parsed.version}, this build reads ${WORKSPACE_VERSION}).`);
  }

  if (parsed.tables != null && !isRecord(parsed.tables)) {
    throw new Error('Workspace file is damaged: its "tables" section is not an object.');
  }
  const tables: Rec = isRecord(parsed.tables) ? parsed.tables : {};
  for (const [id, t] of Object.entries(tables)) {
    if (!isTable(t)) throw new Error(`Workspace file is damaged: table "${id}" is not a valid table.`);
  }
  // A string is a reference into `tables`; anything else is an inline table.
  const resolve = (ref: unknown) => (typeof ref === 'string' ? tables[ref] : ref);

  if (parsed.datasets != null && !Array.isArray(parsed.datasets)) {
    throw new Error('Workspace file is damaged: its "datasets" section is not a list.');
  }
  // The failure that actually white-screened the app: a dataset naming a table
  // that is not in the file.
  (Array.isArray(parsed.datasets) ? parsed.datasets : []).forEach((d: unknown, i: number) => {
    if (!isRecord(d)) throw new Error(`Workspace file is damaged: dataset #${i + 1} is not an object.`);
    const where = typeof d.name === 'string' && d.name ? `"${d.name}"` : `#${i + 1}`;
    const t = resolve(d.table);
    if (t === undefined) {
      throw new Error(`Workspace file is damaged: dataset ${where} refers to a table ("${String(d.table)}") that the file does not contain.`);
    }
    if (!isTable(t)) throw new Error(`Workspace file is damaged: dataset ${where} has no usable table.`);
  });

  if (parsed.pinnedViews != null && !Array.isArray(parsed.pinnedViews)) {
    throw new Error('Workspace file is damaged: its "pinnedViews" section is not a list.');
  }
  (Array.isArray(parsed.pinnedViews) ? parsed.pinnedViews : []).forEach((v: unknown, i: number) => {
    const t = isRecord(v) ? resolve(v.data) : undefined;
    if (t === undefined || !isTable(t)) {
      throw new Error(`Workspace file is damaged: pinned view #${i + 1} has no usable data.`);
    }
  });
};

// --- assistant conversation --------------------------------------------------
// Stored inside the workspace/session payload as an optional `conversation`
// section: the display transcript plus the wire-format history that lets the
// assistant actually continue where it left off (not just show old bubbles).
// The API key is NOT part of this — it stays in localStorage, as ever.

// `local` marks a message the panel composed rather than a model (the handoff
// greeting); it must survive a round-trip so restored greetings still aren't
// offered for thumbs feedback.
export type ConversationEntry = { kind: 'user' | 'assistant' | 'tool' | 'error'; text: string; local?: boolean };
export type Conversation = { entries: ConversationEntry[]; history: unknown[] };

const ENTRY_KINDS = new Set(['user', 'assistant', 'tool', 'error']);

/**
 * Reduce an untyped `conversation` section to something the panel can render,
 * or null if there is nothing usable. Unlike the table checks above this
 * sanitizes rather than throws: a workspace whose data is intact should not be
 * refused because its chat section is damaged — the chat is auxiliary.
 */
export const sanitizeConversation = (v: unknown): Conversation | null => {
  if (!isRecord(v)) return null;
  const entries = (Array.isArray(v.entries) ? v.entries : [])
    .filter((e: unknown): e is ConversationEntry =>
      isRecord(e) && typeof e.text === 'string' && typeof e.kind === 'string' && ENTRY_KINDS.has(e.kind));
  const history = (Array.isArray(v.history) ? v.history : []).filter(isRecord);
  if (entries.length === 0 && history.length === 0) return null;
  return { entries, history };
};

export const importWorkspaceFile = async (file: File): Promise<{ name: string; payload: unknown }> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    // JSON.parse's own message ("Unexpected token < in JSON at position 0") is
    // not something to show a researcher who picked the wrong file.
    throw new Error('That file is not valid JSON, so it is not a workspace file.');
  }
  validateWorkspace(parsed);
  // validateWorkspace has established this is a record; narrow for the name.
  const rec = parsed as Rec;
  const name = typeof rec.name === 'string' && rec.name
    ? rec.name
    : file.name.replace(/\.scatterlab\.json$|\.json$/i, '');
  return { name, payload: parsed };
};
