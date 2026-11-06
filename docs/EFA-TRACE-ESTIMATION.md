# WLSMV exact traces and matrix-product estimation

This document records the initial matrix-product experiment. The follow-up [estimated MV integration](EFA-ESTIMATED-MV.md) now exposes it as an explicit WebGPU option while keeping exact as the default. The historical measurements and qualification boundaries below are retained. The experiment also removed duplicate arithmetic in diagonal GPU blocks and obtained the first trace from an existing covariance intermediate.

## The matrices

Write N for fitting respondents, p for items, k for factors, m = p(p−1)/2 for item pairs, and q = pk−k(k−1)/2 for identified loading parameters. The current benchmark has N = 20,000, p = 500, k = 5, m = 124,750 and q = 2,490.

| Matrix | Definition | Dimensions at this benchmark |
| --- | --- | --- |
| S | First-order respondent influences on estimated polychoric correlations, including estimated thresholds and pair-missing handling | 20,000 × 124,750 |
| D | Diagonal inverse asymptotic variances used by DWLS | 124,750 × 124,750, stored as a vector |
| J | Derivatives of model-implied correlations with respect to identified loading parameters | 124,750 × 2,490, exploited sparsely |
| A | S D^(1/2) / sqrt(N) | 20,000 × 124,750, implicit lookup representation |
| Q | D^(1/2) J L^(-T), with L L' = J'DJ | 124,750 × 2,490, conceptual |
| Z | A Q = S D J L^(-T) / sqrt(N) | 20,000 × 2,490 |
| H | A A' − Z Z' = A(I − QQ')A' | 20,000 × 20,000, evaluated in blocks |

Q has orthonormal columns. Z removes the influence directions associated with estimating the model's free loading parameters. Its columns are not respondent factor scores: there are q of them, not k. A is also not the original response table. Each column concerns an item pair, not one item.

H is symmetric and theoretically positive semidefinite. The two moments needed by the correction are tr(H) and tr(H²). In this empirical normalization each A column has squared norm one, giving

```
tr(H)  = ||A||F² − ||Z||F² = m − tr(Z'Z)
tr(H²) = Σ_i Hii² + 2 Σ_{i>j} Hij².
```

Z'Z is already computed for the sandwich covariance. The first identity therefore avoids any need to obtain the first trace from the Gram blocks. The second identity uses the symmetry of H; the implementation never multiplies H by itself or constructs H².

## Exact redundancy reduction

The coordinator already visited only lower-triangle blocks. The CPU kernel already skipped above-diagonal entries within a diagonal block. Previously the GPU calculated both halves inside each diagonal block and the host ignored one half.

The GPU now uses a separate triangular pipeline for diagonal blocks. Above-diagonal workgroups exit before loading or arithmetic. Threads in diagonal tiles cooperate in loading, but only the lower half performs dot-product arithmetic. The reduction mirrors those results into the full output block to preserve the existing kernel contract. Off-diagonal blocks retain the original dot shader, avoiding an added branch in the dominant path. Bindings for the two pipelines are cached independently and invalidated when buffers change.

For N = 20,000 and block size 128, the eliminated duplication is 1,268,464 of 201,278,464 computed entries: 0.6302%. This removes real redundancy but cannot produce a large whole-fit speedup. The full H eigenvalue calculation would require a much more expensive full-spectrum procedure; five fitted factors do not imply that H has rank five. The retained large benchmark's tr(H)²/tr(H²) is about 16,593.5, which is a lower bound on its rank under the PSD model.

## Experimental matrix products

For independent seeded Rademacher vectors v (entries ±1 with equal probability), E[vv'] = I, so

```
E[||Hv||²] = tr(H²)
Hv = A(A'v) − Z(Z'v).
```

The estimator averages these squared norms. Batched probes use V with N rows and s columns; the largest intermediate is A'V with m rows and s columns. Both the dense N×N H and expanded N×m A remain absent. The arithmetic scales as O(sN(m+q)), compared with O(N²(m+q)) for all exact entries.

The operator uses the same explicit-rounding split-f32 arithmetic as the exact kernel, GPU reduction of partials, resident ordinal lookups and Z, and final Float64 reconstruction/subtraction on the host. Its buffers have a 1 GiB owned-allocation limit and per-binding hardware checks. Probe streams reproduce across batch widths; the saved schedule is 32, then 32, then 64 probes, with checkpoints at 32, 64 and 128. These are fixed budgets, not adaptive stopping decisions.

Every report marks the result approximate and retains seed, probe count, individual squared norms, empirical Monte Carlo standard error, and a **normal-approximation** 95% interval. That interval is neither a rigorous bound nor a guarantee for repeatedly checking and stopping. Sampling error is distinct from floating-point error. The existing 1e−10 scaled numerical check remains unchanged. Primary method context: [Hutch++](https://arxiv.org/abs/2010.09649) and [adaptive trace estimation](https://arxiv.org/abs/2109.10659); this prototype implements the basic squared-norm estimator, not those papers' enhanced algorithms or their guarantees.

Only the second trace moment is approximated. DWLS loadings, rotations, parameter covariance and standard errors remain the same. The reported scale, shift, corrected chi-square statistic and p-value change, and the harness records their deltas from exact values.

## Measurements

Apple M1, 8 GiB RAM, Chrome 156.0.8078.80, no WebGPU developer flags. The saved exact 500-item / 20,000-row result has tr(H) = 50,256.20926658853, tr(H²) = 152,209.534696134 and corrected p = 0.46320230810213636.

| Probes | Seed | Operator time | Error in tr(H²) | Change in corrected p |
| --- | --- | --- | --- | --- |
| 32 | 61001 | 9.05 s | +0.04469% | +0.00000808 |
| 32 | 61002 | 9.51 s | −0.03160% | −0.00000571 |
| 64 | 61001 | 17.65 s | −0.01686% | −0.00000305 |
| 64 | 61002 | 18.27 s | +0.01232% | +0.00000223 |
| 128 | 61001 | 34.82 s | +0.05037% | +0.00000910 |
| 128 | 61002 | 36.42 s | +0.03870% | +0.00000699 |

The 128-probe estimates are 152,286.20095 and 152,268.44144. Their empirical Monte Carlo standard errors are 104.06 and 96.72; the normal-approximation intervals both contain the exact value. More probes reduce uncertainty in expectation; a realized prefix need not move monotonically closer to the reference, as this table demonstrates.

The historical exact trace stage took 1,376.89 seconds (22.95 minutes). These operator times are about 38–40 times shorter, **for the trace stage only and using a historical timing comparison**. New-run source preparation still took 345.38 seconds, including 267.09 seconds for projections/covariance; operator startup added 1.36 seconds. The two-seed experiment took 422.46 seconds total and did not repeat rotation/rotated-SE/scoring stages. It is not a new complete application-fit benchmark. Peak owned operator GPU buffers were 536,723,712 bytes (511.86 MiB). The page heartbeat's largest gap was 117.9 ms; this measures the qualification page, not dashboard interactions.

On the fresh 2,000-row / 60-item pilot, three 128-probe seeds had trace errors +0.7351%, +0.3278% and +0.1624%, with absolute p-value changes below 0.00091. Across the five small R-reference fixtures and three seeds, the largest 128-probe trace error was 9.6171% (complete-case fixture) and the largest absolute p-value change was 0.01313. Small-case exact moment-space calculation remains cheap. These contrasts argue against a universal probe count or silently replacing exact traces.

The matrix-product arithmetic passed all seven Float64 self-checks, including target-length reduction axes, at the unchanged 1e−10 scaled tolerance; the largest measured scaled error was 9.81e−13. Actual R-fixture operator outputs also passed Float64 checks. Exact pilot traces agreed with the independent R fixtures within the existing tolerances (largest statistic difference below 6e−8). These numerical results are separate from the sampling errors above.

Evidence: `frontend/scripts/efa-reference/compute/trace-estimation-large-v5.json`, `trace-estimation-pilot-release-v5.json`, and their referenced immutable worker archives. The large run preceded the extra full-axis self-check additions; the numerical operator and shader arithmetic are unchanged between these two reports. Both archive the executed code.

## Reproduction and scope

From `frontend/`, build with `node scripts/efa-reference/compute/build.mjs`. Start/reuse the app with `dev start frontend --detach --json --yes` from the repository root. Then run:

```
node scripts/efa-reference/compute/check-trace-estimation.mjs pilot
node scripts/efa-reference/compute/check-trace-estimation.mjs large
```

Use a distinct output filename as the second argument to preserve prior evidence. The pilot uses five synthetic R-reference fixtures and a 2,000-row / 60-item synthetic fixture, comparing against freshly computed exact traces. The large experiment reproduces the saved 500-item / 20,000-row input hash, objective and first trace, then compares against the completed historical exact WebGPU result. Its timing comparison is historical, not a paired full rerun. The skipped full JavaScript CPU baseline is not run.

Reports retain immutable executable hashes and compressed worker bytes, shader hashes, browser/hardware, stage timings, sampled process RSS and UI heartbeat. No private participant inputs or paid provider calls are used. Full-axis Float64 operator checks exercise the target pair count, respondent count and parameter count separately to keep the oracle tractable; they do not constitute a full-sized Float64 comparison of every operator output.

At this experiment stage, approximate values stayed outside the application service, workspace state and assistant tools. The subsequent [UI integration](EFA-ESTIMATED-MV.md) adds explicit labeling, persistent probe/seed/uncertainty metadata, an exact default and continued numerical self-checks. No automatic accuracy promise or estimator substitution is justified by these measurements.

## Regression verification

The final change passed 676 tests (4 intentionally skipped), TypeScript, and a production static build in a fresh isolated copy of the workspace. The first older temporary build copy had incomplete dependencies; the fresh copy used the workspace's complete installed dependency tree. Lint remains at the existing baseline of 117 errors and 6 warnings, with no new file/rule/severity groups or increased counts.

The production-service browser run completed 45 fits (five fixtures × three rotations × CPU/GPU-128/GPU-256), with 30 cross-backend comparisons, backend numerical self-checks, invariant cache checks and persistence validation. Inspector cancellation during an actual WebGPU trace job took 205 ms and published no result. The final triangular kernel also passed all ten full-sized resident reference ranges at the unchanged 1e−10 tolerance (maximum scaled error 6.12e−14). These checks do not repeat a complete 500-item exact fit or test every GPU vendor.

Additional evidence: `trace-workflow-final-v5.json`, `triangle-resident-final-v5.json`, `trace-ui-v5/cancel-webgpu.json`, and `trace-verification-v5/audit.json`, under `frontend/scripts/efa-reference/compute/`.
