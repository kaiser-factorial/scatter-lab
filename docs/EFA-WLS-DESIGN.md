# Weighted ordinal EFA: numerical engine and qualification

The isolated native numerical implementation now passes the small independent R qualification described below. Product integration is still in progress; these methods are not yet selectable in the EFA panel. MICE, resampling and the full parallel-analysis batch passed their gate on 2026-10-31. R remains a development/reference dependency; the application remains native TypeScript in browser workers.

## Preserve the meaning of the input correlations

The existing estimator fits thresholds from each pair's jointly observed category margins. This is the approved `polycor::polychor(ML=FALSE)` convention. Weighted extraction must not silently replace those correlations with a different estimator.

`lavaan` uses item-level thresholds held fixed across pairs when estimating its usual raw-data ordinal moments. Complete-case data give the same threshold population; pairwise missingness can give different estimates. The implemented reference strategy is:

1. Verify complete-case two-step correlations and their uncertainty against raw ordinal `lavaan` calculations, with zero-cell corrections explicitly disabled.
2. For pairwise missingness, independently compute the pair-margin correlations and their case contributions in R, then supply the resulting moments, diagonal fitting weights and sampling covariance to `lavaan`. Record this as supplied-moment parity, not equality to lavaan's default raw-data missingness procedure.
3. Keep the original pair-specific thresholds, sample sizes and category indices in the result. Do not smooth, merge, impute or change the correlation estimator implicitly.

