# Likert EFA in Scatter Lab

The first EFA release runs entirely in browser Web Workers beside the existing PCA workflow. R generates independent development references; no R runtime, server or assistant provider is needed to fit an analysis.

## Workflow

1. Load a dataset, apply any row filter, and choose **EFA** in **PCA / EFA**.
2. Select items and review category orders and reverse keys. Ascending numeric orders are proposals. Text responses require an explicit JSON order, such as `["Disagree", "Neutral", "Agree"]`. Blank/null cells stay missing; deliberately recode questionnaire-specific missing codes before fitting.
3. Set factor count, rotation, missing-data policy, label and sample. Defaults are oblimin, pairwise deletion and all eligible respondents. **Preview sample** shows fitting counts and category counts; setup changes require another preview.
4. Run EFA. The wide results pane starts with loadings. Other views include structure, factor correlations, residuals, polychoric correlations, pairwise sample sizes and diagnostics. The item table virtualizes visible rows, with search and sticky identifiers.
5. Mark items **retain**, **investigate** or **exclude**, and record notes. Primary/secondary absolute loadings, their gap, communality and the strongest related-item correlation support review. Adjustable flags never automatically assign membership or remove items.
6. **Refit selection** saves a child run and retains the baseline. Keeping original fitting respondents is offered by default. Under complete-case deletion, removing items can admit respondents; comparisons report changed membership and pairwise counts.
7. Compare rotations using the same unrotated extraction. Other changes require a refit. Comparisons match shared-item patterns by order and signs, preserve baseline ordering and shared color scales, and report unmatched factors and changed coverage. No further Procrustes rotation is used.
8. **Add scores to dataset** explicitly creates owned, collision-safe columns such as `FA1_Likert_r1`, available to scatterplots, clustering and dataset exports. Incomplete/excluded respondents receive nulls. Loading CSV includes pattern, structure, communalities, uniquenesses and notes; complete JSON includes specification, results, membership, diagnostics and provenance.

Values remain visible without a heatmap. Loading scales are zero-centered and expand beyond ±1 when necessary. Correlations use −1 to +1; residual comparisons share their actual range. CSV/JSON preserve full precision.

## Numerical conventions

| Stage | Convention |
|---|---|
| Preparation | 3–500 explicitly ordered items; column-major `Uint16Array` ranks and separate `Uint8Array` observation mask; source cells never reverse-keyed in place |
| Correlations | Two-step polychoric, including tetrachoric for binary pairs; pair-specific observed margins and normal thresholds, then bivariate-normal likelihood optimization with `maxcor=.9999` |
| Extraction | MINRES lower-triangle squared residual objective; analytic spectral gradient; projected limited-memory BFGS; optimized uniqueness bounds `[.005, 1]`; projected-gradient criterion `1e-8` |
| Rotation | Unnormalized oblimin delta/gamma 0; normalized varimax; promax power 4 using normalized varimax; deterministic seeded starts and best converged objective |
| Outputs | Pattern Λ, structure ΛΦ, factor correlations Φ, common reproduced matrix ΛΦΛ′, communalities from its diagonal, uniquenesses `1 − h²`, off-diagonal residuals and RMSR |
| Scores | Solve `R × W = structure`; multiply complete ordinal-rank responses standardized with fitting-sample item means/sample SDs by W |
| Parallel analysis | Explicit batch; default 100 seeded within-item permutations with fixed missingness masks; 95th-percentile reference; one-factor MINRES communalities on the diagonal for both observed and null spectra |

