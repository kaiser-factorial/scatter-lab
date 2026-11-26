# Scatter Lab

See the shape of your data. Scatter Lab is a browser-based workbench for
exploring tabular datasets as interactive 2D/3D scatter plots — built for
survey and questionnaire research, useful for any table of numbers.

**Live:** [scatter-lab.vercel.app](https://scatter-lab.vercel.app)

**Default analysis runs on your computer.** Opening a CSV, XLSX or Parquet file
reads it into the browser; parsing, PCA, browser-CPU EFA, clustering and statistics
do not submit that file to the website's hosting server. Saved workspaces use
browser storage. The hosting server delivers the app's code and assets; it does
not need the dataset to run those calculations.

The app's compute options are Browser CPU and WebGPU. WebGPU uses the GPU exposed
by your browser on this computer. The optional assistant and feedback can send
information to configured services.

| Feature | Where computation or storage happens | What is sent |
| --- | --- | --- |
| File import, default CPU analysis, saved workspaces | Browser memory, local workers and IndexedDB | File contents stay in these local paths; normal app/asset requests still reach the hosting server. |
| WebGPU WLSMV trace acceleration | Local GPU through the browser and graphics driver; other stages use browser workers | Numerical buffers move to the local GPU. This calculation does not use a cloud GPU service. |
| Assistant | Configured model endpoint | Your chat, dataset/column metadata, permitted aggregate results, app guidance and any retrieved package excerpts. App tools withhold respondent rows; typed chat is not automatically redacted. |
| Assistant with a local endpoint | The runtime configured at that endpoint | The same permitted context goes to the local runtime. Its own configuration determines whether inference is local; this does not disable feedback or other browser requests. |
| Optional feedback | Configured Supabase feedback service | A clicked rating sends rating/model/tool metadata. Sending an optional reason can also include your message and the reply; the visible “Include this exchange” checkbox starts checked. Queued feedback may retry later. |
| Data, plot and workspace exports | Browser-generated downloads | Files are saved through your browser, with no app-managed upload. Data/workspace exports can contain raw data; sharing the resulting file is a separate action. |

OpenRouter sign-in, model-list requests, external links and rendered remote
Markdown images can also cause network requests. A local analysis path is not a
claim that the entire page is network-isolated. See the [data-flow details and
source references](docs/DATA-FLOW.md) and
[assistant settings](#the-assistant-optional-bring-your-own-key).

Scala/JVM comparison code is retained as development reference material. It is
not an application compute option and does not require users to install or pair
a local JVM service.

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
- **Likert EFA** — two-step polychoric/tetrachoric correlations, MINRES and
  oblimin, promax or varimax rotation in browser workers. Review category
  orders, missingness and items; save refits, compare rotations or holdout
  structure replication, and explicitly add approximate factor scores.
  [Methods, qualification and reproduction](docs/EFA.md) include independent
  pinned R references and the 500-item × 20,000-respondent browser benchmark.
- **Clustering** — DBSCAN and K-Means (k-means++, deterministic) with live
  parameter sliders, per-cluster composition breakdowns, and diagnostics
  (silhouette-by-k, k-distance percentiles for eps). Save composition heatmaps
  as PNGs in Viridis, Inferno, or Greens, with a 0–100% colour-scale legend.
- **Compare views** — pin up to 4 views in a tiled grid. A pin keeps the data
  and framing it was taken with while the live view moves on, but stays fully
  interactive: rotate, zoom or double-click any pane to reset that pane alone.
  Transfer columns (e.g. cluster labels) between datasets by row order or key
  match, with alignment guards
- **Exports** — PNG, rotating GIF, or a fully self-contained interactive HTML
  file that works offline
- **Workspaces** — sessions persist locally (IndexedDB) and export/import as
  shareable files
- **Two themes** — Bauhaus and Terminal

## Two ways in: a guided walkthrough, or the assistant

**Load demo** on the opening screen is the short way in: one click loads the Iris
data and opens the panel. Select **Begin demo walkthrough** when you’re ready.
The triangle beside a status line opens its details. Opening the assistant
panel directly also offers the guided walkthrough.

**The guided walkthrough** has two chapters, with no API key or model calls.
First, each Iris dot is a flower: project its four measurements onto principal
components, cluster the scores and compare the views. Next, import a bundled
synthetic ordinal survey without removing Iris. Fit two factors, inspect the
item loadings, then plot each simulated respondent's estimated factor scores.
Both chapters use the real parser and analysis actions. Uploading is paused
while the tour runs; it never saves a file to your device automatically. If a dataset
of yours is already loaded it says what it is about to change and offers to save a
workspace first, and the state you had is one click away afterwards.

The message box is disabled throughout — the buttons take you through, **Exit
demo** sits on the end of that row, and a step list below the transcript shows
where you are and what is left.

The steps live in `frontend/src/lib/walkthrough.ts` as data, so the tour is the
same every time and a broken step is a failing test rather than a dead end.

**Share an analysis:** In **Export → Analysis record**, preview the masked
summary or explicitly review the exact settings needed for reconstruction.
Download the JSONL, Markdown and `SHA256SUMS.txt`. Give your teammate the
original input separately and retain a trusted copy of the checksums. From the
download directory, `shasum -a 256 -c SHA256SUMS.txt` checks the two records
against that copy; it does not prove who created them. Older workspace traces
may lack settings and are not upgraded into guessed reconstruction steps.

## The assistant (optional, bring-your-own-key)

An in-app AI copilot that drives the workbench through tool calls: assign axes,
run PCA and clustering, read cluster compositions, configure and save their
heatmaps, scatter exports, or a rotating 3D GIF, compute correlations and group
comparisons, tour your own data — and literally point at the interface with an
ephemeral highlight while explaining it. Interpretation questions are grounded in
a curated, citation-backed methods reference that ships with the app. Asked for a
demo, it offers the scripted walkthrough above rather than improvising one.

- **Implementation knowledge:** a compact app guide and relevant implementation
  notes are injected automatically. The assistant can also search and read
  numbered source excerpts from `@scatterlab/stats` and its package documentation
  shipped with the build. The inspectable snapshot is limited to that package;
  app guidance remains authored context. These read-only tools use a local,
  versioned snapshot, with no embedding service or access to user files.
  See [assistant reference scope and verification](docs/ASSISTANT-REFERENCE.md).
- **Correlations:** ask for Pearson, Spearman, or Chatterjee's ξ between any two
  numeric variables. The `correlate` tool returns all three, with Chatterjee's ξ
  in both directions, using pairwise-complete observations under the active row
  filter. Predictor ties are averaged over all orderings for reproducible
  results. These are descriptive coefficients; no p-value or confidence interval
  is computed.
- **One-click OpenRouter connect** (OAuth PKCE) or paste any key; any
  OpenAI-compatible endpoint works, including local runtimes such as Ollama.
  Keys are stored in your browser and sent to the chosen endpoint for
  authentication. A local model endpoint does not disable other network paths.
- **Privacy contract:** Dataset tools expose permitted column metadata and
  aggregate statistics, with small-group/category suppression and no raw rows.
- **Undo** for anything the assistant changes; optional thumbs-up/down feedback
  per reply is submitted to the configured Supabase feedback store, with a
  separate optional reason/exchange step.
- Dockable right/bottom or floating, resizable, markdown-rendering chat

## Methods, stated in the app

The choices the app makes on users' behalf are
written into the interface: small **(i)** markers next to the controls they
apply to, and an **About** page reachable from the header. Both read from one
source (`src/lib/disclosures.ts`). The assistant's guide and source references
also need to be kept current as implementations change. They cover the things that change
an answer — that K-Means here is the deterministic variant, that clustering runs
on the plotted axes only, what standardizing does, and which of the two
conventions the reported loadings follow.

## Development

Use Node 24 and pnpm 12.18.0, as pinned by the workspace. Install once from the
repository root; this covers the frontend, statistics package and local adapters.

```bash
pnpm install --frozen-lockfile
pnpm run build:stats
dev start frontend --detach --json --yes  # prints the ready URL
pnpm run check     # library, app, numerical references and packed consumer
pnpm --dir frontend run build  # production build
```

If `pnpm` is missing or runs another version, substitute
`npx --yes pnpm@12.18.0` for `pnpm` in these commands; for example,
`npx --yes pnpm@12.18.0 install --frozen-lockfile`. This does not change the
globally installed package manager. There is one root
`pnpm-lock.yaml`. Multiple `node_modules` directories remain normal: pnpm shares
package contents and creates links for each workspace package's dependencies.
They are not three independent copies of the app's dependency tree.

The app consumes the local [`@scatterlab/stats`](packages/statistics/README.md)
package. Its public API separates fitting from scoring new rows, retains full
precision and training preprocessing, and has no Next.js, React or R runtime
dependency. The frontend keeps workspace state, workers, browser compute controls,
assistant policy and UI formatting. During development, library source changes
rebuild automatically and Next reloads the emitted modules.

CI checks both library and app, numerical reference coverage, source contracts,
production builds and newly introduced lint findings. See [CI.md](docs/CI.md)
and [the library architecture](docs/STATISTICS-LIBRARY.md) for commands and scope.
[Deployment setup](docs/DEPLOYMENT.md) documents the workspace installation and
Vercel build configuration; [dependency maintenance](docs/DEPENDENCIES.md) records
the current versions, compatibility constraints and local adapter provenance.

Feedback storage is env-gated: copy `frontend/.env.local.example` to
`frontend/.env.local` and
fill the Supabase values to enable it (unset = feedback UI hidden). Pushes to
`main` deploy to production via Vercel; tests run in GitHub Actions.

Built with Next.js, Plotly (WebGL), Tailwind CSS, PapaParse, SheetJS, and
hyparquet. See [HANDOFF.md](HANDOFF.md) for architecture and the
[teammate-ready EFA roadmap](docs/TEAMMATE-READY-EFA-ROADMAP.md) for release gates and follow-up branches.

The original FastAPI/pandas backend (removed in the client-side migration)
lives in git history for reference.
