# Runtime guidance and paired MV qualification

The runtime UI keeps **exact correction as the default** and offers a separate selection of Browser CPU, WebGPU and Scala. Each runtime has a keyboard- and touch-accessible information button. WebGPU is labeled **exact** or **estimated** according to the selected correction; it is not intrinsically approximate. Scala remains an explicitly paired local JVM/BLAS benchmark. Probe count, seed, block size and memory budget also have contextual explanations.

After sample preview, advice uses the actual fitting rows, item-pair count, factor count, probe budget and allocation plan. It never changes the chosen method or backend. Small feasible moment-space calculations favor exact CPU as a starting point. Estimated case-space traces are suggested for consideration when their arithmetic count is lower. These are operation estimates, not device timing predictions or accuracy guarantees. Invalidated previews hide the advice until refreshed.

For n fitting rows, m = p(p−1)/2 item correlations, q = pk−k(k−1)/2 identified model parameters and s probes, the leading case-space dot-product work is approximately:

- Exact: n²(m+q)/2, already exploiting symmetry.
- Estimated: 2ns(m+q), using H V = A(A′V) − Z(Z′V).

Their ratio is about n/(4s), but a small item battery may have a cheaper exact moment-space path. Common covariance, fitting and rotation costs, memory limits, device throughput and startup also matter. A rule based only on n × p cannot represent these choices. The preview's existing memory/operation description now labels estimated correction correctly.

## What zero degrees of freedom means

This correlation-based EFA parameterization has df = m − q. Item thresholds are estimated in both the unrestricted and fitted correlation descriptions, so they cancel in this count. With three standardized items and one factor, m = 3 and q = 3. Provided an admissible locally identified solution exists, there are no remaining correlation restrictions for a global fit test. The three loadings can still be estimated and receive parameter standard errors.

The implemented MV calculation uses a = sqrt(tr(H²)/df) and shift = df − tr(H)/a. The corrected statistic is df + (T_raw − tr(H))/a. At df = 0, the positive-degree-of-freedom chi-square comparison is unavailable; the implementation reports null correction/test/p-value fields. This is not evidence for a correct substantive model, and MV adjustment cannot create missing testable restrictions. Boundary or inadmissible solutions are separate issues.

Lavaan's [mediation example](https://lavaan.ugent.be/tutorial/mediation.html) similarly shows a zero-df model without a global chi-square p-value while still reporting parameter standard errors.

## When random probes have the most error

Let M = H², t = tr(M) > 0 and let s independent Rademacher probes estimate t. Then:

```
Var(t_hat) / t² = (2/s) [tr(M²) − sum_i M_ii²] / t².
```

Consequences:

1. Scaling H by c scales t and its Monte Carlo standard error by c². Relative accuracy is unchanged.
2. A diagonal M has zero Rademacher trace variance, even if it has rank one.
3. A dominant eigenvalue with a dense eigenvector creates large off-diagonal energy and can make relative error large. A large number of rows does not eliminate this case.
4. Writing r_eff = tr(M)² / tr(M²), relative SE is at most sqrt(2/(s r_eff)); the actual diagonal term can make it much smaller.

For the ideal centered EFA operator, H = A(I − QQ′)A′, where Q contains q independent fitted-model directions in the m-dimensional correlation space. Its rank is at most min(n−1, m−q). This helps interpret the earlier fixtures: 8 items and 2 factors leave only 28−15 = 13 correlation restrictions, whereas 500 items and 5 factors leave 124,750−2,490 = 122,260 (with rank also limited by 20,000 respondents). For example, five items with two factors leave only 10−9 = 1 restriction, so the ideal residual operator has rank at most one. A small battery or a factor count close to saturation limits the available residual directions. Increasing respondents alone cannot raise the rank beyond m−q. Having room for many directions permits, but does not guarantee, a larger effective rank and lower variance.

There is a sharper worst-case statement when only n and t are fixed. Because M is positive semidefinite, tr(M²) ≤ t² and sum_i M_ii² ≥ t²/n. Therefore:

```
relative RMS Monte Carlo error ≤ sqrt((2/s)(1 − 1/n)).
```

