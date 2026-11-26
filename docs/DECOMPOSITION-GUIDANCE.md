# Item guidance and convergence recovery

The PCA/EFA control panel offers **Analyze selected items** directly below the method buttons. It analyzes the current fitting sample and selected items locally, in a worker. It does not fit a model, modify source values, or apply settings until the user chooses a proposal.

## What the item report means

The report combines explicit item-type settings and category orders with descriptive diagnostics: numeric versus text storage, repeated integer scales, missingness, variance, skewness, excess kurtosis, and outlier counts. It distinguishes confirmed settings from candidates. A repeated integer scale is evidence to review an ordinal interpretation; the observed values alone cannot establish what an instrument measures.

The visible report includes complete/incomplete rows, missing-cell rate, minimum observed-pair support, missingness-pattern count, per-item profiles, reasons for each proposal, and assumptions that require judgment. Constant, empty, identifier and unsupported nominal items are identified before fitting. Large pair-support calculations have an explicit computation budget; an uncomputed value is shown as **not checked**, rather than a reassuring estimate. Missingness-pattern counts become a marked lower bound if their storage cap is reached.

The main EFA suggestions are:

| Observed profile | Proposed settings | Qualification |
| --- | --- | --- |
| Ordered items or plausible ordinal scales | Polychoric correlations with MINRES; WLSMV as an alternative | Confirm category meaning/order and inspect sparse categories. The default proposal is an exploratory fitting choice, not a claim that WLSMV is inferior. |
| Numeric items without strong descriptive shape flags | Pearson correlations with ML as a candidate | Univariate diagnostics do not establish the joint Gaussian model used by ML. |
| Numeric items with skewness or heavy-tail flags | Pearson correlations with MINRES | Descriptive thresholds guide review; they do not prove robustness or fix a misspecified factor model. |
| Continuous ML candidate with missing observations | FIML as a conditional option | Its missingness and distributional assumptions need substantive judgment. The report cannot infer MCAR, MAR or MNAR. |
| Mixed numeric measurement types | Conditional Pearson/MINRES proposal | Requires a defensible numeric-spacing interpretation. No polyserial estimator is silently substituted. |

These distinctions follow the model assumptions in [R's factor-analysis documentation](https://stat.ethz.ch/R-manual/R-devel/library/stats/html/factanal.html), [lavaan's estimator and missing-data documentation](https://lavaan.ugent.be/tutorial/est.html), and its [categorical-data workflow](https://lavaan.ugent.be/tutorial/cat.html). In particular, the workbench's Gaussian FIML path is not an ordinal FIML estimator.

Each proposal displays the exact settings it will change. **Apply settings** updates those controls and invalidates any old EFA preview; running remains a separate action. Later manual changes are respected. Reports become stale when the dataset, fitting sample/filter, selected items, method, item types, orders or missing-value choice changes. A cancelled or superseded worker cannot replace a current report.

## Recovering from nonconvergence

Single-fit iterative PCA and ML/FIML return structured stopping diagnostics. The dialog explains whether the attempt hit its iteration cap, stalled, failed a line search, or encountered nonfinite calculations, and shows the available aggregate diagnostics and resolved settings.

- **Retry with these settings** reruns the captured analysis with the edited hyperparameters. An iteration-limit stop prefills a larger budget; tolerance is never relaxed automatically. Iterative PCA exposes iteration cap, tolerance and reconstruction rank. ML/FIML exposes iteration cap, tolerance, starts and uniqueness floor.
- A finite iterative-PCA partial result can be accepted explicitly using **Keep unconverged result**. It retains `converged: false`, its diagnostics and the settings actually used. Until that choice, no PCA result or score columns are published.
- ML/FIML attempts whose starts all fail cannot be accepted as fitted models. Retry or dismiss is required.
- Dismissing discards the pending result. A change to the dataset, table, row filter, eligible fitting rows or split prevents reuse of a stale failed attempt.

Retry does not imply that more iterations will solve every failure. Single-fit iterative PCA still executes synchronously: the dialog's Cancel discards an already computed partial result, rather than interrupting computation in progress. ML/FIML retains worker cancellation. This flow covers ordinary single fits and item refits; it does not turn failures inside MICE/stability batches into individual interactive dialogs.

## Assistant access

The UI and assistant use the same versioned diagnostic rules. `analyze_decomposition_items` is read-only and defaults to the current item selection, measurement choices and category orders. It returns a bounded aggregate report with no respondent values, category labels, row indices or missingness masks. Private mode suppresses small counts, complementary counts and related ratios. Results are rejected if the data, fitting filter or disclosure policy changes while the analysis is pending.

`efa_job` can return eligible nonconvergence diagnostics. `retry_efa` accepts an existing failed job ID and explicit likelihood settings; the controller preserves the original model specification and fitting sample and rechecks the current context and access policy. `run_pca` accepts explicit iterative settings and reports a pending unconverged result rather than silently publishing it. The assistant's instructions require it to distinguish heuristic item guidance from established measurement properties, and to avoid silently weakening convergence tolerance.

## Verification

Tests cover classification and recommendations, count suppression, actual worker transport/cancellation, report invalidation, explicit settings application, keyboard focus, captured-sample retries, and Home-level PCA publication/cancel/retry behavior. The GitHub checks also run the full application suite and current-source numerical comparisons; see [CI.md](CI.md). Happy-dom and Node worker tests do not establish browser geometry or GPU behavior.