References: [polycor](https://cran.r-project.org/web/packages/polycor/polycor.pdf), [psych factor analysis](https://www.personality-project.org/r/psych/help/fa.html), [psych parallel analysis](https://www.personality-project.org/r/psych/help/fa.parallel.html), [R varimax/promax](https://stat.ethz.ch/R-manual/R-devel/library/stats/html/varimax.html), and the pinned GPArotation package.

Empty category margins within a pair are omitted from its likelihood, as in polycor, while original orders and observed-level indices remain recorded. This does not merge categories. Sparse cells, near-boundary correlations, optimized uniqueness bounds, improper communalities and matrix conditioning are reported. Unestimable pairs, constant items, invalid orders, underidentified counts, nonconvergence and singular/indefinite matrices stop the job. Minimum eigenvalues at most `1e-8` are rejected. Pair contingency tables are limited to 4,096 declared cells. There is no automatic smoothing, imputation, merging or estimator substitution.

Scores are ordinal linear regression approximations, not EAP/MAP estimates. Correlated factors do not receive PCA-style additive variance percentages. Failed null replicates remain in parallel-analysis results; any failure suppresses the definitive factor-count suggestion. If all fail, reference values are null. A full 500-item simulation batch was not performance-qualified and may take substantially longer than a fit.

## Splits and history

Create a saved seeded split (initial 70/30 proportion), optionally grouping and stratifying, or use two values in an existing split column. Groups stay together; a group spanning strata is rejected. Actual row membership survives item edits. The current filter and partition apply before thresholds, correlations, scaling and scoring.

**Compare on holdout** freezes a development specification and independently refits the saved holdout. This is labeled **structure replication**, with visible failures and no “validated” badge. History records prior full-sample PCA/EFA fits, actual opening of holdout results, and later revisions. These records cannot establish that data were never viewed in another plot, application or analysis.

## Implementation map

- `frontend/src/lib/efa/types.ts`: typed specifications, prepared data, results, runs, splits and simulations.
- `prepare.ts`, `correlation.ts`, `extraction.ts`, `rotation.ts`, `fit.ts`, `parallel.ts`, `compare.ts`: isolated numerical functions.
- `efa.worker.ts`, `service.ts`: asynchronous jobs, result retrieval, progress and cancellation. Up to four workers, bounded by hardware; correlation batches contain 64 pairs. Simulations use a terminable worker.
- `controller.ts`: common UI/assistant orchestration, generation/table/filter guards, lineage, reviews and score publication.
- `state.ts`, `persistence.ts`: membership, score ownership, CSV and import validation. Workspace format 2 saves EFA runs, splits and simulations; format 1 imports with empty EFA state.
- `frontend/src/components/EfaPanel.tsx`: setup, virtualized results and comparisons. `page.tsx` connects the existing analysis gate, undo and persistence. Existing PCA numerical code is unchanged.

Jobs snapshot specifications, membership and selected columns. SHA-256 fingerprints include encoded responses, missingness, item transformations and membership. Correlation caches are scoped to immutable table revisions and exact preprocessing/sample settings. Pair reuse after removal requires unchanged actual fitting rows; rotation reuse checks the fingerprint and factor count. Cancelled, failed, superseded, restored or undone jobs cannot publish results or scores.

Six assistant actions share the controller: `run_efa`, `efa_job`, `get_efa_diagnostics`, `compare_efa`, `add_efa_scores`, `parallel_efa`. Fits/simulations return job IDs. Private results whitelist aggregates and omit respondent membership, scores, thresholds and response combinations. Assistant selections below five respondents, or excluding fewer than five eligible respondents, are rejected; pairwise counts below five also block assistant fitting/simulation. Locally inspecting a result does not permit disclosure of its rare aggregates. Offline replays exercise all six tools, cancellation and rejection paths without paid calls.

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

Measured on 2026-10-30 local time: Apple M1, eight logical cores, 8 GiB RAM, headless Chrome 156. The synthetic fixture uses seed 8801, 500 five-category items, 20,000 respondents and five factors. This qualifies that fixture on this machine, not every sparsity pattern, factor count or browser.

| Action | Elapsed |
|---|---:|
| Full polychoric + MINRES + oblimin fit | 17.92 s |
| Promax comparison, extraction reused | 2.02 s |
| Varimax comparison, extraction reused | 2.01 s |
| Scoring 20,000 complete responses | 1.76 s |
| Independent 6,000-row holdout refit | 14.18 s |
| Cancellation during correlations | 0.9 ms |

MINRES converged in five iterations: objective `2.7655124152833186`, projected gradient `7.510255625668411e-9`. The UI heartbeat advanced during correlation estimation. Peak summed browser-process RSS was 1,266,253,824 bytes (about 1.27 GB), sampled once per second; shared pages may be counted more than once. This is process memory, not an exact JS heap measurement.

The actual full-size result was loaded into the app: 23 table rows rendered, item 500 remained reachable, the heatmap worked, and Escape dismissed the pane without page errors. Evidence is under `frontend/scripts/efa-reference/`: `browser-benchmark.json`, `large-ui-verification.json`, `ui-verification.json`, and screenshots. The workflow check covers both themes, long labels, keyboard navigation, preview/fit, rotations, notes/refits, scores, holdout history, automatic session restoration and named workspaces.

## Reproduction

Final local regression checks passed: 512 tests in 38 files, TypeScript, the production build, and the lint regression gate (123 existing problems, zero in new EFA files). The separate optional Node benchmark is the single skipped test; the full browser benchmark above was executed. `git diff --check` also passed.

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

## Follow-on milestones

Ordinal MICE and resampling stability come next, preserving separate imputations and aligned analyses. DWLS follows, then robust WLSMV with memory-bounded uncertainty. This release does not allocate the roughly 125 GB dense sampling-covariance matrix associated with 500 items. Ordinal EAP/MAP scoring, MCA and confirmatory model fitting remain outside this release.