Equality is attained by a rank-one M with a dense equal-magnitude eigenvector. Balanced signs can keep that direction orthogonal to the all-ones vector, so centering alone does not remove this construction. At 128 probes and large n this RMS bound approaches **12.5%**. This is a standard-deviation/RMS statement over random probe draws, not a maximum error for a particular run and not a 95% bound. Individual deviations can be larger. The implementation's empirical normal interval is also not a rigorous worst-case guarantee.

A large relative trace error does not transfer one-for-one to the corrected test statistic. If T2 is changed to T2(1+e) while the exact first trace and DWLS statistic stay fixed, then:

```
T_corrected,new − df = (T_corrected,exact − df) / sqrt(1+e).
```

The resulting p-value sensitivity depends on df and where the statistic lies. Qualification therefore records the corrected statistic and p-value deltas as well as trace error.

This variance analysis follows directly from the Rademacher fourth moments; `trace-error-shapes.ts` independently enumerates all sign vectors for small matrices before testing seeded production probe streams. The [Hutch++ paper](https://arxiv.org/abs/2010.09649) provides method context and a potential later variance-reduction approach. This change does not implement Hutch++ or alter the qualified estimator.

## Measured operator stress cases

The operator experiment used 128 probes and 256 saved seeds per case. Exhaustive enumeration of all 256 sign vectors at dimension 8 matched the theoretical mean and variance for four ranks. It then used the production probe generator and uncertainty summary with an independent factorized operator application.

| Operator | Dimension | Rank | Trace of H² | Observed RMS relative error | Largest absolute error among 256 seeds | Approximate 95% interval coverage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Dense, centered | 256 | 1 | 1 | 13.24% | 42.92% | 91.4% |
| Dense, centered | 256 | 4 | 1 | 6.60% | 22.08% | 92.6% |
| Dense, centered | 256 | 16 | 1 | 3.17% | 9.63% | 94.1% |
| Diagonal | 256 | 1 | 1 | 0% | 0% | 100% |
| Dense, centered, rescaled | 256 | 1 | 10¹² | 13.24% | 42.92% | 91.4% |
| Dense, centered, larger | 4,096 | 1 | 1 | 12.69% | 38.60% | 93.8% |

These deliberately constructed operators locate estimator weaknesses; they are not claims about typical Likert data or prevalence of such matrices in EFA. The observed maximum is not a population bound. Normal-interval coverage was below 95% in these finite stress samples, consistent with keeping its approximate label. A diagonal rank-one operator is included to distinguish eigenvalue concentration from orientation. The scale control changed relative errors by at most 1.5e-15. Raw draws and the exhaustive checks are retained in `frontend/scripts/efa-reference/compute/trace-error-shapes-v7.json`.

## Reproduction

Start the current checkout with `dev start frontend --detach --json --yes`. From `frontend/`:

```
node scripts/efa-reference/compute/check-paired-full.mjs pilot <new-pilot-output.json>
node scripts/efa-reference/compute/check-paired-full.mjs large <new-large-output.json>
```

The runner refuses to overwrite an existing report. It uses separate ordinary Chrome processes and fresh production services for exact and estimated arms, the same deterministic synthetic responses and model settings, and immutable archived worker/client sources. Each arm includes a cold oblimin fit, scoring and cached promax/varimax comparisons. There is no historical exact timing substituted into the new pair. It records self-checks, convergence, stage timings, memory sampling, heartbeat and unchanged-output parity. Browser launch and synthetic input generation are excluded from the reported analysis time and identified separately. The order is exact then estimated, one pair on one machine, with other applications permitted to remain active.

The independent dashboard at localhost:3001 is a source snapshot of commit `2029568`, held under `/tmp/scatter-lab-play-2029568` with its own build directory. It was started with `dev` and verified by a completed HTTP 200 response. Its browser storage is separate from localhost:3000. It does not run a Scala companion.

The operator-error chart is available as [PNG](figures/efa-mv-error-shapes-v7.png), [PDF](figures/efa-mv-error-shapes-v7.pdf) and [figure specification](figures/efa-mv-error-shapes-v7.json). Reproduce it with `frontend/scripts/efa-reference/plot-mv-paired.py` and `matplotlib==3.10.7`; the same script emits the fresh paired full-fit chart only after that report has passed.

Runtime UI evidence: `frontend/scripts/efa-reference/compute/runtime-ui-v7/report.json` covers exact defaults, all information buttons, distinct exact/estimated WebGPU explanations, refreshed-preview guidance, keyboard focus, both themes and a 390-pixel viewport. Its first failed attempt was an ambiguous test locator; the corrected exact-name locator passed. No product tolerance or behavior was relaxed.

The verbose large paired report is retained losslessly as `paired-full-large-v7.json.gz`, with a compact `paired-full-large-v7.summary.json`. The raw `.json` remains local and is ignored by Git to avoid committing more than 80 MB of repeated numerical arrays. `archive-paired-full.mjs` verifies a byte-identical decompression and records both hashes. The plotter accepts the compressed report directly.

## Fresh paired full-fit result

The completed pair used 20,000 respondents, 500 items and five factors on Apple M1 / 8 GiB / Chrome 156.0.8078.81. Both arms passed their numerical self-checks without WebGPU developer flags. Input fingerprints match. All compared correlations, loadings, factor correlations, communalities, rotated standard errors, first traces and respondent scores have zero observed difference across all three rotations (the acceptance tolerance remains 1e-10).

| Timing scope | Exact WebGPU | Estimated WebGPU, 128 probes | Speedup in this pair |
| --- | ---: | ---: | ---: |
| Initial oblimin fit, including rotated SEs | 29.25 min | 8.45 min | 3.46× |
| MV trace stage within that fit | 22.08 min | 42.44 s | 31.21× |
| Full workflow including scores and cached Promax/Varimax comparisons | 30.61 min | 9.98 min | 3.07× |

The estimated trace was 152,286.2009534 versus exact 152,209.5346961: **+0.0503689%** observed error. Its reported Monte Carlo SE was 104.0617253 (0.0683% relative to the estimate), with normal interval [152,082.2399717, 152,490.1619351], which contains the exact value. Seed: 61001. The corrected chi-square changed from 122,305.0145472 to 122,305.0032148; p changed from 0.4632023081 to 0.4632114096. This is one realized probe stream, not an accuracy guarantee.

Timing components are elapsed wall stages, not summed CPU time from parallel workers. Non-trace work varied between arms; for example, oblimin derivative work was about 121 seconds in the exact arm and 167 seconds in the estimated arm. Other interactive applications were available, and lightweight UI/operator checks ran during part of the exact trace. The full suite and production build waited until both arms finished. The pair is not a repeated, order-balanced, idle-machine performance experiment. Its direct full-workflow measurement is nevertheless more informative than applying the trace speedup to the whole fit.

Both browsers completed without failure. The 50-ms heartbeat continued, with maximum observed gaps of 1.45 s and 1.54 s; this measure includes fixture generation and result handling, and does not establish zero UI stalls or attribute those gaps to a particular operation. Two-second summed Chrome-process RSS peaked at approximately 1.23 GiB exact and 1.12 GiB estimated; shared pages can be counted more than once and this is not a total device-memory measurement.

The fresh small pilot (1,000 × 20) took 1.455 s exact versus 1.822 s estimated for the same full workflow. This reinforces the exact default for small batteries. The earlier failed pilot accidentally requested five factors for eight items; it was rejected as underidentified, and its report remains retained. No estimator, tolerance or factor count was silently substituted.

[Fresh timing plot](figures/efa-mv-paired-full-v7.png) · [PDF](figures/efa-mv-paired-full-v7.pdf) · [timing CSV](figures/efa-mv-paired-full-v7.csv).

## Final verification

The full unit suite passed with 691 tests passed and four skipped. TypeScript and the production build passed; all 202 application source files in the isolated build match the current checkout. The lint regression comparison remains at its existing 117 errors and six warnings, with no additional file/rule/severity counts. This is a passing regression gate, not a clean lint baseline. The runtime UI checks passed in both themes, including keyboard focus and the narrow viewport. Benchmark source archives and the compressed result were verified against their recorded hashes and lossless decompression.

The consolidated audit and retained validation logs are in `frontend/scripts/efa-reference/compute/runtime-verification-v7/`. Commit `2029568` contains the earlier backend and estimated-MV implementation. The runtime information controls, advisory guidance, new benchmarks and documentation described here are subsequent working-tree changes; they have not been committed or pushed. The independent dashboard remains the frozen committed snapshot.
