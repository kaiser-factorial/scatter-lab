# Numerical qualification

The library is built from the same numerical modules used by Scatter Lab's
compatibility adapters. Native ESM, declaration files and browser bundling are
checked against the actual npm tarball, separately from source-level unit tests.
Every build records SHA-256 source hashes. Reference runs verify those hashes
before executing the emitted package.

## Reference families

| Family | Reference contract |
| --- | --- |
| PCA | R `stats::prcomp`, explicit population rather than sample eigenvalue normalization, common centering/scaling and signed-axis alignment; training and held-out scores |
| Iterative PCA | Existing pinned missMDA reference with matching finite iteration budget, regularization, rank and stopping rule |
| EFA / rotations | Pinned lavaan / psych / GPArotation references under recorded extraction, rotation, initialization and scoring conventions |
| ML/FIML | Gaussian observed-data likelihood, fitted covariance, scores/completion, convergence and missing-pattern cases against retained R references |
| Ordinal models | Existing ordered regression / MICE and weighted EFA component references; conditioning, contrasts, random streams and inferential scope are explicit |
| Numeric summaries and correlations | R base/stats, matching coercion, pairwise membership, denominators and Spearman midranks |
| Welch, Mann–Whitney, Kruskal–Wallis, chi-square | R stats with matching approximation and correction choices; no claim that an asymptotic result matches an exact test |
| K-means | R `stats::kmeans(algorithm='Lloyd')`, using the same ten explicit initial-center matrices and 300-update budget; equality of seed numbers alone is not the comparison |
| Chatterjee xi | An independent R implementation of the mathematical formula with exact averaging over predictor-tie permutations on bounded fixtures; not a call to a canonical R package |

The preexisting decomposition suite covers 375 comparison groups and 4,239
checks. The public-library campaign adds descriptive, association, hypothesis,
clustering, PCA and held-out scoring cases. Its generated receipt records the
current group/scalar denominators, actual errors, tolerances, R version, input
digest and container image digest. Check counts describe finite tested fixtures,
not the size of the mathematical input domain.

The repository retains the test scripts and detailed evidence in:

- `validation/library-migration/public-reference.json`
- `validation/library-migration/.artifacts/package-verification.json` (local/CI artifact)
- `frontend/scripts/efa-reference/congruence/`
- `frontend/scripts/statistics-reference/`
- `docs/EFA-CONGRUENCE.md` and `docs/EFA-FORMAL-VALIDATION.md`

The detailed public-method comparison table and its measured error maxima are
in `frontend/scripts/statistics-reference/README.md`. The final public campaign
has 73 groups with 23,969 individual scalar comparisons; the existing 375 groups
contain 4,239 error metrics, some of which summarize an entire matrix. Those
denominators are reported separately rather than treating them as identical
units of coverage.

## Known boundaries

**Kolmogorov–Smirnov:** the inherited workbench p-value uses the
Stephens-adjusted asymptotic approximation, including its existing near-zero
lambda shortcut. The KS statistic D and the explicitly matched formula agree
with the reference to roughly floating-point precision. This does **not** make
the result equivalent to R's exact or unadjusted asymptotic p-value. In the
eight recorded comparison fixtures, the largest absolute differences were
`0.18342708072824154` against R exact (tied ordinal data) and
`0.23547647326188365` against R unadjusted asymptotic (tiny unequal samples).
These are observed maxima, not global error bounds. A separate reviewer
confirmed this is a calibration-method difference. Public results identify the
p-value method; application defaults remain compatible.

Mann–Whitney uses a tie-corrected normal approximation, without continuity
correction. Its recorded maximum p-value difference in this campaign was about
`7.30e-8`; no exact small-sample enumeration is implemented. Ties, discrete
observations and very small samples require the documented approximation scope.

EFA nonuniqueness includes factor order/sign, rotational conventions and weak
or null factors. The existing weak-null psych and fragmented-pattern FIML
boundaries remain documented in `docs/EFA-CONGRUENCE.md`. A timeout is not an
observed accuracy failure or a successful convergence result. Large cases are
separate performance runs and do not replace smaller accuracy cases.

Convergence is surfaced separately from finite numerical output. Iterative PCA
can return a finite capped model with an explicit unresolved convergence issue;
ML/FIML rejects failed convergence. MICE sweep count alone is not a convergence
certificate. No equality with R's random sequence is inferred from using the
same integer seed.

The public clustering facade rejects unsupported numeric ranges before invoking
the inherited kernels. DBSCAN requires a finite, positive squared radius; this
prevents `Infinity <= Infinity` and zero-underflow comparisons from falsely
joining distant observations. K-means requires finite worst-case coordinate
sums and total squared-span accumulation, and rejects a nonzero coordinate span
whose square underflows to zero. It also checks returned assignment dimensions
and finite centers/objective values. These guards preserve the recorded ordinary
input numerics; they are not floating-point error bounds for every accepted
matrix. Extreme-range and sparse-input regression cases exercise the rejection
paths separately from the R reference fixtures.

## Formal scope

The SAW source-binding gates target the relocated numerical source, not the
frontend re-export files. Original source/receipt snapshots are retained.
The campaign contains nine positive component properties and three deliberately
incorrect negative controls. These prove the documented bounded extracted
cell/matrix contracts under their stated assumptions. They do not prove the
full TypeScript runtime, arbitrary floating-point numerical behavior, optimizer
convergence, package wrappers, UI, or universal agreement with lavaan/psych.
