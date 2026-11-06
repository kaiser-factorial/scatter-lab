# PCA/EFA numerical congruence qualification

This qualification compares the application's actual TypeScript numerical modules with independently executed R calculations. The final small-data matrix passes **375 of 375 comparison groups and 4,239 of 4,239 scalar checks**, with no source drift between the bundled code and the current numerical implementation. Separately, 24 matched Iris iteration-budget configurations and an exported R completion replay pass. These are finite numerical comparisons, not a universal proof that floating-point implementations, optimizers, or statistical models are equivalent.

The machine-readable [numerical summary](../frontend/scripts/efa-reference/congruence/numerical-summary.json) contains every metric's denominator, tolerance, median, 95th percentile, maximum, and worst-case dataset/method. Its quantiles summarize **per-comparison error maxima**, not distributions of every cell's error or probabilistic error guarantees. Repeated rotations of one fit are not independent datasets. Raw reports retain each comparison and convergence flag. The [validation manifest](../frontend/scripts/efa-reference/congruence/validation-manifest.json) hashes fixtures, scripts, vendored reference source, previous attempts, and reports. Native execution receipts also hash the actual bundled application modules.

The principal compatibility limits are explicit:

* Parallel-analysis null fits agree with the documented, independently optimized R bounded-MINRES objective. They do **not** uniformly match the default `psych::fa` optimizer on weak null datasets; the largest individual null-spectrum difference is **0.759384**. All three tested 95th-percentile curves remain within **3.83e-5**, and both implementations suggest two factors on those datasets. This is an observed boundary, not a guarantee for other datasets.
* Iterative PCA agrees with the pinned missMDA source at the **same iteration limit**. The application's default 200 iterations can return a flagged, unconverged iterate. In the additional Iris study, the largest difference from the eventual converged completion is **0.113624 original-scale units** despite cross-language agreement at 200 iterations to about 4e-14.
* Ordinal WLSMV comparisons use matching pairwise margins, influence moments, estimator, and correction. This is not a blanket claim of equivalence to lavaan's different raw-data defaults for shared thresholds or zero-cell treatment.
* ML/FIML use a Gaussian model of explicitly numeric responses. Selecting Pearson on ordinal codes intentionally treats those numbers as quantitative; it does not turn Gaussian FIML into an ordinal latent-response likelihood.

## Reference runtime and provenance

The newly generated references ran offline in Docker image `scatter-lab-efa-weighted:4.5.1`, image ID `sha256:5cd875ebc7ed97cce3e09bca0794e233e5e0d4e5c0252bbbb3c98258dd6c4c6c`, on `aarch64-unknown-linux-gnu`: R **4.5.1**, lavaan **0.6-21**, psych **2.5.6**, GPArotation **2025.3.1**, polycor **0.8-1**, jsonlite **2.0.0**, and numDeriv **2016.8-1.1**. The reused conditional/MICE references additionally record MASS **7.3-65**. Exact versions are retained in [runtime.json](../frontend/src/lib/__tests__/fixtures/efa-congruence/runtime.json) and each existing fixture's provenance.

missMDA was not installed in the image. The reference harness executes the unchanged `imputePCA` function from **missMDA 1.20**, with its sole namespace-qualified `FactoMineR::svd.triplet` call redirected to the unchanged helper from **FactoMineR 2.12**. This is explicitly a **source adapter**, not execution of the complete installed packages. The [vendor source manifest](../frontend/scripts/efa-reference/congruence/vendor/sources.json) retains CRAN archive URLs, archive hashes, individual source hashes, and license/author metadata. The supported reference contract is uniform row weights, one deterministic initialization, no supplementary rows or columns, regularized PCA, ridge coefficient one.

The successful original R generation and subsequent ML-rotation refinement have separate immutable source archives under [attempts](../frontend/scripts/efa-reference/congruence/attempts). The main fixture runtime points to the actual original generator hash; each refined ML fixture separately records the refinement script and rotation-implementation hashes. `generate.R` now reproduces the combined final convention directly.

