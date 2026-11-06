# Continuous integration

Pull requests run current application tests and the complete saved-reference numerical matrix. Fresh R execution runs separately each week or on demand. The 20,000-by-500 benchmarks are explicitly opt-in. None of these jobs pushes changes, refreshes committed reference files, deploys the app, or requires application/API credentials.

## Required pull-request checks

`.github/workflows/tests.yml` replaces the two duplicate test workflows. It runs on every pull request and push to `main`, so changes to PCA, preparation/measurement, assistant tools, UI controls, workers, and reference scripts cannot fall outside a narrow EFA path filter. Each job uses Node 24 LTS, a root `npm ci`, `npm run build:stats`, then a separate `npm ci` in `frontend/`, read-only repository permission, a time limit, and cancellation of superseded runs.

| Job | Command | Coverage |
| --- | --- | --- |
| Unit, component, worker and type checks | Root `npm run test:stats && npm run check:package`, then frontend `npm run ci:fast` | Public library tests and packed-consumer checks; full app Vitest suite with two workers; real production worker modules in Node worker threads; happy-dom interaction tests; current-source contract/mutation tests; TypeScript |
| Saved R numerical contracts (448 groups) | `npm run ci:numerical` | Main ML/FIML/MINRES/PCA matrix, ordinal WLSMV, conditional/MICE/bootstrap/parallel references, rotated standard errors; public PCA fit/transform, descriptive and hypothesis tests, correlations, and matched-initialization clustering |
| Production build and no new lint findings | `npm run ci:lint` then `npm run build` | Baseline-aware lint and a production build including the Plotly prebuild preparation |

The numerical runner requires **448 groups**: 375 application-kernel groups / 4,239 scalar error-metric checks plus 73 public-package groups / 23,969 individual scalar comparisons. Application metrics often summarize the maximum error over a matrix; these two denominators are reported separately and are not independent statistical trials. It rejects missing groups, nonfinite errors, failed checks, child-process failures/timeouts, and source drift. It also checks 50 retained public/synthetic fixture hashes before execution. Each new run writes fresh reports, execution logs and hashes of its actual bundled source. App bridges resolve the emitted package kernels. The runner checks the package build manifest against current TypeScript before bundling, records both source and emitted hashes, and rejects changes during execution. The public comparison imports the built package through its actual ESM exports. A historical passing report cannot make the current job pass. The current matrix completed in about 13 seconds on the development host; that observation is not a GitHub-hosted runner timing guarantee. The KS comparisons distinguish the preserved Stephens p-value approximation from R exact/asymptotic calibration; see [the public-reference contract](../frontend/scripts/statistics-reference/README.md).

The lint comparison uses an explicit Git base: the pull request's base commit, the previous push commit, or the previous commit for manual runs. It runs the same installed eslint version against each revision's configuration and compares multiplicities of normalized **file, rule, severity and diagnostic text**. Absolute temporary paths, source-frame line numbers and ordinary line movement are normalized away. Existing findings stay visible in artifacts; adding a finding cannot be offset by fixing an unrelated one. New files receive no inherited allowance. The gate archives only lintable base sources, avoiding large dataset/image archives. Generated proof evidence and retained historical attempts are excluded from linting as recorded evidence, not application source.

The unit suite deliberately leaves `EFA_LARGE_PARITY` and `EFA_BENCHMARK` off. These switches enable expensive qualification tests and do not belong in ordinary PR latency. Happy-dom interaction checks and Node worker execution are not browser layout, GPU, or screenshot qualification.

The source-contract mutation tests check the current TypeScript extraction/branch rules without requiring a solver installation. They are not a fresh SAW proof. Historical solver receipts remain documented separately in [EFA-FORMAL-VALIDATION.md](EFA-FORMAL-VALIDATION.md); normal source changes are not blocked merely because an old machine-specific receipt names a different source/tool hash.

## Fresh independent R qualification

`.github/workflows/efa-reference.yml` runs Mondays at 04:29 UTC and supports manual dispatch. It rebuilds the existing R 4.5.1 image chain from the digest-pinned Rocker base and version-pinned package installers, then verifies the installed versions: lavaan 0.6-21, psych 2.5.6, GPArotation 2025.3-1, polycor 0.8-1, jsonlite 2.0.0, numDeriv 2016.8-1.1 and MASS 7.3-65. The weighted archive hashes and mice source hash are checked by their installers. The base installer verifies package versions; this is not a claim that every base-package archive has an independently pinned source hash.

