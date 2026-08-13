# Scatter Lab — Handoff

**Date:** 2026-08-11 (scripted walkthrough + pin interactivity; code-review remediation was
2026-08-05; build sprint was Aug 1–2, 2026)
**Live:** https://scatter-lab.vercel.app · **Repo:** https://github.com/kaiser-factorial/scatter-lab (public)
**Deploy:** push to `main` → Vercel auto-builds (project `scatter-lab`, team `factorial-ai`, Root Directory `frontend`, ~35s builds)

## What this is

Scatter Lab (formerly "PCA Workbench") is a fully client-side workbench for exploring
tabular research data as interactive 2D/3D scatter plots — built for survey research,
general-purpose in practice. **All computation runs in the browser; the dataset is never
uploaded to a server.** There is no backend; the deployed app is a static site. The
optional assistant is the sole exception, and it sends aggregates only — never raw rows.
Do not restore the older "data never leaves the machine" phrasing anywhere: it is a
promise the app cannot keep once an API key is connected.

## Architecture

Everything lives in `frontend/` (Next.js 16 / React 19 / TS / Tailwind 4 / Plotly WebGL).
The app is one page ([src/app/page.tsx](frontend/src/app/page.tsx)) plus libraries:

| File | Responsibility |
|---|---|
| `src/lib/parse.ts` | CSV (PapaParse), XLSX (SheetJS), Parquet (hyparquet) → columnar table |
| `src/lib/engine.ts` | Median imputation, z-scaling, projection through a components file |
| `src/lib/pca.ts` | In-app PCA: Jacobi eigensolver, scores/loadings/scree (sklearn-equivalent) |
| `src/lib/cluster.ts` | DBSCAN + K-Means (k-means++, seeded/deterministic) |
| `src/lib/stats.ts` | Pearson/Spearman, group comparison + eta², silhouette-by-k, k-distance |
| `src/lib/workspaces.ts` | Named workspaces + autosaved session (IndexedDB `scatter-lab`) + file export/import |
| `src/lib/assistant.ts` | Assistant client (OpenAI-compatible), tool definitions, tool loop |
| `src/lib/walkthrough.ts` | The scripted tour as data: steps, bridge actions, handoff greeting |
| `src/lib/relayout.ts` | Reading Plotly's `plotly_relayout` payload (camera / 2D viewport / reset) |
| `src/lib/methods.ts` | Curated, cited methods-reference chunks + lexical retrieval |
| `src/lib/openrouterAuth.ts` | OpenRouter OAuth PKCE (one-click key issuance) |
| `src/lib/feedback.ts` | Thumbs feedback → IndexedDB buffer → Supabase (insert-only) |
| `src/components/AssistantPanel.tsx` | Panel: menu / walkthrough / chat, dock modes, markdown, feedback |
| `src/components/WalkthroughStartDialog.tsx` | Consent gate before the tour runs over loaded data |

Two full visual themes (Bauhaus "primary" / Terminal) via `next-themes`; theme-aware
plot chrome throughout.

**Visual channels:** position (X/Y/Z), colour (`colorBy`, categorical palette or Viridis
ramp), and marker shape (`shapeBy`, added 2026-08-02). Shape is capped at 6 levels
(`SHAPE_SYMBOLS`: filled circle/square/diamond then their open twins — cross/x are
excluded because scatter3d draws them at a much heavier visual weight, which reads as
size). Plotly takes one symbol per trace, so an active shape variable subdivides every
colour group; palette indices are keyed to the colour categories alone so nobody's
colour shifts. Legend shows a colour key (clickable: mute → hide) plus a display-only
shape key — muting stays a colour concept, since `mutedMap` is keyed by colour value.

**Smart first-view defaults:** PC1–3 still win when present. Otherwise automatic axes
skip explicitly named ID columns (`Id`, `*_id`, `…ID`) whenever two measured numeric
columns remain. Automatic colour preserves a deliberate shared selection, then prefers
`Cluster`, then the lowest-cardinality 2–20-level non-ID, non-boolean-like column; a
binary `0/1` flag counts as boolean-like. IDs remain selectable everywhere—this only
improves automatic choices. The policy is pure/tested in `src/lib/defaults.ts`.

**Cluster composition export:** the Cluster Info panel can save its selected `% of
cluster` or `% of group` view as a 2× PNG heatmap (Viridis, Inferno, or Greens), with a
0–100% colour-scale legend. Cells retain both the normalized percentage and raw count; rendering/download is local
in `src/lib/clusterBreakdown.ts`.

## Session continuity (2026-08-13)

