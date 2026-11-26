# EFA API

```ts
import { fitEfa, scoreEfa, completeEfa, serializeEfaModel, deserializeEfaModel } from '@scatterlab/stats/efa';

const fit = await fitEfa(trainingTable, {
  items: ['a', 'b', 'c', 'd'].map(column => ({ column, measurement: 'continuous' })),
  factors: 1,
  correlation: 'pearson',
  extraction: 'ml',
  missing: 'fiml',
  rotation: 'promax',
  rows: trainingRowIndices,
  likelihood: { maxIterations: 2000, tolerance: 1e-7, starts: 3, uniquenessFloor: 1e-6 },
});
const model = deserializeEfaModel(serializeEfaModel(fit.model));
const prediction = scoreEfa(model, newRespondents, { rows: newRowIndices });
const completion = await completeEfa(model, trainingTable);
```

Inputs use the columnar `InputTable` contract from `@scatterlab/stats/data`. Cells are finite numbers, strings, or null. Numeric strings remain strings: Gaussian/Pearson EFA rejects them rather than silently coercing their spacing. Convert them deliberately before fitting. Missing numeric/category values may be null or an empty string. Malformed arrays and nonfinite numeric values are rejected. Fitting copies the selected input values before asynchronous hashing; subsequent caller mutations do not change that fit's numerical snapshot.

Select rows with distinct input indices. Their requested order is retained. The API does not accept workspace split IDs, dataset locks, saved app runs, or implicit app filters. `model.training.rows` records the requested original indices; `fittingRows` records the actual fit membership after complete-case deletion where applicable. Score matrices are row-major and aligned with their accompanying `rows` array, not the full source table. Unscorable rows retain null scores and appear in `unscoredRows`.

Supported extraction is MINRES, DWLS, WLSMV, or Gaussian ML; rotations are Promax, Oblimin, and Varimax. Defaults are MINRES, automatic correlation selection, pairwise missingness, Promax, and seed 61001. The model resolves automatic correlation selection before serialization. Numeric Pearson extraction supports MINRES/ML; ordinal polychoric extraction supports MINRES/DWLS/WLSMV. FIML requires ML and numeric Gaussian responses. Pairwise covariance is not accepted as an ML raw-data likelihood. Category orders are explicit for text items; automatic small integer-scale inference remains a heuristic, not a measurement-level proof.

The fitted model retains full-precision loadings, Phi, score weights, means/scales, original category ordering, reverse-key offsets, and fitted column replacements. New-data scoring never estimates replacements or standardization from the new batch. Numeric reverse keys use the offset fitted on the training data. Ordinal scores use the saved category order and standardized rank regression approximation, including for weighted fits. These are not posterior latent-response scores. Unseen categories are rejected. Without a fitted mean/median replacement, nonlikelihood scoring needs complete rows. ML complete-case scoring also needs complete new rows; FIML scores condition on each new respondent's observed numeric items, and wholly missing respondents remain unscored.

`completeEfa` supports Gaussian ML/FIML models only. It verifies a SHA-256 digest of the original selected cells, missing mask, requested row membership, and original row count. A copied equivalent table is accepted; a changed selected value or mask is rejected. Unselected columns and values outside the requested training rows do not enter that digest. The digest establishes input identity, not authenticity of an externally supplied model. Completion returns separate column-major `values` and `filled` arrays for the original fitting rows. Observed values are preserved exactly; wholly unobserved rows remain missing. These are conditional expected values, not draws or multiple-imputation uncertainty. No dataset is mutated.

`fitEfa` returns extraction and rotation convergence separately and sets overall `status` to `converged` only when both converge. A returned nonlikelihood model can be `unconverged`; callers must check status before acceptance. Its fit report retains diagnostic scores, but later `scoreEfa` calls require an explicit `allowUnconverged: true` to use that model. ML/FIML nonconvergence rejects with `EfaError` and its structured `convergenceIssue`; no usable partial likelihood model is returned. Unsupported configuration, numerical failure, and cancellation also reject. The optional third argument accepts `signal` and `onProgress`. CPU computation is synchronous between progress boundaries, although hashing makes the entry point asynchronous. A host worker is required to deliver event-loop-responsive cancellation during long fits. This entry point does not create workers, connect to a companion, or silently select a GPU.

`serializeEfaModel` and `deserializeEfaModel` preserve versioned JSON numerical models and validate finite dimensions, configuration compatibility, preprocessing, row membership, and convergence consistency. They do not certify that arbitrary edited parameters are a valid fitted solution. Fit reports additionally expose correlation/residual summaries and available weighted test/standard-error outputs; execution plans and workspace records are excluded.

The existing numerical qualification applies to the preserved kernels under its recorded conventions. Public-facade tests separately compare fitted parameters, scores, row mapping, ordinal encoding, completion masks, serialization, and failure behavior against those kernels. This does not extend the bounded SAW component properties into a proof of this public facade or universal R equivalence. See `VALIDATION.md` for measured reference scope and remaining boundaries.

## Rotation, parallel analysis, and stability

```ts
import { rotateLoadings, parallelAnalysis, bootstrapEfa } from '@scatterlab/stats/efa';

const rotated = rotateLoadings(unrotatedItemByFactorLoadings, { method: 'oblimin', seed: 42, starts: 4 });
const parallel = await parallelAnalysis(trainingTable, {
  items: ['a', 'b', 'c', 'd'].map(column => ({ column, measurement: 'continuous' })),
  rows: trainingRowIndices,
  correlation: 'pearson', missing: 'complete', replicates: 100, seed: 42,
});
const stability = await bootstrapEfa(model, trainingTable, { replicates: 200, seed: 42 });
```

`rotateLoadings` returns the pattern matrix, factor correlations (`phi`), structure matrix, actual start count, and convergence diagnostics. Promax uses power four and normalized Varimax initialization; it has one initialization regardless of the requested multistart count. Oblimin uses the kernel's quartimin convention. Inputs are finite item-by-factor matrices and are copied before rotation.

`parallelAnalysis` preserves the workbench's **factor-analysis** definition: a one-factor MINRES fit supplies communalities for the diagonal of each observed and permuted reduced correlation matrix. It permutes observed responses independently within each item while fixing missingness locations, then uses the linearly interpolated 95th percentile of null eigenvalues. It supports complete cases, pairwise, mean, or median handling; FIML is not a correlation-matrix parallel-analysis policy. The result retains null spectra, failure records, original requested and fitting rows, seed, and SHA-256 input identity. Any failed replicate suppresses the factor-count suggestion. This is not a PCA eigenvalue parallel-analysis implementation.

`bootstrapEfa` verifies original training content and membership against a converged fitted model before resampling. It refits the saved extraction, rotation, correlation, missingness, and likelihood settings. Column-imputation replacements are re-estimated within each resample. WLSMV stability uses its DWLS point-fit core, without repeating robust standard-error calculations for every replica. Factors are matched by signed permutation to the saved pattern matrix. Results include percentile intervals, primary-factor agreement, cross-loading frequency, each failed replicate, and `sampleRows` expressed as original input indices, including repetitions. With `groups`, provide one nonempty group label for every original input row; whole fitting groups are sampled with replacement. The default interval confidence is 0.95 and cross-loading threshold is 0.3. Failures remain visible and make summaries provisional; bootstrap intervals do not establish measurement validity or guarantee nominal coverage.

Parallel analysis and bootstrap accept the same CPU progress/cancellation execution options as fitting. These wrappers share the existing numerical kernels; their public input validation, row mapping, and provenance checks have dedicated tests in addition to the underlying numerical reference tests.