All statistical generation runs with networking disabled and single-threaded BLAS. The mounted source snapshot contains the public reference scripts and vendored missMDA/FactoMineR source adapters. Its output goes to a separate artifact directory; it never overwrites `src/lib/__tests__/fixtures` or the prior congruence evidence.

The job generates all ten ML/FIML/MINRES/PCA datasets, the additional bfi/ordinal matrix, conditional and MICE references, saved bootstrap/permutation references, and weighted uncertainty references. It also generates the independent public-package references with R `stats` (including tiny/large covariance PCA, held-out scoring, tests and clustering), then runs the same 448-group native comparison against those **freshly generated** outputs. It also executes the exported R completion replay on a new saved-model operation and checks observed-cell preservation, missing masks and prediction agreement.

R package versions and estimator/rotation conventions are fixed, but platform/BLAS differences and runtime fields can change bytes. The job compares numerical contracts with their recorded tolerances; it does not assert byte-for-byte equality with historical R results or equality with every canonical package default. The psych weak-null optimizer gap, finite iterative-PCA budgets, and other limits remain in [EFA-CONGRUENCE.md](EFA-CONGRUENCE.md).

Fresh output records its actual Docker image ID and source hashes. The weighted generator's JSON receives an explicit input-byte hash in a separately recorded stamping step; original and stamped hashes are retained, and no numerical values are transformed.

## Optional large checks

`.github/workflows/efa-large.yml` runs only when manually dispatched. It first requires the complete small-data matrix to pass, then executes sequential 20,000-by-500 CPU checks for PCA, MINRES, weighted point fitting, complete ML and three-pattern FIML. It preserves wall caps and memory/progress reports. Its inputs optionally add the 90-second fragmented-MCAR FIML stress attempt and the three saved 500-item null-extraction comparisons.

A timeout for the explicitly requested fragmented-FIML stress case is retained as a measured computational boundary, not a passing fit or proof of numerical disagreement. Errors, memory-limit stops and timeouts in the other configured modes fail the job. A green stress workflow can therefore contain that explicitly allowed timeout; inspect the artifact's individual status. Performance numbers from shared GitHub runners are execution measurements, not controlled speedup claims. Full 500-item WLSMV corrections/SEs and full-size MICE/permutation Cartesian products are outside this job.

## Local commands and artifacts

Start from the repository root, then enter the frontend for app/reference commands:

```sh
npm ci
npm run build:stats
npm run test:stats
npm run check:package
cd frontend
npm ci
npm run ci:fast
npm run ci:numerical
CI_BASE_SHA=HEAD npm run ci:lint
npm run build

# Full fresh R generation, including image builds:
npm run ci:reference-r

# Reuse an already built pinned R image after the runtime-version check:
CI_R_SKIP_BUILD=1 npm run ci:reference-r

# Explicit large run; keep outputs separate from historical receipts:
BENCHMARK_REPORT_DIR=.ci-artifacts/large npm run ci:large
```

`CI_ARTIFACT_DIR` overrides the normal `.ci-artifacts` destination for fast/lint/numerical/fresh-R runs. `CONGRUENCE_FIXTURE_ROOT` selects a separate fresh fixture tree and must be paired with `STATISTICS_REFERENCE_ROOT` for its public-package references; the fresh-R script sets both. This prevents a fresh-R run from silently mixing new app references with retained package references. `BENCHMARK_REPORT_DIR` selects the large-run output directory. Generated CI artifacts are ignored by Git and uploaded even after job failure, with 14-day retention for PR checks and 30 days for fresh/large qualification.

After an intentional, reviewed reference-fixture change, explicitly run `node scripts/ci/reference-integrity.mjs --write` and review that manifest diff together with its generating source and fresh comparison results. Updating the hash manifest alone is an integrity operation, not statistical validation.

`esbuild` is an explicit pinned dev dependency because the worker tests and numerical runners import it directly. Previously the development checkout could find an ancestor directory's installation, which a clean runner would not inherit. Use `npm ci` to validate the lockfile rather than relying on that ambient dependency.

These workflow definitions take effect after they are pushed to GitHub. Local verification does not establish that a remote run or branch-protection configuration has completed. If checks are made mandatory, use the three application job names above. The official [Node release table](https://nodejs.org/en/about/previous-releases) identifies supported LTS lines; [GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) documents the permission, timeout and concurrency settings used here.
