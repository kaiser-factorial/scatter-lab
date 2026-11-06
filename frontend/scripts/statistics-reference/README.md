# Public statistics reference contracts

`generate-input.mjs` records explicit inputs; `generate.R` computes reference outputs in pinned R 4.5.1 / `stats` 4.5.1 with `jsonlite` 2.0.0. The reference JSON records input and generator SHA-256 hashes and the actual Docker image ID. Generation uses networking disabled and single-threaded BLAS. `packages/statistics/test/canonical.check.mjs` imports the built package's public ESM exports and rejects stale TypeScript/build manifests, input/generator mismatch, source drift, omitted groups, or incorrect scalar coverage.

The public matrix has **73 groups and 23,969 scalar comparisons**. Combined with the existing 375 application-kernel groups / 4,239 scalar error-metric checks, `npm --prefix frontend run ci:numerical` requires **448 groups**. The existing metrics often summarize maximum error over a whole matrix; the public comparisons count individual values. The denominators are reported separately, not as independent statistical trials. These are finite input/convention comparisons, not universal equivalence proofs. R is needed only to generate fresh reference fixtures; the library, app, and retained-reference CI job do not require it.

| Public family | Groups | Comparisons | Oracle and matched contract |
| --- | ---: | ---: | --- |
| PCA fit, serialized model, held-out transform | 20 | 21,652 | `stats::prcomp` and `predict`; population center/scale/eigenvalue convention; signed-axis alignment |
| Numeric description | 5 | 50 | R finite coercion, mean/median/extrema and explicit population/sample denominators |
| Pearson, Spearman, Chatterjee | 9 | 33 | `stats::cor` for Pearson/Spearman; independent exact predictor-tie permutation average of the Chatterjee formula for three small fixtures |
| Welch | 8 | 48 | `stats::t.test(var.equal=FALSE)`, two-sided p and 95% CI; independently computed pooled-SD Cohen d |
| Mann–Whitney | 8 | 24 | `stats::wilcox.test(exact=FALSE, correct=FALSE)`, tie-corrected normal approximation and existing effect orientation |
| Kolmogorov–Smirnov | 8 | 16 | `stats::ks.test` for D; independently coded Stephens-adjusted p formula; R exact/asymptotic p-values recorded separately as boundaries |
| Kruskal–Wallis | 4 | 16 | `stats::kruskal.test`, tie correction and chi-square approximation; explicit epsilon-squared convention |
| Group comparison | 4 | 56 | R group/overall moments, eta-squared and omega-squared formulas |
| Pearson chi-square | 4 | 16 | `stats::chisq.test(correct=FALSE)` and Cramer V |
| K-means | 3 | 2,058 | `stats::kmeans(algorithm='Lloyd', iter.max=300)` from ten identical recorded initial-center matrices; best SSE and label-invariant pair membership |

The Chatterjee comparison is an independent formula implementation, not a `psych`, `lavaan`, or canonical-package call. Randomized clustering is compared from explicit initial matrices; using the same integer seed in unrelated runtimes would not establish equivalent starts. R's default K-means algorithm is Hartigan–Wong, so this comparison intentionally selects Lloyd. [R K-means documentation](https://stat.ethz.ch/R-manual/R-devel/library/stats/html/kmeans.html)

PCA covers small continuous synthetic data, Iris, and Holzinger–Swineford, each with complete/mean/median preprocessing and scaled/unscaled fits. It fits replacement values, means and scales on training rows and applies them to held-out rows. Two additional covariance fits scale the same input by `1e-10` and `1e100`. Those compare components and outputs normalized back to base units. They caught an inherited absolute Jacobi pivot cutoff and overflowing norm, corrected in the single shared PCA kernel. The comparison converts `prcomp`'s sample eigenvalues by `(n-1)/n` and supplies population SDs explicitly. [R PCA documentation](https://stat.ethz.ch/R-manual/R-devel/library/stats/html/prcomp.html)

## Measured compatibility boundaries

The maximum errors in the retained package comparison were approximately `2.94e-13` for ordinary PCA quantities, `5.43e-13` for Welch quantities, `2.14e-14` for K-means SSE, and `7.30e-8` for Mann–Whitney p-values. The latter reflects the preserved approximate normal CDF; its limit is `1.6e-7`. These are maxima on the listed fixtures, not worst-case mathematical bounds for all inputs. Exact per-metric errors and tolerances are in `validation/library-migration/public-reference.json` and each CI run's `numerical/public-package.json`.

**The preserved KS p-value is not equivalent to R's default p-value.** The implementation uses the Stephens-adjusted continuous-null approximation, with `p=1` below adjusted lambda `0.3`. On eight fixtures, D and the separately matched Stephens formula agree within `1.12e-16`, but the p-value differs from:

- R's exact two-sample p by up to **0.18342708072824154**, on the tied ordinal fixture (`0.6898030576924539` versus `0.5063759769642123`).
- R's unadjusted asymptotic p by up to **0.23547647326188365**, on the two-versus-three-observation fixture (`0.4249095498880198` versus `0.6603860231499035`).

This is a difference in p-value calibration, confirmed by independent implementation review; it is not optimizer nonconvergence or floating-point noise. No tolerance was widened to call those defaults equivalent. Public results expose `pValueMethod`, `continuousNullAssumption`, `tiesPresent`, and `lowLambdaClamped`. With ties/discrete data, the continuous-null p-value is not a calibrated discrete test. The app's numerical default is preserved. A future exact/conditional or permutation method needs its own implementation and reference qualification. R automatically selects an exact two-sample calculation when the product of sample sizes is below 10,000, including tied samples. [R KS documentation](https://stat.ethz.ch/R-manual/R-devel/library/stats/html/ks.test.html)

The finite reference matrix does not establish exact nominal coverage, calibration on every distribution, universal convergence, or robustness to every magnitude. DBSCAN, advisory heuristics, package validation, serialization, and the public ordinal-MICE wrapper also have unit/contract tests; no new external DBSCAN or advisory calibration claim is made here. Existing estimator, rotation, polychoric, missing-data, bootstrap, and formal-property scope remains in `docs/EFA-CONGRUENCE.md` and `docs/EFA-FORMAL-VALIDATION.md`.

## Running and refreshing

From the repository root:

```sh
npm ci
npm run build:stats
npm --prefix frontend ci
node packages/statistics/test/canonical.check.mjs
npm --prefix frontend run ci:numerical

# Regenerate the whole independent R matrix into separate artifacts:
cd frontend
CI_R_SKIP_BUILD=1 npm run ci:reference-r
```

`CI_R_SKIP_BUILD=1` requires the previously built pinned image; runtime versions are still checked. Omitting it rebuilds the image chain. Fresh R generation uses separate output paths and never silently overwrites retained fixtures. Intentionally changing retained inputs requires regenerating `public.reference.json`, reviewing errors/conventions, and explicitly refreshing the 50-file reference integrity manifest. A manifest refresh alone is not statistical validation.