Refresh no longer resets the app. A single "current session" record (IndexedDB
`scatter-lab`, store `session`, DB version 2) is autosaved as the user works —
**event-driven and debounced (1.5 s after the last change), not on a timer** —
with a flush on `pagehide`/`visibilitychange` to catch a close inside the
debounce window. On load it auto-restores with a toast ("Picked up where you
left off" + Start fresh). Named workspaces are untouched by autosave; they stay
deliberate checkpoints.

The payload is the same shape as a workspace (still format 1) plus an optional
`conversation` section: the assistant's display transcript **and** its
wire-format history, so a restored conversation actually continues — the model
keeps its context. Conversations therefore also ride inside named workspaces
and exported files (snapshot semantics: loading a workspace replaces the
current chat with the workspace's own, or clears it if there is none —
Corina's call, incl. export-by-default). The API key stays in localStorage
only, as ever. `sanitizeConversation` filters the section on apply rather than
validating it — a damaged chat must never cost the user their data (contrast
`validateWorkspace`, which still throws for anything that can white-screen).

**Crash-loop guard:** `scatterlab.session.restoreGuard` (localStorage) is set
before applying the session and cleared by an effect that only runs after the
restored state commits. If a restore ever white-screens (the C11 failure
class), the next load finds the flag, skips auto-restore, and offers
Resume/Discard instead of looping. The restore effect is single-shot behind a
ref so StrictMode's dev double-mount doesn't trip the guard it just set.

The panel side goes through `ConversationBridge` (same mutable-ref pattern as
`askRef`), whose `pending` slot covers the startup race: the panel is
dynamically imported, so a restore can finish before the panel exists to
receive its conversation. Deliberately deferred: a conversation archive /
history UI (v1 keeps exactly one live conversation; the settings "clear" is
still destructive), truncating the *sent* wire history on very long
conversations (stored ≠ sent; the growth predates persistence), and splitting
tables into their own store so autosave stops re-cloning them when only view
state changed (only matters ≥100k rows; the F21 estimate note has the numbers).

## The assistant

Bring-your-own-key via **OpenRouter** (one-click OAuth PKCE, or manual key; any
OpenAI-compatible endpoint works, incl. Ollama for offline). Key in localStorage only,
never in exported workspaces. Model picker: curated flagship chips + type-to-search over
tool-capable models only (filtered via `supported_parameters`).

**Tools** (all validated, instructive error strings): `get_app_state`, `set_plot`,
`run_clustering`, `get_cluster_breakdown`, `save_cluster_heatmap`, `save_active_view_png`,
`save_interactive_html`, `save_rotating_gif`, `save_active_dataset_csv`, `pin_view` /
`remove_pin`, `load_demo_data`
(idempotent), `run_pca`, `correlate`, `compare_groups`, `suggest_k`, `suggest_eps`,
`switch_dataset`, `set_category_visibility`, `transfer_column`, `save_workspace`,
`get_tutorial` (curated tour chunks), `get_methods_reference` (cited interpretation
chunks), `highlight_ui` (ephemeral ring+arrow pointer at sidebar anchors),
`control_view` (3D rotation/zoom/reset).

**Privacy contract:** requests carry column metadata + aggregates only — never raw rows;
stated in the panel UI. **Undo:** view-state snapshot before each mutating turn; one-click
revert (workspace saves excluded, flagged in tool result). **Critical invariant:** the tool
loop receives the bridge *ref* and dereferences `.current` per call, with a paint-aware
yield between calls — passing the object itself froze a whole turn at send-time state
(the `GET APP STATE` polling bug, fixed in `4a5018d`). Don't regress this.

## The scripted walkthrough

`src/lib/walkthrough.ts` + `WalkthroughStartDialog.tsx` + the `walkthrough` view in
`AssistantPanel.tsx`. Read this before editing the tour or the panel's view machine.

**Why it exists.** There was one tour, `TUTORIAL.iris_demo` — a ~1,400-word prose brief
telling the model to run nine beats "one beat at a time", with directives like *do not set
Species as marker shape before step 5* and *never initiate a download merely because it is
mentioned*. That is a script enforced by asking nicely, and it cost an API key to reach at
all: the panel rendered `SettingsForm` whenever `!apiKey`, so the first screen a visitor
without one met was a form asking for a credential, before anything showed what it was for.

**The insight is that it needs no model.** Every beat of `iris_demo` was already an
`AppBridge` method, so the deterministic tour is the same tour with the model removed:
steps call the bridge directly, the wording is fixed, the ordering is an array. `iris_demo`
now *defers* to it (offer the button, only narrate a tour if declined or if the user wants
their own data toured) rather than keeping a second copy of the same facts — three copies
of one fact drifting apart is what caused A3, and this would have been a fourth.

**Load-bearing details.**

- **Steps hold a LIST of actions, not one function taking a bridge.** The bridge closes
  over the page's state and is rebuilt on every commit, so two calls against one
  dereferenced bridge run the second against pre-commit state — the GET APP STATE bug
  (`4a5018d`). The runner re-reads `bridgeRef.current` and `paintYield()`s between actions,
  which makes the correct thing the only thing a step can express. `paintYield` is now
  exported from `assistant.ts` so the tool loop and the walkthrough share one copy.
- **`flashGuide` gained a `persist` mode** and now returns a disposer instead of a boolean.
  The 5.4 s timeout is right for the assistant, which points while it talks; in
  click-to-advance a user reading for twenty seconds would watch the pointer die. The
  walkthrough holds the ring and drops it on step change, on exit, and on unmount (it lives
  on `<body>` — nothing else would clean it up). `bridge.holdHighlight` is the entry point.
- **Nothing destructive without consent.** A `snapshot()` is taken before the first step
  and offered back as "Restore my pre-walkthrough workspace" on exit — but only if there
  were datasets to restore. What a snapshot does *not* cover is the user's own data being
  displaced as active, so with any dataset loaded the tour stops at a dialog that says what
  it will change, offers the workspace save **inline** (advice to go save first, at the cost
  of the dialog, is advice nobody takes), and offers Cancel. Uploading is disabled in the
  sidebar while it runs, with "Quit the walkthrough" beside the disabled control.
- **The tour never downloads anything**, and that is now a test against a recording bridge
  rather than a line of prose asking the model not to.
- **Tests** (`walkthrough.test.ts`, 18 cases) prove the graph — every `next` resolves, every
  step is reachable, it terminates — and run the steps against a recording proxy bridge to
  pin call order (shape only after clustering owns colour; the live view returns to the
  flower measurements after the 2D pin). A renamed step id is a failing test, not a dead end.

**Two entry points, one path.** The empty state's **Load demo** button (was "Load demo
data") opens the panel and starts the tour rather than only loading a file — so the demo is
one click from the opening screen. That is why `loadDemoData` is the *first step's* action
and not the second's: the button starts the walkthrough and the walkthrough loads the data,
instead of the page loading data and then handing over (which would trip the consent dialog
on the dataset it had just loaded itself). It is idempotent, so the menu route and a repeat
run both behave. The page holds `startWalkthroughRef`, mirroring `exitWalkthroughRef`, and
falls back to a plain `loadDemo()` if the dynamically-imported panel has not assigned it yet.

**The panel moves itself before it pins.** The compare step calls
`bridge.setAssistantDock('bottom')` *before* `pinView`, because two panes in the strip left
beside a right-docked panel are two unreadable slivers — and it points at the dock buttons
(`data-guide="assistant-dock"`, the first guide target outside the sidebar) so the move is
explained rather than merely surprising. It does not move back on exit: the bottom dock is
the better place once a pin exists, and the user has now seen the control. Note that this
goes through `changeDock`, so it also *persists* to `scatterlab.assistant.dock` — the tour
changes a saved preference, deliberately. Test-pinned: `setAssistantDock('bottom')` must
precede `pinView`.

**Highlight scope was a per-theme bug.** `SidebarSection` put `data-guide` on the outer
`<div>` in the terminal branch but on the *title span* in the Bauhaus branch — so pointing
at "variables" ringed three words of header on one theme and the whole panel on the other.
Both anchor the section now. `flashGuide`'s accordion-opening fallback still works, since it
walks up to `[data-scatter-section]`, which is on the same element.

**Panel chrome while it runs.** Choice buttons sit *above* a disabled composer reading "Use
buttons above for walkthrough", with **Exit demo** on the end of that row — the row is where
the eye goes when typing turns out not to work, which is why the way out lives there rather
than as a link below it. It is an `<input>`, not a `<textarea>`: a textarea wraps its
placeholder and clips the second line against the one-row height. Each pressed button is
echoed into the transcript as a user turn and rules off the beat above it; without that the
whole tour read as one wall of text. A progress counter and the full step list (past struck
through, current in the theme accent, upcoming plain) render below the transcript, because an
in-app tour of unknown length is the one people abandon.

**Panel view machine.** `menu | walkthrough | chat`, plus the existing settings toggle. The
menu is the front door exactly once (`scatterlab.assistant.menuseen`); after that the panel
opens in `chat` and the menu stays one click away in the header, so the walkthrough is never
unreachable. The handoff greeting is composed locally from `getState()` and pushed into
`historyRef` — not sent as a hidden user turn: a first impression should not be a coin flip,
should not cost a round trip, and has to work before a key exists. It is flagged `local` so
the thumbs controls skip it; rating a hard-coded string would land in the eval table as
model feedback.

**One bug it surfaced.** The walkthrough points at the PCA panel and says "Id is excluded" —
and Id was sitting there ticked, because `bridge.runPCA` called `handleRunPCA` directly while
`PCASection` kept its own default selection. Pre-existing on the assistant path, invisible
until something narrated it. The page now mirrors an external run (`externalRun` prop:
variables, k, standardize, missing, label, and a `seq` so a repeat re-syncs) back into the
panel's controls. The label is synced *and pinned* (`labelTouched`) because the auto-suggest
derives a label from shared affixes, which on the four Iris columns is `thCm` — a name for
columns the run did not create.

## Feedback pipeline (eval data)

Thumbs per assistant reply → instant metadata-only row; optional "why" box (rating-matched
example text, consent checkbox for including the exchange) → second row sharing `event_id`.
Sink: Supabase project `mdkjiyatfavavqkpvngh` (its own free org — **not** the main org),
table `assistant_feedback`, **insert-only RLS** for the anon key (SELECT/UPDATE/DELETE
verified to touch zero rows). Buffered through IndexedDB, background-flushed. Env:
`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` (Vercel: all three
environments; local: `frontend/.env.local`, see `.env.local.example`). Unset = feedback UI
hidden. Repo is `supabase link`ed. Analysis query:

```sql
select distinct on (event_id) * from assistant_feedback
order by event_id, created_at desc;
```

**Cross-project review (2026-08-02, from the joint-session side).** Scatter Lab's
feedback design was ported to joint-session the same day (per-message 👍/👎 + optional
reason), which prompted a read of `feedback.ts` from outside. Two robustness gaps and a
convergence plan came out of it — the gaps are Outstanding #11, the plan is below.

Joint-session stores its ratings differently on purpose: it has Firebase auth and the
rated message is itself a Firestore document, so the rating lives *on* the message
(`ratings`/`ratingNotes` maps keyed by uid) instead of in a snapshot row — no
`user_message`/`assistant_message` copies needed. Scatter Lab's snapshot-row model is
right for *this* app (no backend, nothing to join against); neither should adopt the
other's storage. The convergence point is the **warehouse**: this Supabase project's
`assistant_feedback` table becomes the shared eval sink by (a) adding a `source_app`
column defaulting to `'scatter-lab'`, and (b) a small offline export script (service
role, runs locally — never in an app bundle) that pulls joint-session's ratings via a
collection-group query and inserts them with `source_app = 'joint-session'`. Shared
record shape: `source_app, event_id, model, rating, reason, tools?, created_at`. Apps
keep their native storage; analysis gets one table.

## The 2026-08-05 code review, and what it changed

A full review lives in [docs/code-review-2026-08-05.md](docs/code-review-2026-08-05.md)
— findings grouped A (analytic accuracy), B (what the UI says), C (import/export),
D (assistant), E (dependencies/coverage), F (performance). Everything except the items
listed under "Still open" below has been fixed on branch
`claude/code-review-menu-analytics-ui-f7llud`. Read the review for the reasoning; this is
the orientation.

**The five that would have changed a published number.**

- **A2** — the demo file was the errata iris (see Data hygiene). PC1 was 72.77% where R
  says 72.96%.
- **A3** — `suggest_eps` read the k-distance curve at the `min_samples`-th neighbour, but
  `dbscan` counts the point itself, so every suggested eps was one neighbour too generous
  — and it contradicted the app's own methods reference.
- **A14** — SPSS/Qualtrics missing-value codes (`-99`, `-999`, `9999`) parsed as ordinary
  measurements and entered the correlation matrix, distances and histograms. Now detected
  and reported, never auto-stripped: which code means what is the researcher's knowledge.
- **C6** — a column Excel formatted as Text was a usable measurement in half the app and
  missing data in the other half. Worst case, clustering median-imputed *every* row of it
  and clustered on a constant.
- **C10** — a components file matched against a subset produced a truncated dot product
  reported as a PC score, with case-sensitive matching that could silently match nothing.

**The one worth knowing about as a design decision (D8).** The assistant's column profile
sent each categorical column's most frequent values. On `Species` that is the aggregate;
on an email column it is eight arbitrary rows. The guard is now per-VALUE, not per-column:
a value covering at least five rows is named, anything rarer is only counted. That keeps
an ordinary 60-level `school` variable fully usable — a per-column cardinality rule
withheld it for no privacy gain — while an email address is never sent. Five is the
conventional small-cell threshold in statistical disclosure control.

**Transparency (B series).** Users never see the code, so the choices the app makes are
now in the interface: `(i)` markers beside the controls they apply to, and an **About**
dialog from the header. Both render from `src/lib/disclosures.ts`; `methods.ts` supplies
the long-form citation-backed half. One source, three surfaces — the drift between three
copies of the k-distance convention is exactly what caused A3.

**Performance (F series).** The rotation loop was the centre of it: `setCamera` inside
`requestAnimationFrame` re-rendered the whole tree sixty times a second and, because the
layout object was rebuilt inline, made `react-plotly.js` re-plot all four panes every
frame. Rotation now writes the camera straight to the plot (`Plotly.relayout`), and three
seconds of rotation produces **zero** `plotly_redraw` events. Alongside: pins hold their
own camera; `TmuxGrid` no longer purges every WebGL context when a pin is added or
removed; `ViewPlot` and the assistant panel are memoized so sliders and keystrokes cannot
reach the plots; the HTML export lost 43% of its bytes; and `pickDefaultColorBy` went from
1,194 ms to 42 ms on 200k × 30 with output proven identical against the old implementation
across 400 random tables.

**F17 deserves its own line** because it was filed as "probably nothing, worth one browser
check". The app passed `template: 'plotly_white'` and `var(--foreground)` as Plotly
colours; measured, Plotly resolved the template to `undefined` and every one of those
colours to its own default `#444`. The theme-aware plot chrome had never once applied.

### Still open from the review

- **E1 follow-on — `ccru` pulls `next@14.2.35`**, which carries most of the repo's
  remaining high-severity advisories (plus `postcss`, `sharp`, `undici`). The app itself
  runs `next@16.2.10`, so this is transitive, not shipped code — but it is what `npm audit`
  keeps reporting. Deliberately left alone: it is a dependency decision, not a code fix.
- **F7 — 2D scatter is SVG, one DOM node per point.** `plotly.js-gl3d-dist-min` does not
  register `scattergl`, so 2D mode has no decimation and 50k points freezes the tab. The
  fix is a build decision with a real trade: `plotly.js-dist-min` roughly doubles the
  vendored bundle **and** the self-contained HTML export, which F3 just cut by 43%. A
  custom bundle registering `scattergl` + `scatter3d` + `mesh3d` is the better answer and
  is a build-pipeline change (`copy-plotly`, the inlined export bundle). Wants a decision,
  not a patch.
- **F19 / F23 — CSV parsing.** Parsing positionally (`header: false`) measured −35–48%
  time and memory, and PapaParse's `worker: true` would keep the tab responsive. Both were
  left deliberately: `header: true` is what produces the `TooManyFields` / `TooFewFields`
  errors and the `renamedHeaders` map that the C1/C2 warnings are built on, so taking them
  means reimplementing the ragged-row and duplicate-header detection by hand. Trading the
  silent-data-loss machinery — the single biggest theme of this review — for import speed
  is not a change to make unsupervised.
- **F16 (the large half)** — dropping 36 hard-coded 500 ms sleeps in the GIF export needs
  `_fullLayout.scene._scene` + `gl.readPixels` instead of `Plotly.toImage`. Private API,
  ~46 s → ~5 s. The palette-reuse half is done.
- **A4/A5-adjacent leftovers**: none. A5, A6, A8, A10–A14 are all closed.
- **E6** — DBSCAN is O(n²) and `queue.push(...jn)` can exceed the argument limit on very
  large neighbour sets; `distMatrix` allocates n² doubles. Fine at survey scale, but these
  are cliffs rather than slopes and there is still no row-count guard in front of them.
- **Rules-of-hooks is not in the eslint config.** Worth adding: this session found three
  `useMemo`s sitting after an early return in `ColumnTransfer` (fixed), and introduced —
  then caught in the browser — the same mistake in `Home`, where React threw error #310.
  The unit suite is green on that bug; only loading the page finds it.

## Missing-value codes: detection, tiers, and the recode

A14 closed the reporting half — codes like `-99` are detected and named instead of
entering the correlation matrix. The rest of this is the acting half, and it is the only
code in the app that changes a user's data on their behalf, so read this before touching
`lib/sentinels.ts`, `lib/recode.ts` or `components/RecodeDialog.tsx`.

**There is no library for this.** Checked, not assumed: R's naniar ships a *list* of common
codes (`common_na_numbers`) and a counter, but no test of whether a given column's 9 is a
code or a rating. FAHES (QCRI, VLDB 2018) is a research prototype in C. Everything else in
the ecosystem solves the problem upstream, by reading **declared** missing values out of
`.sav`/`.dta` metadata — which a CSV export throws away. So the rules are ours.

**Three per-column rules**, each stating what it costs (`sentinels.ts`):

| rule | fires when | why the others miss it |
|---|---|---|
| impossible sign | candidate < 0 and the column is otherwise never negative | `-99` against incomes spanning 200,000 is a gap of 99 and vanishes under a ratio test |
| far outside | gap > half the core's spread | the original rule; tuned for `-99` against wide continuous data |
| scale hole | all-integer core, ≤20 levels, candidate clears it by ≥2 | **a 1–7 Likert with 9 = Don't Know has a spread of 6 and a gap of 2** — the commonest case of all, and the ratio rejected it |

**Three confidence tiers.** Wrong sign, or a gap ≥3× the spread, is `certain`. Everything
else falls to the share of the column the value accounts for: ≥5% is `likely`, below is
`possible`. That boundary is a heuristic tuned on the shapes in the test suites, not a law
— a Don't Know option is a response people actually *pick* (6–33% of rows in our cases)
where a real 9 in the tail of a skewed count is rare (1–3%) — and it is the honest answer
to the one distinction a single column cannot make. It is pinned per shape in
`sentinel-sweep.test.ts`, including the deliberately-recorded false positive.

**Cross-column co-occurrence** is the second, independent kind of evidence, and the one a
human actually reasons with: if respondents 4, 17 and 92 carry 9 in eleven Jealousy items,
that is one person choosing Don't Know eleven times, not eleven coincidences. For value
*v*, take every column holding it with counts *nᵢ* summing to *S* over *N* rows; count how
many of those columns carry *v* in each row (*k*); this column's observed pairs are
Σ(*k*−1) over its own rows, against *nᵢ*(*S*−*nᵢ*)/*N* predicted by independence. Their
ratio is the lift.

Three properties that are load-bearing, all mutation-tested:

- **Per column, never for the group.** Otherwise a real 9 in `child_age` is promoted by a
  Don't Know block running through twenty Likert items — the exact discrimination this
  exists to make.
- **It only ever raises confidence.** A survey may use a code in exactly one item, so
  absence of a pattern is not evidence against a code, and nothing is demoted.
- **It never creates a finding.** Six real 9s in a 0–10 rating landing on the block's rows
  is a coincidence the detector must not be talked into by its neighbours.

`peers` counts columns that *hold* the value, which is **not** the number sharing rows — an
id column with a single incidental 9 is a peer and overlaps with nothing. Never phrase an
agreement claim with it; that is what the lift is for. (Written after the browser caught
"same rows as 9 in 7 other columns" for a battery of six.)

**Defaults are the safety argument.** Ticking everything makes the destructive choice the
lazy one; ticking nothing makes a Don't Know block a click per column. So `certain` and
`likely` arrive ticked, `possible` does not, and a declared code the detector never flagged
arrives **unticked unless co-occurrence supports it** — which is precisely the reported
workflow: declare 9, see the battery ticked and `child_age` not, click Apply.

**Every recode reports its effect** — cells blanked, n before/after, the shift in mean and
sd — and asserts that values outside the recode are byte-identical afterwards. Modelled on
the check in the author's MATLAB script, which verified a recode by correlating original
against rebuilt on untouched rows expecting ~1.00, got 0.9365, and thereby revealed the
item set was wrong rather than the recode.

**Cost.** The scan runs only when the user says yes, never at import (that double scan was
the reported upload latency). On a survey-shaped table — 3,105 × 1,156 with 452 columns
sharing the code — the per-column pass is ~243 ms and the cross-column pass takes it to
~286 ms.

**Next, in order.** (1) `.sav`/`.dta` import reading declared missing values from the
codebook, which beats every heuristic here and is its own feature ticket; browser-capable
readers exist on npm (`sav-reader`, `datareader-spss`). (2) The Hua & Pei (KDD 2007)
unbiased-sample check, held in reserve.

## Data hygiene (repo is PUBLIC)

- `LS_pca_workbench_views copy/` holds real participant-derived data — **gitignored,
  never commit** (it has never entered git history).
- Demo data is Fisher's iris from the **UCI** repository (`bezdekIris.data`,
  doi.org/10.24432/C56C76) in `frontend/public/demo/`; source, both checksums and a
  reproduction command live beside it in `iris.SOURCE.md`. It replaced the Kaggle mirror
  on 2026-08-05: that copy carries UCI's documented errata in rows 35 and 38, which moved
  PC1 from 72.96% to 72.77% and read as an eigensolver bug. Don't "helpfully" swap it back.
- Only the Supabase **anon** key is in env/bundle (public by design); `service_role`
  must never appear anywhere.

## Outstanding

1. ~~Unit tests are not in the repo~~ **Done (2026-08-02), extended (2026-08-05 and
   2026-08-11):** 20 suites / 316 cases in `frontend/src/lib/__tests__/` (vitest). CI
   (`.github/workflows/tests.yml`) now runs `vitest`, `tsc --noEmit`, `next build` and a
   lint gate — it used to run vitest alone, so a type error or a broken build reached the
   preview deployment before it reached CI (finding E3).
2. **Methods library editorial pass** (`src/lib/methods.ts`): content synthesized from
   model knowledge + the NYU CDS Lab 13 notebook, with named citations. The intended
   vetting step is a ten-minute read/edit by Corina — **still not done**, and now more
   visible: these chunks are rendered verbatim on the new About page, not just retrieved
   by the assistant. (The unbalanced parenthesis in `loadings_vs_scores` was fixed as part
   of A8, along with naming which loadings convention the app reports.)
3. ~~Local dev machine is severely degraded~~ **Very likely solved (2026-08-13):**
   a stray `package-lock.json` in the home directory made Next infer `~` as the
   workspace root, so Turbopack watched/cached against the whole home directory —
   observed concretely as `globals.css` edits never reaching the served CSS chunk
   even across server restarts. `turbopack.root` is now pinned in
   `next.config.ts`; after `rm -rf .next`, cold start measured **~10 s** and
   incremental compiles under 3 s on the same machine. If local dev misbehaves
   again, check for new stray lockfiles above the repo before blaming hardware.
4. **Supabase table has test junk** to delete: rows with `model = 'setup-test'` and
   `model = 'mock/model'`. Free-tier projects pause after ~1 week idle (restore from
   dashboard). Write-only anon key means spam inserts are possible — acceptable at this
   scale; revisit (edge-function rate limit) if it ever matters.
5. ~~2D zoom/pan is not assistant-controllable~~ **Done (2026-08-02):** `control_view`
   now covers both modes — in 2D, `zoom` scales the visible x/y window around its
   centre, `pan` (left/right/up/down, `pan_amount` as a fraction of the span) slides
   it, and `reset_camera` refits to all points. The viewport lives in `range2d` state
   (null = autorange), is applied to the active view only (pinned views are framed on
   their own columns), and now also captures the user's own mouse zoom via
   `onRelayout` — previously any re-render snapped a manual 2D zoom back to full
   extent. Persisted in workspaces and carried into the HTML export, mirroring `camera`.
6. ~~Roadmap file has one stale unchecked item~~ **Done (2026-08-02):** the
   upload-error item is checked off (the "Ask the assistant about this error" chip).
7. **Portfolio writeup** was delivered as a file (not in repo); its "in progress" line
   about the assistant is now outdated — update before publishing.
8. **Assistant "show me *that* region" (Corina's idea, 2026-08-02)** — the natural next
   step past directional pan. Two halves, useful separately:
   - *Center + frame:* let the assistant name a region in data coordinates and have the
     plot centre on it and draw around it (a box/ellipse annotation, the plot-space
     sibling of `highlight_ui`'s sidebar ring). 2D is straightforward — Plotly shapes
     plus an explicit x/y range, and `range2d` already exists to hold the framing. 3D is
     the harder half: no shape layer in `scene`, so it likely means a wireframe-box
     mesh trace plus aiming `camera.center`.
   - *Highlight by rule:* recolor points matching a condition — e.g. "everything with
     positive PC1, PC2 and PC3" — rather than by a column. Cuts across the current
     `colorBy` model, so it probably wants a transient "selection" overlay trace (or a
     synthetic boolean column) that leaves `colorBy` intact and clears on the next turn.
     Would pair well with the undo snapshot already taken per mutating turn.
9. **Clustering: the gap is inputs, not algorithms (reviewed 2026-08-02).** Two findings
   worth acting on before any new method is added:
   - ~~No standardization.~~ **Done (2026-08-02):** "Standardize variables (z-score)"
     checkbox in the Cluster section + `standardize` param on `run_clustering`.
     Smart default by data regime (`suggestStandardize` in `cluster.ts`): OFF for
     PC scores (variance ordering is the point) and shared-scale columns (variance
     is signal — Corina's call, deliberate), ON for mixed scales (range ratio > 3).
     Scaling happens at the call site via `zscoreCellColumns`, and `suggest_k` /
     `suggest_eps` scale the same way so diagnostics match the run (eps in SD units
     when on). Persisted in workspaces/undo; methods chunk `standardize_clustering`
     (Milligan & Cooper 1988; Everitt et al. 2011; Jolliffe 2002) documents the
     three regimes; vitest suite `cluster.test.ts` proves the dominance behavior.
   - *Axes are the feature selection.* Clustering runs on the 2–3 **plotted** columns
     ([page.tsx](frontend/src/app/page.tsx) `handleCluster`). Fine for PC axes; weak for
     two arbitrary raw ones. Letting users pick cluster variables independently of the
     plotted axes is the bigger win.
   Methods ranked by fit, if one is added anyway: **Ward agglomerative** (~60 lines,
   deterministic, one run yields every k plus a dendrogram — best pure fit to the
   `(number|null)[][] → string[]` contract); **Gaussian mixtures/EM** (elliptical
   clusters, soft assignments that could drive opacity or the new shape channel, BIC as
   a companion to the silhouette `suggest_k`); **k-medoids + Gower** (mixed
   numeric/categorical, so survey categoricals become clusterable — but needs the
   decoupled-variables work first); **HDBSCAN** (removes `eps`, the most annoying
   parameter, but 250–400 lines and no small JS implementation worth trusting).
   Ruled out: spectral (needs an n×n Laplacian eigendecomposition; the Jacobi solver in
   `pca.ts` is O(n³) per sweep and would hang the tab) and affinity propagation.
10. **Possible future directions** discussed but not committed: embeddings-based RAG for
   user-supplied papers (only worth it beyond the curated corpus), OpenRouter spend-limit
   note in settings, silhouette/elbow charts in the Cluster section UI.
   Also discussed 2026-08-02 (design agreed, not yet started): assistant **provenance
   tags** — every methods claim labeled with its source (methods reference / web / model
   knowledge), parsed into the feedback rows so calibration becomes measurable against
   thumbs data; **web lookups** via OpenRouter's `:online` model suffix as an opt-in
   settings toggle (no backend needed; preferred over verbalized confidence scores,
   which are known to be poorly calibrated).
12. **PCA run naming (2026-08-02, replaces the "PCs clobber each other" bug).** Corina's
   workflow is per-subset PCAs on one dataset (Big 5 → top PC, sensation seeking → top
   PC, then per-trait subsets) — and `runPCA` used to delete every `^PC\d+$` column on
   each run, eating earlier subsets. Now: runs carry a **label** (auto-suggested from
   shared variable-name affixes via `deriveRunLabel`; the field invites naming when
   underivable). Naming: `COMP_<label>` for k=1 (composite-score workflow; k=1 newly
   allowed everywhere), `PC1_<label>`… for k>1, bare `PC1..PCk` when unlabeled.
   **Identity = label**: re-running a label replaces exactly its own columns (both
   shapes, in case k changed) after a confirm dialog with "don't ask again"
   (`scatterlab.pca.confirmReplace`); different labels coexist; the assistant path
   skips the dialog but reports replacements in the tool result. Provenance lives in
   a per-dataset `pcaRuns` registry (variables, k, standardize, timestamp, variance
   explained) — in workspaces automatically, exposed via `get_app_state`. Detection
   regexes widened to `^PC\d+(_|$)` (PCA input exclusion, standardize heuristic);
   COMP_ columns stay selectable as PCA inputs (second-order PCA) and are treated as
   ordinary variables by the standardize default — deliberately, since composites
   from different decompositions have no shared variance ordering. k=1 runs land on
   the X axis and leave Y/Z alone (build several composites, then plot them against
   each other). Tests in `pca.test.ts` cover label derivation, coexistence,
   scoped replacement, and sanitization.
11. **Feedback queue robustness — RESOLVED (2026-08-02); the "incident" was a
   misdiagnosis.** The originally reported duplication incident did not happen:
   inspection of the live table (all rows, pre-deploy) found zero byte-identical
   duplicates. What the cross-project review had read as dupes was the two-row
   design itself — each rated event holds a metadata-only row (`reason` NULL) plus,
   when the user typed into the "why" box, a reason row sharing `event_id` and
   `rating`, landing seconds-to-minutes later. The dedupe delete in
   `supabase/dedupe_assistant_feedback.sql` was therefore **never run** (preview
   matched nothing); the file stays as reference tooling. Its identity columns
   matter if it's ever used: matching must include `reason` and `user_message`, not
   just `event_id` + `rating`, or the delete would eat every legitimate
   metadata+reason pair.
   The code hardening shipped anyway, and rightly so — the at-least-once races
   (shared IndexedDB queue behind a per-tab `flushing` guard; POST landing right
   before tab close losing its queue-delete) are real code paths that simply hadn't
   fired. All landed 2026-08-02 (`7ac7f03` + `16d016d`, deployed; migration
   `20260802000000_feedback_idempotency` applied — `client_key` + unique index +
   `source_app`):
   - `client_key` stamped at enqueue, `on_conflict=client_key` +
     `Prefer: resolution=ignore-duplicates` → redelivery is a server-side no-op;
   - Web Lock serializes flushes across tabs; `pagehide` flush with `keepalive`;
   - per-row fallback on batch rejection with attempts counter (drop after 5
     server rejections; network failures stay queued free), and a pre-migration
     bridge — note `16d016d`: the bridge must strip `client_key` from the request
     BODY, not just drop `on_conflict` (PostgREST rejects unknown body columns).
   Verified fine on review: insert-only RLS (`ON CONFLICT DO NOTHING` needs no
   SELECT), the two-row `event_id` pattern with the `distinct on` analysis query,
   and metadata-only rows without consent.
13. ~~Pin View blocks the UI; pins cannot be zoomed or panned~~ **Both done (2026-08-11).**
   Measured before touching anything: pinning cost **1312 ms** from click to paint on the
   iris demo (259 ms inside the handler, then a 933 ms task) — the reported 296 ms was the
   handler alone. The work is irreducible (a new pane means a new Plotly WebGL context, and
   every existing pane resizes into the re-split grid); what was wrong is that it was
   *urgent*. `pinCurrentView`/`removePin` now wrap their `setPinnedViews` in a
   **transition**, so the browser paints the click before the pane is built rather than
   after, and the button reads "Pinning…" while it happens. The pin object is still built
   synchronously — it reads the live camera off the plot div, which must be its value at
   click time. Also: `ResizeObserver` fires once the moment it starts observing, so a
   freshly-mounted pane was resizing itself to the size Plotly had just laid it out at, in
   the same frame as every real resize; that first callback is skipped now.
   **Result: 1312 ms → 40 ms, and 696 ms → 16 ms on the second pin.** The long tasks remain
   (488 ms) but no longer sit between the click and the paint.

   The zoom/pan half had a cause worth remembering: **every pane shared one `onRelayout`
   that wrote into the LIVE `camera`/`range2d`**, while pinned panes rendered from
   `view.camera`/`view.range2d`. So dragging a pin rotated the live plot and left the pin
   where it was — pins looked frozen because interacting with one moved something else.
   `ViewPlot` now passes its own `view.id` with the event and the handler routes the update
   to the pane that fired it. Reading the payload moved into `lib/relayout.ts`
   (`readRelayout`) and is unit-tested: Plotly reports a camera move, a box-zoom, and a
   double-click reset (`autorange`, sometimes one axis only) through the same event, and a
   partial range must be dropped rather than half-applied — `{x: [...], y: [undefined,
   undefined]}` blanks the plot. Browser-verified in both modes: the pin rotates/zooms
   alone, the live view is untouched, double-click resets only the pane clicked, and a pin
   holds its new angle across an unrelated live re-render.
14. **Open questions from the walkthrough (2026-08-11), all small, none blocking.**
   - **The consent dialog fires on a re-run even when the only dataset is the Iris demo.**
     It cannot tell "the demo you just toured" from "a file you happened to name iris.csv",
     and `loadDemoData` already treats `name === 'iris'` as the demo for its own
     idempotence — so suppressing it is a one-line check against that same convention.
     Left in because showing the warning is the safe direction and Corina had not called it.
   - **Pinning still produces a ~490 ms long task**, just no longer between the click and
     the paint. What remains is Plotly building a WebGL context per pane plus the survivors
     resizing; reducing it means touching how panes are created, not when.
   - **2D pinned panes take the live `camera` as a layout dependency** (`view.camera ??
     camera`, and `view.camera` is null in 2D), so dragging the live 3D view invalidates
     every 2D pin's layout memo and re-plots it. Harmless — the camera is unused in 2D — but
     it is free re-plotting. Pre-existing; noticed while routing relayout per pane.
   - **`useMemo` is imported and unused in `AssistantPanel.tsx`**, one of the 123 lint
     problems the gate now pins.

## Working on it

```
cd frontend && npm install && npm run dev     # http://localhost:3000
cp .env.local.example .env.local              # fill Supabase values to enable feedback
```

Push to `main` deploys production. LocalStorage keys are all namespaced
`scatterlab.*`; workspaces and the autosaved session in IndexedDB `scatter-lab`
(stores `workspaces` / `session`, DB version 2); feedback buffer in IndexedDB
`scatter-lab-feedback`.
