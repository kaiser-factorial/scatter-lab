# Scatter Lab

See the shape of your data. Scatter Lab is a fully client-side workbench for
exploring tabular datasets as interactive 2D/3D scatter plots — built for
survey and questionnaire research, useful for any table of numbers.

**Live:** [scatter-lab.vercel.app](https://scatter-lab.vercel.app)

**All computation runs locally in the browser.** Parsing, PCA, clustering,
statistics, and persistence all happen in the tab, and your dataset is never
uploaded to a server. There is no backend; the app deploys as a static site.

The one exception is the optional AI assistant. If you connect an API key,
column names and aggregate summaries — never raw rows — are sent to whichever
provider that key belongs to. See
[The assistant](#the-assistant-optional-bring-your-own-key) below; leave it
disconnected and nothing leaves the tab at all.

## Demo data

The built-in demo is Fisher's iris data, taken from the UCI Machine Learning
Repository's `bezdekIris.data` ([doi.org/10.24432/C56C76](https://doi.org/10.24432/C56C76)).

The file matters more than it sounds. The widely-mirrored Kaggle copy carries
UCI's documented errata in rows 35 and 38, which is enough to move the first
principal component from 72.96% to 72.77% — a difference that reads as a bug in
the eigensolver rather than a difference in the data. `bezdekIris.data` is the
corrected version, and the app's PCA now agrees with R's `prcomp` to four
decimal places. Provenance, both checksums and a one-line reproduction command
are in
[`frontend/public/demo/iris.SOURCE.md`](frontend/public/demo/iris.SOURCE.md).

## Features

- **Drop in CSV, XLSX, or Parquet** — every column is profiled automatically
  (type, range, missing values, live mini-histograms) with one-click X/Y/Z/color
  assignment from the Variables panel. Smart first-view defaults avoid explicit
  ID columns and prefer a small non-boolean categorical grouping for colour.
  Multi-sheet workbooks offer a sheet picker, and a sheet with no data rows is
  skipped rather than reported as empty.
- **It tells you what it did to your file** — ragged rows, unterminated quotes,
  duplicate or blank headers, numbers written with decimal commas or thousands
  separators, and dates read as text are all reported rather than silently
  absorbed. Nothing is auto-corrected.
- **It finds missing-value codes, and says how sure it is** — SPSS and Qualtrics
  write "don't know" and "refused" as ordinary numbers (`-99`, `-999`, `9999`,
  or a 9 on a 1–7 item), and a CSV carries no sign of it. Three rules look for a
  wrong sign, a value far outside its column, and a hole in a short scale; each
  finding is labelled certain, likely or possible. A cross-column check reports
  whether the *same respondents* carry the code across a battery of items — the
  signature of a Don't Know block — and says how much more often than chance.
  You can also declare the codes your survey used, which is matched literally.
- **Blanking them is per column, and it shows its work** — the same 9 can be a
  code in a Likert item and a real age in the next column, so the choice is
  yours per column, with boxes pre-ticked only where the evidence is strong.
  Every recode reports cells blanked, n before and after, and the shift in mean
  and sd, and asserts that everything it did not target is unchanged.
- **In-app PCA** — pick variables, pick components, run: a browser-side
  eigensolver produces scores, loadings, and a scree chart (correlation- or
  covariance-based). Missing values can be median-imputed, reconstructed by
  regularized iterative PCA (the missMDA `imputePCA` method), or dropped
  complete-case; every run reports exactly what it filled or dropped, and in
  which variables. A precomputed components/loadings file works too, and now
  says how much of itself it actually matched
- **Clustering** — DBSCAN and K-Means (k-means++, deterministic) with live
  parameter sliders, per-cluster composition breakdowns, and diagnostics
  (silhouette-by-k, k-distance percentiles for eps). Save composition heatmaps
  as PNGs in Viridis, Inferno, or Greens, with a 0–100% colour-scale legend.
- **Compare views** — pin up to 4 views in a tiled grid; transfer columns
  (e.g. cluster labels) between datasets by row order or key match, with
  alignment guards
- **Exports** — PNG, rotating GIF, or a fully self-contained interactive HTML
  file that works offline
- **Workspaces** — sessions persist locally (IndexedDB) and export/import as
  shareable files
- **Two themes** — Bauhaus and Terminal

## Two ways in: a guided walkthrough, or the assistant

Opening the assistant panel for the first time offers a choice.

**The guided walkthrough** is a scripted, click-through tour of the Iris demo —
eight steps, one button at a time, no API key and no network. It drives the real
workbench as it goes (loads the data, runs the PCA, clusters the scores, pins a
comparison) and points at each control with a highlight that holds until you move
on. The composer is disabled while it runs, uploading is paused, and it never
starts a download. If a dataset of yours is already loaded it says what it is
about to change and offers to save a workspace first, and the state you had is
one click away afterwards.

The steps live in `frontend/src/lib/walkthrough.ts` as data, so the tour is the
same every time and a broken step is a failing test rather than a dead end.

## The assistant (optional, bring-your-own-key)

An in-app AI copilot that drives the workbench through tool calls: assign axes,
run PCA and clustering, read cluster compositions, configure and save their
heatmaps, scatter exports, or a rotating 3D GIF, compute correlations and group
comparisons, tour your own data — and literally point at the interface with an
ephemeral highlight while explaining it. Interpretation questions are grounded in
a curated, citation-backed methods reference that ships with the app. Asked for a
demo, it offers the scripted walkthrough above rather than improvising one.

- **One-click OpenRouter connect** (OAuth PKCE) or paste any key; any
  OpenAI-compatible endpoint works, including local runtimes (Ollama) for a
  fully offline assistant. Keys live in your browser only
- **Privacy contract:** requests carry column names and aggregate statistics —
  never raw data rows. A categorical value is only named if it covers at least
  five rows, so an email address, a participant name or a free-text answer is
  counted but never sent
- **Undo** for anything the assistant changes; optional thumbs-up/down feedback
  per reply (stored write-only, used to improve the assistant)
- Dockable right/bottom or floating, resizable, markdown-rendering chat

## Methods, stated in the app

Because users never see the code, the choices the app makes on their behalf are
written into the interface: small **(i)** markers next to the controls they
apply to, and an **About** page reachable from the header. Both read from one
source (`src/lib/disclosures.ts`), so a tooltip, the About page and the
assistant's own reference cannot drift apart. They cover the things that change
an answer — that K-Means here is the deterministic variant, that clustering runs
on the plotted axes only, what standardizing does, and which of the two
conventions the reported loadings follow.

## Development

```bash
cd frontend
npm install
npm run dev        # http://localhost:3000
npx vitest run     # unit tests
npx tsc --noEmit   # types
npx next build     # production build
```

CI runs all four on every push and pull request, plus a lint gate that allows
the existing warning count to fall but never rise.

Feedback storage is env-gated: copy `.env.local.example` to `.env.local` and
fill the Supabase values to enable it (unset = feedback UI hidden). Pushes to
`main` deploy to production via Vercel; tests run in GitHub Actions.

Built with Next.js, Plotly (WebGL), Tailwind CSS, PapaParse, SheetJS, and
hyparquet. See [HANDOFF.md](HANDOFF.md) for architecture and project state.

The original FastAPI/pandas backend (removed in the client-side migration)
lives in git history for reference.
