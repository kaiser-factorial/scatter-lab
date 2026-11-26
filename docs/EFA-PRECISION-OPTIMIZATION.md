# Default-browser WebGPU precision and weighted-inference optimization

The next phase is documented in [trace throughput and parallel rotation derivatives](EFA-THROUGHPUT-ROTATION.md). This report retains the prior checkpoint measurements.

This continues the retained [backend comparison](EFA-COMPUTE-COMPARISON.md).
The original full JavaScript/CPU baseline remains skipped. Public and synthetic
fixtures are used throughout; no participant data or paid provider calls are
part of qualification. Prior successful and failed reports are retained.

## Precision method

The default-browser candidate uses two f32 components per input, explicitly
rounded arithmetic, a Dekker-style product residual, compensated chunk sums,
and a separate GPU reduction. It does not request `strictMath`, use Chrome's
WebGPU developer flags, or rely on fused evaluation of WGSL `fma`.

`portable-shader.mjs` observes intermediate floating-point bits through an
integer XOR with a uniform mask supplied as zero. The mask is unknown when
the shader is compiled; a plain pair of bitcasts could otherwise be eliminated
as an identity. These integer observations separate the arithmetic steps used
to recover rounding errors. The product residual splits each 24-bit f32
significand into two at-most-12-bit pieces and uses ordinary separately rounded
multiplications and additions.

