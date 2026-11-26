# Estimated MV correction in Scatter Lab

WLSMV setup now offers **Exact · default** and **Estimated · WebGPU random probes**. Both apply the MV scaling and shift. Estimation replaces only the second robust trace moment; DWLS fitting, the exact first trace, parameter covariance, rotated standard errors and score weights use the same calculations.

Selecting estimated correction explicitly selects browser WebGPU. CPU and Scala retain exact correction. Probe count is an integer from 16 through 4096 (default 128); probe seed is an unsigned 32-bit integer (default 61001), separate from the rotation seed. There is no automatic backend or estimator substitution, size-based method switch, or adaptive stopping. Invalid settings fail before a fit starts. Small CPU fits continue to choose exact moment-space inference when its allocation is smaller.

## Background execution and results

The fitted source and covariance stay in the owning Web Worker. The estimated backend passes five synthetic Float64 self-checks, including target-length axes, before processing analysis data. The tolerance remains `max |GPU−reference| / max(1, |reference|) <= 1e-10`. Runtime provenance records the operator shader hash, precision, adapter, self-check, stage timings, probe count and GPU allocation high-water mark. No developer flags are requested.

The operator processes at most 32 probes per batch. Progress distinguishes matrix-product stages from completed probes. After each batch, the inspector shows the provisional second trace, completed/requested probes, seed, empirical Monte Carlo standard error and normal-approximation 95% interval. The inspector is a nonmodal side panel rendered at the document root so the plot and other controls remain usable. It supports keyboard navigation out of the panel, Escape and focus return; on narrow screens it can be closed to expose the dashboard.

A partial estimate is never accepted as a result. Cancellation terminates the worker and marks the displayed partial estimate discarded. GPU command retirement time is not measured by the cancellation acknowledgement. Existing immutable snapshots, input-change rejection and score-publication rules remain in force. The dashboard stays interactive, but this change does not publish a provisional factor-results pane before the fit completes.

Completed results retain an explicit estimated-correction label. The uncertainty interval describes random-probe error in `tr(H²)`, not uncertainty in the population parameters or a guarantee for repeatedly checking and stopping. Parameter standard errors remain separate. Both exact and estimated corrections are unavailable as chi-square tests for a just-identified model with zero degrees of freedom, as before.

## Persistence, caching and assistant use

Engine version is `scatter-efa/8`; workspace format remains version 2 with backward-compatible optional fields. Old runs without correction settings remain exact. Imports validate the method, seed, complete probe budget, numerical self-check version, trace value and uncertainty interval. Missing or inconsistent approximation metadata is rejected.

Rotation-invariant cache keys include normalized correction settings, probe count and seed as well as the existing dataset/preparation/model keys. Rotation comparisons can reuse the completed estimated correction. Changing method, seed or count requires new inference. Cancelled and failed jobs cannot populate that cache.

Analysis JSON contains the complete specification, corrected test and approximation metadata. Loading CSV adds `mv_correction`, `mv_probes`, `mv_seed` and `trace_squared_mcse`. Inspector exports contain operational and aggregate diagnostics, without responses, row memberships or item names. Per-probe respondent products are never published.

The existing asynchronous `run_efa` action accepts:

```json
{"extraction":"wlsmv","compute":{"backend":"webgpu","correction":"estimated","probes":128,"probeSeed":61001}}
```

This fragment supplements the required items, category orders, factor count, rotation and sample specification. Existing job polling and diagnostics expose the approximation as permitted by the private/open policy. Private progress still omits numerical payloads; completed summaries use the existing aggregate support guard. MICE and resampling retain their existing explicit browser-CPU restrictions. No assistant provider calls were made for qualification.

## Measured speed and precision

The [figure](figures/efa-mv-tradeoff-v6.png) shows every seed and probe budget, with shared logarithmic scales. Higher horizontal values are faster; lower vertical values have less observed error. Each point is one cumulative fixed probe budget. Nested checkpoints share random streams. The [CSV](figures/efa-mv-tradeoff-v6.csv) retains signed error, observed absolute error, Monte Carlo SE, p-value change and elapsed time. The [figure specification](figures/efa-mv-tradeoff-v6.json) records transformations, source hashes and limitations.