The inspected release is `lavaan` **0.6-21**, published 2025-12-21. Its CRAN-tagged source is available at [DESCRIPTION](https://github.com/cran/lavaan/blob/0.6-21/DESCRIPTION), [ordinal scores](https://github.com/cran/lavaan/blob/0.6-21/R/lav_bvord.R), [two-step covariance](https://github.com/cran/lavaan/blob/0.6-21/R/lav_muthen1984.R), and [scaled/shifted test](https://github.com/cran/lavaan/blob/0.6-21/R/lav_test_satorra_bentler.R). Pin the archive and dependencies, and record hashes, before generating references. Reading this source does not itself qualify a native implementation.

## Case contributions without a dense sampling covariance

For one pair, evaluate the correlation likelihood score and the two marginal threshold-score vectors for each observed response cell. The two-step covariance uses a block-triangular sensitivity matrix. In the inspected lavaan implementation, the marginal blocks, correlation diagonal and correlation/threshold cross-block use empirical score products; the threshold-to-correlation upper block is zero.

The correlation's linearized contribution is the correlation score corrected for threshold estimation, divided by its sensitivity. When only `n_pair` of the `N` eligible rows contribute, express the contribution on the common `N` scale and use zero for rows missing either response. That common scale is necessary when combining uncertainty between different pairs. Independently verify signs, sample-size factors and missingness overlap against the R implementation; do not assume that treating estimated thresholds as fixed gives the right weights.

A pair's contribution is a lookup indexed by its observed category combination. Store those small tables and the original encoded response/missingness arrays. Generate requested blocks of case contributions on demand. A 500-item, five-category battery has about 3.12 million lookup cells, approximately 25 MB in Float64, instead of a 20,000-by-124,750 case matrix or a 124,750-square sampling covariance.

Any singular sensitivity block, invalid probability or nonpositive variance is an actionable failure. Generalized inverses and probability clipping must not quietly substitute for an estimable uncertainty calculation.

## DWLS point fitting

For `m = p(p-1)/2` pair correlations, let `w` be reciprocal diagonal sampling variances on the common `N` scale. Minimize

`F(L) = sum_(i<j) w_ij [r_ij - dot(L_i, L_j)]²`.

The loadings gradient is analytic. The model's effective dimension is `q = p*k - k*(k-1)/2`; the subtraction removes arbitrary orthogonal orientation. Rotation remains a separate step using the same fitted common-correlation model.

Use a deterministic orientation only to identify the covariance calculation: select well-conditioned anchor rows and transform their loading block to triangular form. These orientation constraints do not impose substantive cross-loading zeros. Reject rank-deficient information. Report `h² = diag(L L')` and uniqueness `1-h²`, including improper solutions. The exact boundary policy must be explicit in both the native and reference settings before qualification; it must not be inferred from MINRES's bounded auxiliary uniqueness optimization.

DWLS point estimates alone are not WLSMV. Standard errors and the mean/variance-adjusted test have a separate calculation and completion state.

## Exact WLSMV using bounded blocks

Let `S` contain the case contributions conceptually, `Gamma = S' S / N`, `W = diag(w)`, and `J` be the identified model Jacobian. Let `G = J' W J` and `U = W - W J G^-1 J' W`.

The robust parameter covariance is `G^-1 J' W Gamma W J G^-1 / (N-1)`, matching the pinned lavaan convention. The scaled/shifted test needs `trace(U Gamma)` and `trace((U Gamma)²)`. With `df = m-q`, its correction is:

- `a = sqrt(df / trace((U Gamma)²))`;
- `shift = df - a * trace(U Gamma)`;
- `adjusted statistic = a * raw statistic + shift`.

The saved R outputs verify `raw statistic = (N-1) F`. The native output retains the raw statistic, degrees of freedom, both traces, scaling factor, shift, corrected statistic, p-value and denominator. A just-identified fit has no corrected chi-square or p-value.

The same nonzero eigenvalues occur in the case-space matrix

`H = [S W S' - C G^-1 C'] / N`, with `C = S W J`.

Therefore `trace(U Gamma) = trace(H)` and `trace((U Gamma)²) = sum(H_ij²)`. The large-battery path computes those values in bounded symmetric blocks, without storing `H` or `Gamma`. `J` is sparse: each pair depends on only two loading rows. Small problems may use a dense moment covariance only when the explicit preflight budget permits it and moment space is smaller than case space. Both exact paths agree to `1e-10` in tests. Projected case contributions are stored only within the explicit memory estimate.

For 500 items, five factors and 20,000 respondents, `q=2,490`; one `q-by-q` Float64 matrix is about 49.6 MB, and one `N-by-q` projected-case matrix is about 398.4 MB. Decomposition workspaces, copies, contribution lookups and result buffers also count. A preflight budget must include these allocations and enforce a bounded single-worker inference job; a large factor count can exceed the budget even though a DWLS point fit is feasible.

Bounded memory does not imply fast computation. Exact second traces can still require order `N² m` arithmetic in the large case. Expose the amount of work and progress, allow immediate cancellation, and do not silently replace the exact correction with a randomized trace estimate. Full-size MINRES timings do not establish full-size WLSMV performance.

## Rotated uncertainty and qualification

Rotated loading and factor-correlation standard errors must account for the rotation's dependence on fitted loadings. Applying a fixed rotation matrix to an unrotated covariance is insufficient. A numerical delta calculation of the complete identified-loading-to-rotated-result map is a possible reference implementation; check derivative step stability and factor signs/order, and expose a failure when the rotation is not locally stable. Promax's two-step procedure also requires its own uncertainty qualification. Bootstrap intervals remain a separately labeled result.

Reference fixtures must cover normal, heavy-tailed and skewed latent responses, binary/mixed category counts, reverse keys, complete-case and pairwise missingness, and sparse/weak/improper cases. Compare weights, objective, reproduced correlations, pattern/structure, factor correlations, robust standard errors, traces and corrected tests. A non-normal fixture passing parity checks establishes agreement with the stated method; it does not establish that its latent-normal assumptions hold for arbitrary data.

The numerical modules remain isolated while worker/service, persistence, UI and assistant integration are completed. Weighted scoring, batch semantics, restored-run validation and assistant privacy still need product-level regression checks before release.

## Current evidence and limits

`frontend/src/lib/__tests__/efa-weighted.test.ts` checks five independently generated fixtures: normal, heavy-tailed, skewed, pairwise-missing and complete-case responses. All include binary and mixed ordinal category counts, correlated factors, cross-loadings and recorded reverse keys. The archive-pinned reference image uses R 4.5.1 and lavaan 0.6-21, with the already pinned polycor and GPArotation environment. Fixture/input/generator hashes and installed versions are recorded under `fixtures/efa-weighted/`.

The checks require correlations within `1e-5`; pair influence values, sampling covariances, reproduced common correlations, robust traces/tests and standard errors within `1e-4`; aligned loading/factor-correlation estimates within `1e-3`; p-values within `1e-5`. Alignment uses signs and permutation only. R's independently computed numerical delta map verifies pattern, structure, factor correlations and communalities for all three rotations. Lavaan's bordered standard errors independently check Oblimin and Varimax loadings/factor correlations.

The R rotation setting is explicitly `std.ov=FALSE`: the model already operates on the standardized correlation scale, and native rotation adds no observed-variable rescaling. Lavaan's default `std.ov=TRUE` gives the same point rotation here but different oblique bordered standard errors. Those original default outputs remain in every fixture under `defaultRotationStandardization`; they are not relabeled as parity results. The discrepancy was isolated by changing only this setting. Two auxiliary probes with an unnecessarily tight lavaan GPA tolerance were manually cancelled after the isolated check resolved the question; neither counts as a completed qualification run.

Weighted Varimax/Promax use a `1e-14` Varimax convergence threshold for both point estimates and their numerical delta map. The existing MINRES rotation defaults are preserved. The native delta calculation checks two central-difference step sizes before Richardson extrapolation and fails explicitly when the rotation is not locally stable. R uses a separate QR parameterization and `numDeriv` Richardson calculation with independently chosen steps. This also avoids treating lavaan's zero SE slots for derived ordinal residual variances as estimates of uncertainty in `1-h²`.

The full synthetic **500-item × 20,000-row DWLS** browser run passed: about 18.68 seconds for correlations, 37.25 seconds for pair uncertainty, 1.83 seconds for extraction, and under 0.2 seconds for scoring. All rotations and the 6,000-row holdout refit converged. The browser heartbeat continued and cancellation measured below the millisecond timer resolution. Peak sampled summed browser RSS was 1.18 GB; this includes shared-page double counting and is not a worker-heap measurement. See `weighted-browser-benchmark.json` for exact hardware, hashes, timings and convergence.

A **20-item × 1,000-row** WLSMV browser run completed all three rotations and their robust standard errors plus a 300-row holdout refit. Its full Oblimin inference/SE stages took about 0.94 seconds, and cancellation was exercised during rotated-SE computation. See `weighted-robust-browser-benchmark.json`.

These measurements do **not** establish completion time for exact WLSMV at 500 × 20,000. Its current preflight selects case space, estimates approximately 978 MB of working allocations and 25.6 trillion multiply-add operations. A separate full-size run reached case projection after allocation, kept the browser responsive and cancelled in 0.4 ms; `weighted-large-cancellation.json` labels this explicitly as an interrupted allocation/cancellation check, not a completed robust fit. Product integration must expose the work estimate and cancellation, without silently substituting DWLS or a stochastic trace approximation.