This addresses the permitted reassociation and optional fusion described in
the [WGSL specification](https://www.w3.org/TR/WGSL/#floating-point-evaluation).
It is a tested split-f32 strategy, not an implementation of general IEEE
binary64 arithmetic. Tests on this adapter do not establish correctness or
performance on every browser, GPU driver, or future compiler. Device-specific
numerical self-checks remain necessary before a future production selector.

The harness records requested flags, shader precision metadata, executable
worker hashes, and (in the updated harness) WebGPU-related flags observed through
Chrome's runtime command line. Temporary profile paths and unrelated command
arguments are not recorded. A shared verifier rejects developer flags,
unqualified code hashes, incomplete score vectors, missing standard errors,
invalid convergence, and mismatched inputs. It uses the original tolerances
and matches rotations only by signs and permutation.

## TypeScript changes

`weighted-linalg.ts` contains three bounded operations:

1. Case projections use 32-row respondent tiles and a compact sparse Jacobian. Every
   respondent retains the original ascending pair and parameter accumulation
   order. Missing observations still contribute zero. The memory planner adds
   the Jacobian storage and the typed triangular-factor copy explicitly.
2. Triangular solves and covariance accumulation use contiguous typed rows.
   The triangular inverse skips known zero entries while retaining the order
   of all nonzero terms. Public `ml-matrix` wrappers share the resulting arrays;
   private matrix storage is not accessed.
3. Covariance propagation packs `Cij + Cji` and the original diagonal, evaluates
   four derivative vectors per traversal, and skips genuinely zero entries in
   sparse derivatives. It retains both sides of any roundoff asymmetry. This
   changes summation order, so independent numerical parity is required.

The rotation map, finite-difference steps, half-step stability test, Richardson
extrapolation, sign/permutation matching, and inadmissible-variance checks are
unchanged. The full rotation-dependent standard errors are still computed.
Saved new analyses identify the numerical engine as `scatter-efa/5`.

## Native block construction

`TraceServerTiled.scala` is a separately retained candidate. It traverses pairs
first, reads each pair's contiguous range of respondent codes, and writes the
block directly in column-major form for BLAS. The corresponding BLAS transpose
flags and leading dimensions change together. The mathematical product remains
`A B' - ZA ZB'`. Reused buffers explicitly write zeros for missing observations;
ragged blocks followed by full blocks are part of the comparison.

The older row-major and row-cache sources remain available as baselines. Thread
counts are requests to the BLAS runtime, not observed thread counts. Neither
native prototype is a Spark or Dask cluster or a production local companion.

`TraceServerBlocked.scala` provides a second construction candidate: it keeps
the original row-major BLAS layout but traverses a bounded tile of 256 pairs
across the respondent block, using a reused cache of at most 128 rows of item
codes. Measuring both layouts distinguishes better lookup locality from any
change in BLAS performance caused by transpose/layout choices.

## Qualification record

All artifact names below are relative to
`frontend/scripts/efa-reference/compute/`.

| Evidence | Artifact | Status |
| --- | --- | --- |
| 17 saved kernel fixtures, including cancellation stress, default browser | `gpu-portable-kernels-v1.json` | Passed at scaled absolute `1e-10` |
| Ten large resident-input cases, including missing responses and ragged edges | `gpu-portable-resident-v1.json` | Passed at scaled absolute `1e-10` |
| Five independent R pipeline fixtures with the original TypeScript stages | `browser-portable-qualified-v1.json` | Passed |
| Full output comparisons of those five fixtures against native Float64 | `portable-small-comparison-v1.json` | Passed |
| Five R fixtures with the new TypeScript stages and observed runtime flags | `browser-portable-optimized-qualified-v1.json` | Passed, empty WebGPU runtime flag list |
| Five R fixtures with the new TypeScript stages and pair-major Scala kernel | `scala-tiled-qualified-v1.json` | Passed for native and small CPU references |
| Final unit suite, including weighted and targeted linear-algebra tests | `portable-unit-verification-v2.json` | 630 passed, four intentional skips |
| Shared comparison verifier rejection tests | `portable-comparison-guards-v1.json` | Nine passed |
| Default-browser provenance and output rejection tests | `portable-guards-v1.json` | Six passed |
| 500-item, 20,000-row default-browser fit before TypeScript optimization | `browser-large-gpu-portable-v1.json`, `portable-full-comparison-v1.json` | Passed, 48.30 minutes |
| Serial pair-major layout and TypeScript measurements | `portable-measurement-sequence-v1.json` | Completed |
| Serial pair-tiled row-major layout measurements | `blocked-measurement-sequence-v1.json` | Completed |
| Final 32-row TypeScript tile and default-browser GPU, five R fixtures | `browser-portable-final-qualified-v2.json` | Passed, observed runtime flags empty |
| Final 32-row TypeScript tile and pair-tiled row-major native kernel, five R fixtures | `scala-blocked-final-qualified-v2.json` | Passed |
| Final configurations, full-size and saved holdout comparisons | `portable-final-sequence-v2.json` | Qualified; all four full-output comparisons passed |
| Final GPU configuration, 500 items and 20,000 rows | `browser-large-portable-optimized-v2.json`, `portable-large-optimized-comparison-v2.json` | Passed, 39.74 minutes, requested and observed flags empty |
| Final native configuration, 500 items and 20,000 rows | `scala-large-blocked-optimized-v2.json`, `native-large-optimized-comparison-v2.json` | Passed, 34.69 minutes |
| Final GPU configuration, saved 6,000-row holdout | `browser-large-holdout-portable-optimized-v2.json`, `portable-large-holdout-optimized-comparison-v2.json` | Passed, 14.14 minutes, identical saved membership |
| Final native configuration, saved 6,000-row holdout | `scala-large-holdout-blocked-optimized-v2.json`, `native-large-holdout-optimized-comparison-v2.json` | Passed, 14.71 minutes, identical saved membership |

The full-size run uses immutable archived worker bytes matching its small R
qualification. Editing or rebuilding the worktree cannot replace those bytes
mid-run. Small regression and reference checks were performed while this first
full fit was active; its elapsed time is an observed run under development
activity, not an isolated causal benchmark. The targeted optimization trials
ran serially after it finished. The full precision-only fit's absolute
robust-statistic difference from the archived native result was `8.91e-9`, its
maximum standardized-score difference was `1.24e-9`, and its maximum reported
standard-error difference was `4.94e-7`. All passed the existing tolerances.
The isolated Chrome process RSS sample peaked at 1,089,306,624 bytes, and the
maximum UI heartbeat gap was 662.5 ms. The cancellation call took 0.8 ms; this
measures worker termination, not GPU command retirement. Its earlier harness
recorded empty requested flags but did not yet observe Chrome's runtime command
line; final v2 runs record both.

## Measured substage optimizations

The TypeScript comparison used three alternating-order repetitions including
allocation. These are synthetic substage timings, not whole-fit speedups.
Projection and normalization results matched the saved baseline bytes exactly;
covariance propagation passed absolute `1e-10` agreement.

| Substage | Original median | Candidate median | Ratio |
| --- | ---: | ---: | ---: |
| Case projections, 512 rows, 500 items, five factors | 2,970.1 ms | 1,032.3 ms, tile 32 | 2.88x |
| Triangular normalization, covariance and inverse, 128 rows, 768 parameters | 531.2 ms | 160.2 ms | 3.31x |
| Covariance propagation, 64 outputs, 2,490 parameters | 419.8 ms | 137.7 ms | 3.05x |

Projection tiles 64 and 128 also passed, with medians of 1,110.3 and 1,053.6 ms.
The smaller measured winner, 32, is the default; this does not establish an
optimal tile for every processor or workload. Raw repetitions and input/code
hashes are in `linalg-optimization-v1.json`.

The native trials each cover ten resident-input ranges repeated five times;
the table reports the median of the last four complete range sequences.
All candidates passed the saved Float64 output comparisons at scaled absolute
`1e-10`, including missing cells and ragged edges.

| Layout | Requested BLAS threads | Warm median for ten ranges |
| --- | ---: | ---: |
| Earlier row-cache candidate | 4 | 2,431 ms |
| Pair-major, direct column-major construction | 1 | 868 ms |
| Pair-major, direct column-major construction | 4 | 1,399 ms |
| Pair-tiled row-major construction | 1 | 1,045 ms |
| Pair-tiled row-major construction | 4 | 804 ms |

The two fastest candidates are close and individual repetitions vary. The
pair-tiled row-major candidate with four requested threads was selected for
full-fit qualification; the other sources and measurements remain available.
This is a selection for the measured M1 host, not evidence that four threads or
this layout is universally best. The observed warm median is about three times
faster than the earlier row-cache measurement; end-to-end gains must be assessed
from full fits. Construction and BLAS time are also retained separately in
`native-pair-major-{1,4}-v1.json` and `native-pair-blocked-{1,4}-v1.json`.

## Full-size GPU result after TypeScript changes

The final 500-item, 20,000-row, five-factor GPU fit completed in 39.74 minutes,
including all three rotations, their full standard errors, and complete-response
scores. This is 8.56 minutes (17.7%) shorter than the precision-only fit's 48.30
minutes. These are two observed runs, not repeated controlled estimates; the
earlier run overlapped some development checks. GPU dispatch/readback itself
was slightly longer in the final run (24.35 versus 23.51 minutes), while elapsed
robust-inference work outside that measured interval fell from 11.96 to 4.25
minutes. That difference includes host preparation and coordination, not solely
CPU instruction time.

The robust statistic, loadings, communalities, standard errors and standardized
scores all passed the original full-output tolerances against the archived
native reference. Maximum errors remain at the precision-only run's levels.
The executable hash is
`b700b5ff2e9dc2ed63c7cde2aac4216bdeedd718893e26c21da8a2c2072d6bc4`,
the same as the final five-fixture R qualification. Requested browser flags and
the observed WebGPU/Dawn runtime flag list are both empty.

Sampled Chrome process RSS peaked at 1,047,986,176 bytes. The largest heartbeat
gap was 444.9 ms; the post-fit worker-termination call took 0.5 ms. GPU command
retirement is not measured by that cancellation probe. Owned GPU buffers were
573,796,672 bytes; these must not be added to process RSS as a physical-memory
total, particularly on this unified-memory host.

The new phase timings expose the remaining costs: trace blocks took 24.69
minutes, while the three rotation derivative calculations took 9.67 minutes
combined. Case projection took 46.1 seconds, parameter covariance 149.5 seconds,
and the triangular inverse 2.9 seconds. Phase times measure elapsed intervals
between progress-stage transitions, including any unreported work until the
next transition; they are not hardware profiler samples.

## Full-size native result after block and TypeScript changes

The selected pair-tiled row-major kernel completed the same full workload in
34.69 minutes. It used the same final TypeScript pipeline hash as the GPU and
five-fixture R qualification, and the Scala source hash was
`de254b681011a64a2c5d93b001749c9091df118c9b406ae4dc2148fcdfa4e854`.
The verifier also matched compiled bytecode, protocol, native options and the
request for four BLAS threads to that independent-R qualification.

Loadings and score vectors matched the archived native reference exactly.
The largest standard-error difference was below `7e-17`; the corrected statistic
differed by `1.46e-11`. All existing tolerances passed. The 12,403 native requests
spent 8.48 minutes constructing blocks and 9.21 minutes in BLAS. The complete
trace phase took 18.27 minutes including setup and transport; resident-source
initialization took 23.39 seconds. This separates the construction improvement
from the remaining matrix-multiplication cost.

On this host the final native fit was 5.05 minutes shorter than the final GPU
fit. This is one serial observation per final configuration, not a universal
backend ranking. The earlier native full-fit record had an explicit pause and
only an estimated active duration, so it is not used as an uninterrupted timing
baseline here. The final native process-tree RSS sampler peaked at 832,585,728
bytes; this is an observed RSS measure, not an allocation or physical-memory
total. The native path is still a local JVM/BLAS kernel with a TypeScript/Node
pipeline, not a full Scala rewrite or a browser-native Scala runtime.

## Saved holdout comparison

The final default-browser GPU fit on the saved 6,000-row holdout completed in
14.14 minutes. It passed the unchanged full-output tolerances and exact saved
membership comparison. The corrected-statistic difference from the previous
native holdout result was `2.55e-8`; requested and observed WebGPU flag lists
were empty. Chrome process RSS peaked at 988,364,800 bytes, the largest heartbeat
gap was 266.6 ms, and the post-fit worker-termination call took 0.7 ms. The same
cancellation and RSS interpretation limits as the full-size fit apply.

The selected native holdout fit completed in 14.71 minutes. Its robust-test
outputs, loadings and score vectors matched the archived native reference
exactly; the maximum standard-error difference was `1.10e-16`. Saved membership
also matched exactly. The native kernel spent 38.31 seconds constructing blocks
and 39.49 seconds in BLAS, with 1.59 seconds initializing resident source data.
The process-tree RSS sample peaked at 743,571,456 bytes. Both holdout runs use
the same qualified final pipeline/source combinations as the full-size runs.

| Final configuration | 500 items, 20,000 rows | 500 items, saved 6,000-row holdout |
| --- | ---: | ---: |
| Default-browser WebGPU | 39.74 min | 14.14 min |
| Scala/JVM + native BLAS | 34.69 min | 14.71 min |

Each fit uses five factors, 128-row trace blocks and a 1,536 MiB inference
budget, and includes three rotations, full standard errors and oblimin scores.
Fit times exclude compilation/launcher overhead. These single serial runs on
an Apple M1 with 8 GiB are workload-specific observations: native was faster
for the full fit, while GPU was slightly faster for this holdout. They support
measuring each backend on a target device rather than treating either as a
universal performance winner.

## Final application verification and evidence audit

`portable-regression-v2.json` records a passing final verification sequence:
630 unit tests passed, four intentional tests were skipped, TypeScript passed,
and the lint regression gate found no increased per-file/rule/severity counts.
The existing lint baseline remains 117 errors and six warnings; this is a
regression pass, not a claim that the repository is lint-clean.

The isolated production build passed from
`/tmp/scatter-portable-build-xwKuMn`. It excluded `.env*`, temporary qualification
assets, the active `.next` directory and incremental TypeScript artifacts.
The required `dev` launcher verified the development server by HTTP response.
Browser checks passed for WLSMV fits, rotation comparisons, item refits, scores,
exports, holdout history and workspace reload. Inspector checks passed for
worker timing, result acceptance, source-identifier-free diagnostic exports,
both themes, a 390px viewport, Escape dismissal and focus handling. New reports
and screenshots are retained under `portable-ui-v2/`, preserving older evidence.
The two theme comparison screenshots and mobile inspector were visually reviewed.

A fresh build of the numerical bundle matched the exact qualified final hash.
All 19 retained executable/source archives matched their hash-based filenames.
`portable-completion-audit-v2.json` ties the current source hashes, four final
fit results, numerical comparisons and regression evidence together. The
earlier rejected default-GPU experiments and successful strict-math experiments
remain preserved in the previous report; their status was not rewritten.

The separate development/holdout dataset lock remains outside this work. A
synthetic holdout performance comparison does not implement the product lock
or establish independent model validation.

## Integration boundary

The optimized shared TypeScript functions are used by the application's EFA
engine and identify new results as `scatter-efa/5`. The default-browser GPU
kernel and the two new native block builders are explicit qualification-harness
backends. A production backend selector, per-device numerical self-checks and
an optional local native companion remain separate integration work. No native
runtime is added to the browser application by this change. The original full
JavaScript/CPU comparison remains skipped at the user's request; the targeted
CPU substage measurements and small reference tests are distinct from that run.