Apple M1, 8 GiB, Chrome 156, synthetic data. GPU times include the measured kernel startup and trace computation, excluding shared projections/covariance, self-checks and rotations. Estimated times below are medians across seeds at 128 probes; errors are observed absolute relative errors in the second trace, not guaranteed bounds.

| Respondents × items | Factors | Exact GPU trace | Estimated GPU, 128 probes | Median error | Observed error range | Seeds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 × 8 | 2 | 0.191 s | 0.059 s | 3.441% | 1.309–7.978% | 10 |
| 1,000 × 20 | 5 | 0.146 s | 0.052 s | 1.200% | 0.252–2.604% | 10 |
| 2,000 × 60 | 5 | 1.190 s | 0.213 s | 0.342% | 0.009–1.110% | 10 |
| 5,000 × 120 | 5 | 8.539 s | 0.886 s | 0.153% | 0.011–0.385% | 10 |
| 20,000 × 500 | 5 | 22.95 min (historical) | 36.98 s | 0.0445% | 0.0387–0.0504% | 2 |

The large case uses the retained completed exact benchmark and prior matching-input probe runs; it was not rerun as a paired full fit. Smaller cases use newly measured exact and estimated values. Different item counts, respondent counts and model structures vary together, so this is not evidence for a universal size threshold. Startup costs and timing noise also matter for subsecond jobs.

For the small cases, the **entire exact CPU inference stage**, including canonical covariance and both traces, took median **5.3 ms for 1,000 × 8** and **55.7 ms for 1,000 × 20**, over seven executions each. Preparation, correlations, extraction and rotated SEs are excluded. These CPU measurements have a broader scope than the GPU trace-only columns and explain why exact CPU remains attractive for small batteries.

The error advantage is not caused by trace magnitude alone. Let `M = H²`. For s independent Rademacher probes,

```
Var(estimated tr(M)) = (2/s) × Σ_(i≠j) M_ij².
```

Dividing by `tr(M)²` gives relative variance. Multiplying H by a constant scales the trace estimate and its standard error by the same squared constant, leaving relative error unchanged. Effective rank, the spread of eigenvalues and off-diagonal structure matter. More probes reduce variance in expectation, but a realized nested estimate need not move monotonically closer to exact. Method context: [Hutch++](https://arxiv.org/abs/2010.09649); the application implements basic fixed-budget Rademacher squared-norm estimation, not Hutch++ or its stronger guarantees.

Reproduce the chart with `matplotlib==3.10.7` and `frontend/scripts/efa-reference/plot-trace-tradeoff.py`. Reproduce the fresh comparisons with the existing compute builder and `check-trace-estimation.mjs tradeoff <new-output.json>`. Start the app using the required `dev` launcher.

## Evidence

- `frontend/scripts/efa-reference/compute/estimated-workflow-v6.json`: 30 production-service fits; unchanged loadings/SEs, qualified probe outputs, cache separation and persistence rejection checks.
- `frontend/scripts/efa-reference/compute/estimated-ui-v6/report.json`: actual controls, live uncertainty, 2D/3D switching while the job and inspector remain active, cancellation, completion, both themes and keyboard/mobile checks. Cancellation acknowledged in 337 ms after 512 of 4096 probes, with no saved run; a subsequent 64-probe fit completed and retained its seed and metadata.
- `frontend/scripts/efa-reference/compute/trace-tradeoff-v6.json`: four fresh cases × ten seeds × three probe checkpoints, plus small CPU inference timings.
- `frontend/scripts/efa-reference/compute/trace-estimation-large-v5.json`: retained 500-item comparison and immutable executable archive.

Final regression verification: 688 tests passed and 4 skipped across 56 passing test files, TypeScript passed, and an isolated production build passed against identical application sources. The existing lint baseline remains 117 errors and 6 warnings, with no additional file/rule/severity counts. A prior test run overlapped browser/GPU work and hit the existing 5-second limit on a heavy-tail R comparison; the complete suite passed with one worker after that load ended, without changing numerical tolerances or test timeouts. Source and evidence hashes are recorded in `frontend/scripts/efa-reference/compute/estimated-verification-v6/audit.json`.

A subsequent [fresh paired full-fit benchmark and runtime-guidance study](EFA-RUNTIME-GUIDANCE.md) measures the complete 500-item workflow for both methods, while preserving this earlier trace-only comparison as historical evidence.
