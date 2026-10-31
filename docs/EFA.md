# Likert EFA in Scatter Lab

The EFA workflow runs entirely in browser Web Workers beside the existing PCA workflow. R generates independent development references; no R runtime, server or assistant provider is needed to fit an analysis.

## Workflow

1. Load a dataset, apply any row filter, and choose **EFA** in **PCA / EFA**.
2. Select items and review category orders and reverse keys. Ascending numeric orders are proposals. Text responses require an explicit JSON order, such as `["Disagree", "Neutral", "Agree"]`. Blank/null cells stay missing; deliberately recode questionnaire-specific missing codes before fitting.
3. Set extraction, factor count, rotation, missing-data policy, label and sample. Defaults are MINRES, oblimin, pairwise deletion and all eligible respondents. DWLS and WLSMV are selectable; WLSMV preview includes its exact-inference allocation and work estimate. **Preview sample** shows fitting counts and category counts; setup changes require another preview.
4. Run EFA. The wide results pane starts with loadings. Other views include structure, factor correlations, residuals, polychoric correlations, pairwise sample sizes and diagnostics. The item table virtualizes visible rows, with search and sticky identifiers.
5. Mark items **retain**, **investigate** or **exclude**, and record notes. Primary/secondary absolute loadings, their gap, communality and the strongest related-item correlation support review. Adjustable flags never automatically assign membership or remove items.
6. **Refit selection** saves a child run and retains the baseline. Keeping original fitting respondents is offered by default. Under complete-case deletion, removing items can admit respondents; comparisons report changed membership and pairwise counts.
7. Compare rotations using the same unrotated extraction. Other changes require a refit. Comparisons match shared-item patterns by order and signs, preserve baseline ordering and shared color scales, and report unmatched factors and changed coverage. No further Procrustes rotation is used.
8. **Add scores to dataset** explicitly creates owned, collision-safe columns such as `FA1_Likert_r1`, available to scatterplots, clustering and dataset exports. Incomplete/excluded respondents receive nulls. Loading CSV includes pattern, structure, communalities, uniquenesses and notes; complete JSON includes specification, results, membership, diagnostics and provenance.

Pattern and structure heatmaps are enabled by default, with a common coefficient scale across both matrices and compared runs. Values remain visible without a heatmap. Loading scales are zero-centered and expand beyond ±1 when necessary. Correlations use −1 to +1; residual comparisons share their actual range. CSV/JSON preserve full precision.

## Numerical conventions

| Stage | Convention |
|---|---|
| Preparation | 3–500 explicitly ordered items; column-major `Uint16Array` ranks and separate `Uint8Array` observation mask; source cells never reverse-keyed in place |
| Correlations | Two-step polychoric, including tetrachoric for binary pairs; pair-specific observed margins and normal thresholds, then bivariate-normal likelihood optimization with `maxcor=.9999` |
| Extraction | MINRES lower-triangle squared residual objective; analytic spectral gradient; projected BFGS; choose the lower initial objective from SMC and unit uniqueness when both starts admit the requested rank; iteration budget `max(500, 4 × item count)`; optimized uniqueness bounds `[.005, 1]`; projected-gradient criterion `1e-8` |
| Rotation | Unnormalized oblimin delta/gamma 0; normalized varimax; promax power 4 using normalized varimax; deterministic seeded starts and best converged objective |
| Outputs | Pattern Λ, structure ΛΦ, factor correlations Φ, common reproduced matrix ΛΦΛ′, communalities from its diagonal, uniquenesses `1 − h²`, off-diagonal residuals and RMSR |
| Scores | Solve `R × W = structure`; multiply complete ordinal-rank responses standardized with fitting-sample item means/sample SDs by W |
| Parallel analysis | Explicit batch; default 100 seeded within-item permutations with fixed missingness masks; 95th-percentile reference; one-factor MINRES communalities on the diagonal for both observed and null spectra |

