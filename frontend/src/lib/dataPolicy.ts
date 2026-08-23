// The two data-access modes and what each one permits.
//
// Single source of truth on purpose, like disclosures.ts: the tool registry,
// the column profiles, the system prompt, and the UI badges all derive from
// the SAME policy object, so the prompt can never promise a guarantee the
// tools don't enforce (or vice versa).
//
// Every dataset carries a mode, chosen by the user at upload time:
//
//   'private' — the default. The assistant sees column metadata and aggregate
//               summaries only; rare category values and identifier columns
//               are withheld; no tool can read a row.
//   'open'    — the user has declared the dataset public/non-sensitive. Row
//               sampling and full category listings become available.
//
// Downstream code never asks "is this open?" — it asks for a capability
// (`policy.rowAccess`, `policy.fullCategories`), so what each mode means is
// decided here and only here.

export type DataMode = 'private' | 'open';

export type DataPolicy = {
  mode: DataMode;
  /** sample_rows / get_rows_where / list_categories tools exist. */
  rowAccess: boolean;
  /** Category values are listed regardless of how few rows they cover. */
  fullCategories: boolean;
  /** Identifier-like columns are profiled like any other column. */
  identifiersVisible: boolean;
};

export const policyFor = (mode: DataMode): DataPolicy =>
  mode === 'open'
    ? { mode, rowAccess: true, fullCategories: true, identifiersVisible: true }
    : { mode, rowAccess: false, fullCategories: false, identifiersVisible: false };

/**
 * The effective policy when several datasets are in play: the MINIMUM.
 *
 * The assistant's tool list is per-conversation, not per-dataset, and tools
 * like transfer_column cross dataset boundaries — so one private dataset in
 * the session means the whole conversation runs private. An empty session is
 * private too: there is nothing to be open about, and fail-closed is the rule.
 */
export const combinedPolicy = (modes: DataMode[]): DataPolicy =>
  policyFor(modes.length > 0 && modes.every(m => m === 'open') ? 'open' : 'private');

/**
 * Deserialization guard. Workspaces and autosaved sessions from before this
 * feature carry no mode, and a hand-edited file could carry anything —
 * everything unrecognized resolves to 'private', never to 'open'.
 */
export const asDataMode = (v: unknown): DataMode => (v === 'open' ? 'open' : 'private');

// Token budgets for the row-access tools — caps on how much one call returns,
// not privacy rules (in private mode the tools do not exist at all).
export const MAX_SAMPLE_ROWS = 50;
export const MAX_SAMPLE_COLUMNS = 20;
export const MAX_CELL_CHARS = 200;