R source documentation: [lavaan EFA](https://www.lavaan.ugent.be/tutorial/efa.html), [lavaan estimators and missing data](https://www.lavaan.ugent.be/tutorial/est.html), [missMDA package](https://cran.r-project.org/web/packages/missMDA/index.html). Package versions are pinned above; current documentation is explanatory rather than a substitute for retained executable source.

## Dataset matrix

“R's personality dataset” is interpreted as **psych::bfi**, all 2,800 respondents and the 25 A/C/E/N/O items, excluding demographic columns. Reverse keys A1, C4, C5, E1, E2, O2, and O5 use `7 - x` before saving the shared input. Original missingness is retained. This interpretation is recorded rather than presented as an unambiguous dataset name.

| Dataset group | Respondents × items | Factors | Missingness/data shape |
| --- | ---: | ---: | --- |
| Normal synthetic | 600 × 8 | 2 | Complete, saved MCAR, saved MAR |
| Heavy-tail synthetic | 600 × 8 | 2 | Standardized t5 draws, saved MCAR |
| Skew synthetic | 600 × 8 | 2 | Standardized lognormal draws, saved MAR |
| HolzingerSwineford1939 | 301 × 9 | 3 | lavaan x1:x9, original complete plus saved MCAR/MAR variants |
| psych::bfi | 2,800 × 25 | 5 | Original missingness; reverse-keyed as above |
| Ordinal synthetic | 600 × 8 | 2 | Five-category version of the normal synthetic, saved MCAR |

The ten exact inputs are retained in [efa-congruence fixtures](../frontend/src/lib/__tests__/fixtures/efa-congruence). The continuous synthetic data include nonunit means and unequal item scales so an accidental standardization/denominator convention does not disappear. Missing masks are actual saved values rather than an assumption that R and JavaScript seeds produce the same masks.

| Comparison family | Executed coverage | Passed groups / scalar checks |
| --- | --- | ---: |
| Main numeric matrix | Each of 10 datasets: ML complete/mean/median/FIML × 3 rotations; Pearson MINRES complete/mean/median/pairwise × 3 rotations; PCA complete/mean/median/pairwise/iterative × scaled/raw | 340 / 3,230 |
| Additional ordinal matrix | bfi25 and ordinal synthetic × complete/mean/median/pairwise; polychoric, Gamma, MINRES and DWLS with all 3 rotations, exact WLSMV correction | 8 / 344 |
| Conditional, imputation and resampling | 7 ordinal/binary conditional cases; 4 recorded-draw MICE configurations; 3 families × 6 saved bootstrap fits; 3 families × observed plus 100 saved parallel null datasets; 5 contrast scales | 22 / 507 |
| Weighted uncertainty | 5 normal/heavy-tail/skew/pairwise/complete fixtures; case influences, Gamma, WLSMV, lavaan and numerical-delta rotated SEs | 5 / 158 |
| Iris iteration boundary, separate | 4 saved seeds × 3 missingness rates × 200/1,000 iteration limits | 24 matched configurations |
| Saved-model completion replay, separate | Fixed public-data fitting subset with reverse keys and a wholly unobserved row | 1 replay, 185 completed cells |

Raw final reports: [main](../frontend/scripts/efa-reference/congruence/third-pass-report.json), [ordinal](../frontend/scripts/efa-reference/congruence/ordinal-report.json), [extensions](../frontend/scripts/efa-reference/congruence/extensions-report.json), [weighted SEs](../frontend/scripts/efa-reference/congruence/weighted-se-report.json). No reference or native fit failed in these final groups. The main matrix contains 40 distinct ML/FIML fits; repeating their rotations does not create 120 independent likelihood fits.

## Agreement contracts and measured errors

Factors are aligned using a **joint column permutation and sign changes**, with the same transformation applied to Phi. Arbitrary Procrustes transformations are not used to hide a rotation disagreement. Reconstructed common covariance and raw fitted covariance/log likelihood are checked separately from rotated loadings. Native extraction convergence, native rotation convergence, and R convergence are separate checks from parameter agreement.

ML references use `lavaan::efa`, explicit Gaussian ML, `meanstructure=TRUE`, free positive residual variances, unit latent variances, no initial rotation, and covariance normalization by **N**. FIML integrates missing components out of each respondent's Gaussian likelihood, excludes wholly missing rows from likelihood contributions, and does not fill cells before fitting. The saved raw means/Sigma then generate conditional expectations separately. Complete/mean/median preprocessing is matched before ML. Raw covariance and conditional comparisons use original numeric units.

MINRES uses the specified lower-triangle residual objective. PCA references use `stats::prcomp` or explicit pairwise `cov/cor/eigen`, with documented population versus sample scaling conversions. Displayed PCA loading vectors are intentionally rounded to .001 in the app; full-precision eigenvalues and scores have independent tighter checks. Category-constrained column medians use the observed lower median; category-constrained means choose the closest supported category, with the lower category resolving an exact tie. Continuous columns retain ordinary numeric mean/median behavior.

| Metric | Maximum observed absolute error | Acceptance limit | Worst case |
| --- | ---: | ---: | --- |
| Common covariance, main matrix | 1.712e-5 | 1e-4 | Holzinger MAR, pairwise MINRES |
| Signed/permuted pattern, main matrix | 1.976e-4 | 1e-3 | Normal MAR, pairwise MINRES, Varimax |
| Signed/permuted Phi, main matrix | 7.157e-6 | 1e-3 | Holzinger MAR, pairwise MINRES, Oblimin |
| 1 − minimum Tucker congruence | 2.635e-8 | 1e-5 | Normal MAR, pairwise MINRES, Varimax |
| ML raw fitted covariance | 1.738e-5 | 2e-4 | bfi25 FIML |
| ML fitted means | 2.252e-7 | 1e-4 | Normal MCAR FIML |
| ML residual variances | 6.111e-6 | 2e-4 | bfi25 FIML |
| ML log likelihood per contributing row | 5.756e-10 | 1e-7 | bfi25 FIML |
| ML AIC and BIC | 3.224e-6 | 1e-3 | bfi25 FIML |
| FIML conditional missing-cell predictions | 4.601e-5 | 5e-4 | bfi25 FIML |
| Pearson correlation | 2.776e-15 | 1e-10 | bfi25 complete cases |
| MINRES objective | 3.931e-10 | 1e-6 | Holzinger MAR pairwise |
| PCA eigenvalues | 6.928e-14 | 1e-7 | bfi25 mean fill |
| PCA displayed vectors | 4.99934e-4 | 5.01e-4 | bfi25 mean fill, expected .001 display rounding |
| PCA sampled scores | 2.341e-13 | 1e-6 | bfi25 iterative |
| Iterative PCA missing-cell completion | 6.040e-14 | 1e-5 | bfi25 iterative |
| Additional ordinal Gamma | 6.815e-11 | 1e-4 | Ordinal synthetic complete cases |
| Additional WLSMV corrected statistic | 1.524e-5 | 1e-4 | bfi25 mean fill |
| Weighted raw-data lavaan Gamma comparison | 7.904e-5 | 1e-4 | Complete fixture |
| Varimax loading SE versus lavaan | 5.418e-5 | 1e-4 | Skew fixture |
| Varimax loading SE versus independent numerical delta | 5.678e-5 | 1e-4 | Skew fixture |
| Promax loading SE versus independent numerical delta | 8.098e-6 | 1e-4 | Complete fixture |
| Ordinal conditional probabilities | 1.003e-7 | 1e-5 | Ordinal conditional fixture |
| MICE completed category codes, recorded draws | 0 | 0 | All 4 configurations |
| MICE fitted pattern | 7.125e-6 | 1e-3 | Heavy-tail rank encoding |
| Bootstrap pattern | 1.363e-5 | 1e-3 | Normal family |
| Parallel null spectrum versus independent R objective | 8.238e-7 | 1e-4 | Heavy-tail family |

All other checked metrics and their exact thresholds, quantiles, maxima, and locators are in `numerical-summary.json`. A measured finite maximum does not bound unseen data. Boundary/near-singular solutions, poorly separated factors, alternative local optima, or larger missingness can produce different errors or explicit failure.

Rotation settings matter. Promax uses power four and Kaiser-normalized Varimax initialization. ML rotations use Varimax objective tolerance **1e-14** on both sides to reduce dependence on an arbitrary equivalent initial loading basis. The ML extraction is canonicalized before rotation without changing common covariance. Other ordinary MINRES Promax comparisons retain the `stats::promax`-style **1e-5** initializer; standalone ordinary Varimax uses **1e-9**; Oblimin uses gamma zero, no Kaiser normalization and **1e-7**. The stricter ML result is not claimed to equal an unchanged default `stats::promax` call to the same tolerance.

## Discrepancies found, independent review, and remaining boundaries

The [second pass](../frontend/scripts/efa-reference/congruence/second-pass-report.json) had **305 passing and 35 mismatching groups**, with no runtime/reference errors. Its raw errors were retained. Two independent agents reviewed each issue before implementation changes:

1. **Iterative PCA was an algorithmic variant.** The previous implementation used a simple tail-mean noise estimate and missing-cell-change stopping. Pinned missMDA instead uses residual-degrees-of-freedom adjustment with an eigenvalue cap, observed reconstruction SSE stopping after at least five passes, and returns the previous filled iterate when stopping. The previous maximum missing-cell difference was **0.0191866** on Holzinger MCAR raw-scale data; eigenvalue and score errors also exceeded their existing limits. The production implementation now follows the source contract. The limits were not relaxed to make it pass.
2. **ML Promax orientation was sensitive to early Varimax termination.** Identical likelihood/common-covariance fits could stop at slightly different rotated orientations: maximum pattern difference **0.00458809**, Phi **0.00191134**, despite closely matching likelihood/Sigma. Canonicalizing the standardized extracted basis and tightening the same Varimax criterion on both sides resolved it. This is a finite-iteration convention change, not a different likelihood or a Procrustes alignment.

Earlier partial attempts and their reference errors are also retained as `initial-legacy-report.json`, `initial-ml-report.json` and `attempts/initial-reference-generation.log`. The first R attempt used excessively strict Oblimin settings and encountered reference optimizer failures; a generator file was edited while R was still reading it, leading to a final parse failure. Subsequent reference generation used an immutable source snapshot. These aborted attempts do not count in the final pass denominator.

**Parallel-analysis psych-default boundary.** The saved source specifies the one-factor bounded lower-triangle MINRES objective, numerical derivatives, lower uniqueness .005, upper uniqueness 1, and tight R `optim` settings. That independently implemented objective matches the TypeScript analytic implementation. The saved default psych results are a separate comparison: 18 of 300 null spectra differ by more than 1e-4; maxima are **0.759384 normal**, **0.310732 heavy-tail**, and **0.000430459 skew**. Neither method is uniformly better by objective value; some weak-null solutions take different optimizer paths. Their 95th-percentile reference-curve maximum differences are **3.82721e-5**, **1.04657e-5**, and **2.27358e-5** respectively, with **two suggested factors in both** for all three observed datasets. The report preserves this package-default compatibility gap; a small observed decision difference cannot establish general decision equivalence.

Two independent reviewers examined the pinned psych source and reproduced representative discrepancy cases. psych's supplied MINRES gradient includes diagonal residuals, whereas the TypeScript gradient differentiates the stated lower-triangle objective; the latter agrees with central finite differences within2.91e-12 in the checked cases. psych stopped by relative objective reduction with true projected-gradient norms6.70e-6 and3.05e-6; the separately optimized R points were stationary to6.65e-10 and5.31e-9. Crucially, the heavy-tail case's psych feasible point has a **lower objective** than the tightly stationary independent-R point. Small gradient convergence is therefore not proof of the global minimum, and this sensitivity can also affect weak observed-data fits, not logically only null datasets. Exact source, reproduced fits and gradient evidence are retained in [psych-parallel-boundary](../frontend/scripts/efa-reference/congruence/psych-parallel-boundary).

**Iterative PCA default-budget boundary.** Exact Iris punches are retained under [iris-boundary](../frontend/scripts/efa-reference/congruence/iris-boundary). Four seeds × 5%, 20%, and 35% MCAR were run at threshold1e-8, rank2, scale=true. Both languages converge within the default 200 iterations in the four 5% cases and hit the cap in all eight 20%/35% cases. All converge by 887 iterations with a 1,000-iteration allowance. For seed20260805 the counts are115,298,887. All 24 matched configurations agree to **4.086e-14**; the separate counter-only R instrumentation reproduces unchanged adapter output exactly. At the default cap, however, the largest difference from eventual convergence is **0.113624**, not a rounding error. The app's nonconvergence flag remains necessary. Reference agreement at the cap does not establish convergence. See [R boundary report](../frontend/scripts/efa-reference/congruence/iris-boundary-report.json).

## Missing data, exports, and unsupported combinations

The completion replay uses 147 fixed fitting rows from the saved Holzinger MAR variant, reverses x1/x4, and adds one wholly unobserved fitting row. It preserves **1,129 observed values exactly** in the native operation, predicts **185 missing cells**, preserves source-row identities and missing masks, and leaves the wholly missing row unfilled. Executing the exported R code gives maximum prediction difference **6.218e-15**, with observed-value serialization difference **0**. This is an independent replay of saved parameters, not a second model fit. See [operation and executable R replay](../frontend/scripts/efa-reference/congruence/replay) and [replay report](../frontend/scripts/efa-reference/congruence/replay/r-report.json).

Conditional completion returns model-based expected values. It is not multiple imputation, does not add imputation uncertainty, and is not a mechanism for converting Gaussian predictions into valid ordinal categories. FIML fitting itself integrates missing cells; writing predictions to a dataset is a separate explicit operation. Column mean/median imputation, by contrast, implements the recorded category-preserving rule for categorical columns and ordinary numeric rules for continuous columns.

| Combination | Supported contract / limitation |
| --- | --- |
| ML + complete, column mean, column median | Gaussian ML after the explicit preprocessing; tested |
| ML + FIML | Observed-data Gaussian likelihood with fitted means; tested |
| ML + pairwise deletion | Rejected; pairwise covariance ML is not mislabeled as raw-data ML/FIML |
| ML/FIML + polychoric correlation | Rejected; no ordinal FIML likelihood is implemented |
| FIML + MINRES/WLSMV/PCA | Rejected; FIML belongs to the implemented latent Gaussian likelihood |
| MINRES + Pearson or polychoric | Tested, with complete/mean/median/pairwise policies |
| WLSMV + ordinal/polychoric moments | Tested; point extraction plus correction/SEs subject to explicit execution plans |
| WLSMV + arbitrary continuous/nominal input | Not an implemented weighted ordinal model |
| PCA + mean/median/complete/pairwise/iterative | Tested, both scaled and raw; pairwise covariance must be valid |
| Iterative PCA + EFA | Not offered; iterative PCA is its own missing-data model |
| Ordinal/binary chained imputation | Conditional fits, contrasts, completed values and subsequent EFA fits tested with identical recorded draws; no R/JS shared-seed identity claim |
| PCA on completed MICE datasets | PCA and exact chained completion are separately qualified; application batch wiring is covered by integration tests, not a second joint R MICE-PCA statistical study |
| Arbitrary continuous/nominal MICE conditionals | Not established by the ordinal/binary conditional reference matrix |
| ML parameter SEs, robust ML corrections, ordinal FIML | Not supplied or inferred from these point-fit comparisons |

## Largest synthetic speed qualification

The largest benchmark was deliberately deferred until the small-data accuracy gates and complete application test suite passed. The benchmark uses the existing seed8801 **20,000 respondents ×500 five-category items**, five factors. Pearson ML explicitly treats the category codes as numeric Gaussian measurements. Default ML settings are three starts,2,000 iterations per start,tolerance1e-7,uniqueness floor1e-6. The block-missing FIML case uses three deterministic row patterns: complete, first50missing, last50missing, giving666,650missing cells (6.6665%). A separate independent5%MCAR pattern uses seed73291 and a short cap to expose fragmentation cost.

Execution uses sequential isolated Node processes with hard wall caps: PCA120s, MINRES180s, weighted point fit180s, complete ML180s, block FIML240s, fragmented FIML90s. Native reports retain generation/preparation/correlation/extraction/rotation timings, convergence diagnostics, peak resident memory, input fingerprints, and progress at timeout. These are CPU execution measurements, not browser responsiveness or R speed comparisons. Full500-item robust WLSMV inference/SEs and full-sized MICE/bootstrap/100-permutation Cartesian products are excluded from this new speed run.

| Configuration | Wall time including generation | Main calculation stage | Child peak RSS | Result |
| --- | ---: | ---: | ---: | --- |
| Standardized complete PCA | 36.523s | PCA34.749s | 430.4MiB | Passed |
| Polychoric MINRES +3 rotations | 39.729s | Correlation21.150s; extraction/Promax12.642s | 269.1MiB | Converged |
| Ordinal weighted point fit +3 rotations | 79.413s | Correlation20.763s; pair influences50.411s; DWLS2.714s | 214.9MiB | Converged; robust correction excluded |
| Complete Gaussian ML +3 rotations | 27.949s | Correlation15.315s; ML/Promax3.020s | 360.7MiB | All3 starts converged |
| Three-pattern block FIML +3 rotations | 27.760s | Correlation13.886s; ML/Promax8.949s | 372.8MiB | All3 starts converged |
| Fragmented5%MCAR FIML | 90.058s cap | Correlation14.872s; still in start1 at iteration8 | ≥403.5MiB, last report | Timeout; no converged model returned |

The fragmented case contains500,028missing cells, about5.00028%, versus666,650cells in the block case. Fewer missing cells therefore did not imply less computation: many distinct observed-variable subsets prevent sharing most pattern-level calculations. At timeout the projected gradient was approximately1.083e-4, above the requested1e-7, during the first of three starts. Independent review classified this as an external computational-budget timeout, not a reported numerical failure. No completed fit exists for comparison, so **largest-case fragmented FIML TypeScript/R error is unmeasured**; neither eventual convergence nor divergence is established. The block result supports fragmentation as a performance explanation without establishing a controlled causal speed ratio. No filled dataset or final fit was fabricated from the interrupted state.

See the [benchmark receipt](../frontend/scripts/efa-reference/congruence/large-benchmark-receipt.json) and individual `large-*-report.json` artifacts. This was **one run per configuration on a shared workstation**, with a dev server and some short lint/UI checks during early runs; it is a feasibility/timing measurement, not an idle controlled speed comparison. Wall time includes generation; stage timing separates that cost. Successful child peak RSS is measured by `process.resourceUsage`. The external `ps` sampler was denied by the workspace sandbox, so its fields are null with an explanation, and the original raw receipt is preserved. Consequently the planned3GiB external RSS stop was unavailable; the4GiB V8 heap cap remained active. Recorded child peaks stayed below0.5GiB, but unobserved transient memory is not bounded by the last timeout report. Results at a cap are labeled timeout, never treated as converged fits. Both exact missing masks are reconstructed and SHA256-hashed in the receipt.

## Reproduction and application verification

From `frontend/`:

```sh
CONGRUENCE_OUTPUT=scripts/efa-reference/congruence/third-pass-report.json node scripts/efa-reference/congruence/run.mjs
CONGRUENCE_ENTRY=scripts/efa-reference/congruence/check-ordinal.ts CONGRUENCE_OUTPUT=scripts/efa-reference/congruence/ordinal-report.json node scripts/efa-reference/congruence/run.mjs
CONGRUENCE_ENTRY=scripts/efa-reference/congruence/check-extensions.ts CONGRUENCE_OUTPUT=scripts/efa-reference/congruence/extensions-report.json node scripts/efa-reference/congruence/run.mjs
CONGRUENCE_ENTRY=scripts/efa-reference/congruence/check-weighted-se.ts CONGRUENCE_OUTPUT=scripts/efa-reference/congruence/weighted-se-report.json node scripts/efa-reference/congruence/run.mjs
python3 scripts/efa-reference/congruence/summarize.py
npx vitest run src/lib/__tests__/efa-congruence.test.ts
```

Regenerate R fixtures in the pinned offline image with the entire `congruence` script directory mounted read-only at `/source`, the fixture destination at `/out`, and entrypoint `Rscript /source/generate.R /out /source`. Ordinal regeneration uses `generate-ordinal.R` and the retained `generate-weighted.R` helper under its expected `pair-moments-source.R` name; exact successful snapshots are archived for reproducing this run's source hashes. Export replay: `Rscript replay-completion.R operation.json r-completed.csv`, followed by `verify-completion-replay.R` on that folder. Iris: `check-iris-boundary.R SOURCE INPUT NATIVE OUTPUT`; retained probe source and hashes document native input generation.

The focused new R-backed regression tests cover FIML likelihood/covariance/completion/all rotations on synthetic, Holzinger and bfi data and the missMDA finite-iterate contract. The [application verification receipt](../frontend/scripts/efa-reference/congruence/app-verification.json) covers the full suite, assistant integration, typecheck, scoped lint, and production build. Formal algebra and source-binding evidence are documented separately in [EFA-FORMAL-VALIDATION.md](EFA-FORMAL-VALIDATION.md); finite R agreement does not turn those scoped identities into a proof of floating-point optimizer equivalence.