References: [polycor](https://cran.r-project.org/web/packages/polycor/polycor.pdf), [psych factor analysis](https://www.personality-project.org/r/psych/help/fa.html), [psych parallel analysis](https://www.personality-project.org/r/psych/help/fa.parallel.html), [R varimax/promax](https://stat.ethz.ch/R-manual/R-devel/library/stats/html/varimax.html), and the pinned GPArotation package.

Empty category margins within a pair are omitted from its likelihood, as in polycor, while original orders and observed-level indices remain recorded. This does not merge categories. Sparse cells, near-boundary correlations, optimized uniqueness bounds, improper communalities and matrix conditioning are reported. Unestimable pairs, constant items, invalid orders, underidentified counts, nonconvergence and singular/indefinite matrices stop the job. Minimum eigenvalues at most `1e-8` are rejected. Pair contingency tables are limited to 4,096 declared cells. There is no automatic smoothing, imputation, merging or estimator substitution.

Scores are ordinal linear regression approximations, not EAP/MAP estimates. Correlated factors do not receive PCA-style additive variance percentages. Failed null replicates remain in parallel-analysis results; any failure suppresses the definitive factor-count suggestion. If all fail, reference values are null. A complete 100-permutation 500-item × 20,000-respondent batch passed in the recorded environment; it took 55.4 minutes, substantially longer than one fit.

## Splits and history

Create a saved seeded split (initial 70/30 proportion), optionally grouping and stratifying, or use two values in an existing split column. Groups stay together; a group spanning strata is rejected. Actual row membership survives item edits. The current filter and partition apply before thresholds, correlations, scaling and scoring.

**Compare on holdout** freezes a development specification and independently refits the saved holdout. This is labeled **structure replication**, with visible failures and no “validated” badge. History records prior full-sample PCA/EFA fits, actual opening of holdout results, and later revisions. These records cannot establish that data were never viewed in another plot, application or analysis.

## Implementation map

- `frontend/src/lib/efa/types.ts`: typed specifications, prepared data, results, runs, splits and simulations.
- `prepare.ts`, `correlation.ts`, `extraction.ts`, `rotation.ts`, `fit.ts`, `parallel.ts`, `compare.ts`: isolated numerical functions.
- `efa.worker.ts`, `service.ts`: asynchronous jobs, result retrieval, progress and cancellation. Up to four workers, bounded by hardware; correlation batches contain 64 pairs. Simulation replicates run across the bounded, terminable pool.
- `controller.ts`: common UI/assistant orchestration, generation/table/filter guards, lineage, reviews and score publication.
- `state.ts`, `persistence.ts`: membership, score ownership, CSV and import validation. Workspace format 2 saves EFA runs, splits, simulations, separate imputation analyses and resampling results; format 1 imports with empty EFA state.
- `frontend/src/components/EfaPanel.tsx`: setup, virtualized results and comparisons. `page.tsx` connects the existing analysis gate, undo and persistence. Existing PCA numerical code is unchanged.

Jobs snapshot specifications, membership and selected columns. SHA-256 fingerprints include encoded responses, missingness, item transformations and membership. Correlation caches are scoped to immutable table revisions and exact preprocessing/sample settings. Pair reuse after removal requires unchanged actual fitting rows; rotation reuse checks the fingerprint and factor count. Cancelled, failed, superseded, restored or undone jobs cannot publish results or scores.

The original six assistant actions share the controller: `run_efa`, `efa_job`, `get_efa_diagnostics`, `compare_efa`, `add_efa_scores`, `parallel_efa`. Fits/simulations return job IDs. Private results whitelist aggregates and omit respondent membership, scores, thresholds and response combinations. Assistant selections below five respondents, or excluding fewer than five eligible respondents, are rejected; pairwise counts below five also block assistant fitting/simulation. Locally inspecting a result does not permit disclosure of its rare aggregates. The collaboration tools described below extend this controller. Offline replays exercise all ten tools, cancellation and rejection paths without paid calls.

## Independent R qualification

The references were actually generated locally in an isolated Docker R environment. Checked-in input/output fixtures under `frontend/src/lib/__tests__/fixtures/efa/` cover correlated factors, cross-loadings, binary/mixed scales, skew, pairwise/complete-case missingness, reverse keys, and public `psych::bfi` data (1,200 respondents, ten A/C items). No private participant data was used.

The Docker digest pins R 4.5.1. Package pins: polycor 0.8-1, psych 2.5.6, GPArotation 2025.3-1, mvtnorm 1.3-3, mnormt 2.1.1, admisc 0.39, jsonlite 2.0.0. Provenance records versions, input hashes, seeds and settings. Parallel-analysis parity uses four actual saved null datasets, not assumed equivalence between R and JavaScript seeds.

All five fixtures pass these unchanged absolute tolerances for all three rotations:

| Quantity | Permitted difference |
|---|---:|
| Polychoric correlations | `1e-5` |
| Reproduced correlations and communalities | `1e-4` |
| Sign/permutation-aligned loadings and factor correlations | `1e-3` |
| Aligned standardized score outputs | `1e-3` |

The analytic gradient is separately checked against finite differences. Failure tests cover sparse/unestimable pairs, invalid orders/membership, singular/indefinite matrices, boundary solutions, nonconvergence and underidentification. During large-data qualification, a stricter optimizer stopping criterion stalled on a numerically flat objective. The final projected-gradient criterion is `1e-8`; R agreement tolerances were not relaxed and no runtime or extractor was substituted.

`.github/workflows/efa-reference.yml` provides the reproducible R CI job: generate in a network-disabled container, run parity tests and retain reference artifacts. The local delivery does not claim the remote workflow has already run.

## Browser qualification

Measured on 2026-10-31 local time with the updated MINRES engine: Apple M1, eight logical cores, 8 GiB RAM, headless Chrome 156. The synthetic fixture uses seed 8801, 500 five-category items, 20,000 respondents and five factors. This qualifies that fixture on this machine, not every sparsity pattern, factor count or browser.

| Action | Elapsed |
|---|---:|
| Full polychoric + MINRES + oblimin fit | 18.97 s |
| Promax comparison, extraction reused | 1.63 s |
| Varimax comparison, extraction reused | 1.80 s |
| Scoring 20,000 complete responses | 1.77 s |
| Independent 6,000-row holdout refit | 17.09 s |
| Cancellation during correlations | 0.4 ms |

MINRES converged in eight iterations: objective `2.7655124152833572`, projected gradient `1.2566030786725853e-9`. The UI heartbeat advanced during correlation estimation. Peak summed browser-process RSS was 1,347,108,864 bytes (about 1.35 GB), sampled once per second; shared pages may be counted more than once. This is process memory, not an exact JS heap measurement.

The actual full-size result was loaded into the app: 23 table rows rendered, item 500 remained reachable, the heatmap worked, and Escape dismissed the pane without page errors. Evidence is under `frontend/scripts/efa-reference/`: `browser-benchmark.json`, `large-ui-verification.json`, `ui-verification.json`, and screenshots. The workflow check covers both themes, long labels, keyboard navigation, preview/fit, rotations, notes/refits, scores, holdout history, automatic session restoration and named workspaces.

## Reproduction

Release-one commit `1f86b63` passed 512 tests in 38 files, TypeScript, the production build, and the lint regression gate (123 existing problems, zero in new EFA files). The final combined release passes 622 tests with four intentional skips, TypeScript, an isolated production build and the unchanged lint regression gate. The three expensive large-null comparisons passed separately; the fourth skip is the optional Node benchmark. Evidence is in `frontend/scripts/efa-reference/final-qualification.json` and [EFA-EXTENSIONS.md](EFA-EXTENSIONS.md). At the release-one checkpoint the optional Node benchmark was the single skipped test; the full browser benchmark above was executed. `git diff --check` also passed.

From the repository root:

```bash
docker build -t scatter-lab-efa-reference:4.5.1 frontend/scripts/efa-reference
docker run --rm --network none -v "$PWD/frontend/src/lib/__tests__/fixtures/efa:/out" scatter-lab-efa-reference:4.5.1
cd frontend
npm ci
npx vitest run
npx tsc --noEmit
npm run build
npx eslint . -f json > /tmp/scatter-lab-lint.json
dev start frontend --detach --json --yes
node scripts/efa-reference/check-ui.mjs http://localhost:3000
node scripts/efa-reference/build-browser-benchmark.mjs
node scripts/efa-reference/check-browser-benchmark.mjs http://localhost:3000
node scripts/efa-reference/check-large-ui.mjs http://localhost:3000
rm -rf public/efa-qualification
```

The browser scripts use installed Chrome via Playwright's `chrome` channel and isolated contexts. The benchmark writes synthetic data to `/tmp/scatter-efa-large-fixture.json` for the large-table check. Temporary public bundles are ignored and must be removed before a distributable build. The optional `EFA_BENCHMARK=1` Node/Vitest benchmark is separate and intentionally skipped in routine tests. The existing lint ceiling remains 123 problems; new EFA files must be clean.

## Ordinal MICE and resampling extension

Choose **Ordinal MICE** in missing-data setup, review the explicit predictors for each target, and set the number of imputations, sweeps and seed. Ordered-polynomial contrasts are the default; rank predictors are an explicit alternative. The fitting population retains incomplete respondents. Binary targets use logistic coefficient draws; ordinal targets use the pinned `mice.impute.polr` conditional convention. There is no automatic predictor pruning, category merging or multinomial substitution.

Each chain preserves observed cells and produces a separate completed-data EFA. The result pane offers individual pattern/structure heatmaps and descriptive between-imputation means/SDs, iteration traces, factor correlations, diagnostics, substantive notes and exports. These summaries are not Rubin-pooled confidence intervals. **Refit MICE selection** saves a child analysis, retains the original rows, remaps the explicit predictor sets and reruns the separate chains. It does not overwrite the source table. MICE-specific factor-score pooling is not implemented; **Add scores** currently applies to individual observed-data EFA runs. Working-set estimates reduce parallelism for wide predictor designs; one model can still exceed that estimate. A full-size execution check passed 500 items × 20,000 respondents with four explicit predictors per item, two imputations and one sweep (100.1 s; cancellation 0.5 ms). This is not chain-convergence or recovery evidence, and does not qualify models using all 499 other items as predictors or the default 20-by-10 batch. See `large-imputation-benchmark.json`.

Saved ordinary EFA runs expose **Resampling stability**. Choose respondent or whole-group bootstrap, the number of resamples, seed, percentile level and cross-loading threshold. Every resample refits correlations, extraction and rotation. Factors are matched by signs and permutation only. Results retain the actual resampled memberships, failures, per-item pattern/structure intervals, communalities, uniquenesses, primary-factor agreement and cross-loading frequencies. The denominator is the displayed successful-refit count; any failed replicate makes summaries provisional. Boundary and improper solutions are counted and retained. This is not nested MICE/bootstrap pooling.

The MICE/stability/parallel-analysis qualification gate has passed: pinned-R tests cover whole MICE chains on heavy-tailed and skewed synthetic data, saved bootstrap refits, and 300 identical null datasets. Full application workflows and the 500-item result tables pass browser checks. The complete 500 × 20,000 batch passed all 100 permutations with no failures in 55.4 minutes on the recorded M1/Chrome environment, with other local checks running concurrently; see the [qualification ledger](EFA-EXTENSIONS.md) for evidence and limitations.

## Weighted extraction and robust inference

**DWLS** uses reciprocal two-step polychoric sampling-variance weights and an analytic loading gradient. **WLSMV** uses the same point fit plus exact scaled/shifted inference and robust standard errors for the complete rotation map. Its output distinguishes raw and corrected statistics and records both trace terms, scaling, shift, degrees of freedom and denominator. A just-identified model has no corrected test. Loading/structure and factor-correlation views show standard errors; the loading CSV and complete JSON retain them.

Pairwise missingness preserves the approved pair-margin thresholds. R qualification therefore supplies these independently generated moments to pinned lavaan, rather than claiming equivalence to its default raw-data missingness procedure. Normal, heavy-tailed and skewed fixtures pass the recorded tolerances. Agreement with R does not establish that a latent-normal model fits arbitrary non-normal data. See [numerical derivation and exact qualification scope](EFA-WLS-DESIGN.md).

The 500 × 20,000 DWLS fit, all rotations, scoring and holdout refit completed in Chrome. Exact WLSMV completed both moment-space and case-space checks on 20 × 1,000 data. **Full 500 × 20,000 WLSMV completion time remains unmeasured**: the preflight estimates about 978 MB and 25.6 trillion multiply-adds for five factors. Its full-size allocation/cancellation check passed. Large inference never allocates the roughly 125 GB dense sampling covariance, substitutes DWLS, or silently switches to approximate traces.

MICE retains separate within-imputation WLSMV standard errors; between-imputation dispersion remains descriptive, without Rubin pooling. Bootstrapping a WLSMV baseline refits DWLS point estimates in each resample, explicitly recorded in the result; it does not recompute a robust test in every replicate.

## Assistant item collaboration

`list_efa_runs` lists observed and MICE analyses. `get_efa_diagnostics` now returns a bounded run overview; `get_efa_items` returns at most 20 items and 12 factor columns per page. Item results include pattern/structure values, primary and next absolute pattern loadings, their gap, communalities, uniquenesses, three strongest related-item polychoric correlations, review status and available within-fit standard errors. Primary/secondary metrics scan all factors even when the factor columns are paginated. MICE offers individual fits or aligned descriptive summaries; failed imputations remain recorded.

`update_efa_items` edits the same visible retain/investigate/exclude statuses and substantive notes used by the results pane. Each edit increments a persisted `reviewRevision`. The tool requires the revision it inspected; intervening user edits cause a conflict rather than an overwrite. `refit_efa_selection` snapshots those reviews into a new child with `parentReviewRevision`, preserves method/category settings and split, and returns an asynchronous job identifier. The factor count can be explicitly changed. Original fitting rows are kept by default; observed complete-case refits can explicitly admit additional respondents. MICE refits keep original rows and remap the explicit predictor sets. Neither editing nor refitting adds scores automatically. Undo restores the previous state and cancels pending work.

Private outputs omit free-text local notes and diagnostic messages in addition to response cells, row identifiers, imputation replacements, thresholds and respondent scores. The MICE disclosure floor uses **original observed pair support**, capped at five, never the number of completed/imputed rows. Older saved MICE analyses without this support metadata remain locally viewable but are withheld from private assistant inspection. Resampling membership and per-replicate records are not exposed by these tools. These are the existing aggregate-floor protections, not a formal differential-privacy guarantee.

A useful request is: “Inspect the saved EFA for weak primary loadings, cross-loadings and redundant items. Mark candidates for investigation with substantive reasons; then refit the agreed selection on the original fitting rows and compare it with the baseline.” Metrics guide this review; they do not determine an ideal instrument or certify validity.

## Outside this release

Ordinal EAP/MAP scoring, MCA, confirmatory model fitting, pooled MICE factor scores, Rubin-pooled rotated inference and nested MICE/bootstrap pooling remain outside this release. Full-size exact WLSMV runtime qualification remains an explicit performance limitation.
