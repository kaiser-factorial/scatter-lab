# PCA

```ts
import { fitPca, transformPca, serializePcaModel, deserializePcaModel } from '@scatterlab/stats/pca';

const fit = fitPca(table, {
  columns: ['itemA', 'itemB', 'itemC'],
  rows: developmentRows,       // zero-based original row indices, in the desired order
  k: 2,
  standardize: true,
  missing: 'median',
  measurements: { itemA: 'continuous', itemB: 'continuous', itemC: 'continuous' },
});

const saved = serializePcaModel(fit.model);
const model = deserializePcaModel(saved);
const heldOut = transformPca(model, table, { rows: holdoutRows });
```

`fitPca` is synchronous CPU computation. It does not alter the source table or add score columns. It accepts the package's columnar `InputTable`; omitted columns and rows select all columns and rows. Rows must be distinct, in-range integer indices. Explicit `k` must be an integer from one to `min(selected column count, selected row count - 1)`; complete-case fitting uses the remaining complete-case row count for this bound. The default retains up to three components within that bound.

The returned `scores` are **row-major**, in `rows` order. Row indices refer to the original input, including when a subset was selected in a different order. An unscored row contains `null` for every component. `fittingRows` and `scoredRows` are separate because pairwise covariance estimation can use respondents who cannot receive a complete-row score.

`model.components` are **component-major** unit eigenvectors, in `model.variables` order, at full calculation precision. They are PCA coefficient vectors, not variable–component correlations or EFA factor loadings. `model.means`, `model.scales`, and fitted column replacements are retained. Standardization uses the training population standard deviation (divisor `n`); covariance eigenvalues also use divisor `n`. Raw covariance PCA uses scales of one. Signs are chosen so that the largest absolute coefficient on each component is positive. Repeated or nearly repeated eigenvalues can still make individual component directions nonunique.

`model.eigenvalues` and `model.spectrum` contain the full variable spectrum; `model.varianceExplained` contains the retained-component fractions. The model stores its original selected, fitting and scored row mappings, but it contains no original response cells or training score table. Saved model data can still be sensitive.

## Missing values

| Method | During fitting | During `transformPca` |
| --- | --- | --- |
| `mean` / `median` | Learn replacements from observed selected training rows, then fit the completed matrix. | Reuse those exact training replacements. New rows never influence a fill, center, scale or component. |
| `complete` | Fit and score rows complete on all selected variables. | Incomplete rows remain unscored. |
| `pairwise` | Estimate each covariance/correlation from its observed pairs. Preserve pair counts and reject materially non-PSD matrices. Score complete rows only. | Incomplete rows remain unscored. |
| `iterative` | Use regularized iterative PCA completion with explicit rank, iteration and tolerance settings, then fit PCA. | Score complete new rows using the saved model. Incomplete new rows throw; this API does not refit or invent an out-of-sample iterative imputation rule. |

`missing` defaults to `median`. Mean and median use measurement declarations: continuous columns use numeric replacements; ordered categories use the existing category-constrained rules. Auto measurement is a suggestion based on the observed training values. An ordinal median chooses an observed declared category; a categorical mean uses the nearest category, with the established lower-category tie rule. Declare continuous measurements explicitly when integer-valued measurements should not be treated as categories.

To preserve the workbench PCA contract, finite numeric strings are accepted as numeric; blank or nonnumeric strings are treated as missing. The shared table validator rejects `undefined`, `NaN`, and infinite numeric cells, so normalize those explicitly to `null` first. EFA has its own stricter numeric-input contract.

Ordinal MICE produces multiple independent completed fits and is a separate package operation. It is not a `fitPca` missing-value option.

## Iteration limits

```ts
const fit = fitPca(table, {
  columns: ['itemA', 'itemB', 'itemC'],
  k: 2,
  missing: 'iterative',
  iterative: { maxIterations: 1000, tolerance: 1e-8, rank: 1 },
});
if (!fit.convergence.converged) {
  // Inspect the structured issue before deciding whether to use this partial fit.
  console.log(fit.convergence.issue);
}
```

The iterative defaults remain 200 iterations and tolerance `1e-8`, with imputation rank based on retained PCA rank and clamped to the imputer's supported dimensions. Increasing the iteration budget does not automatically loosen tolerance. A capped finite fit returns its model and scores with a structured issue. `transformPca` requires `{ allowUnconverged: true }` before using such a model. Serialization preserves that status; loading a model does not turn a partial fit into a converged one.

`convergence.stage` is `iterative-imputation` or `not-applicable`. These diagnostics describe imputation. They do not assert a separate convergence certificate for the existing Jacobi eigensolver. Iterative completion uses the established finite-iteration missMDA reference contract; a default-budget result can match R's capped result while still not meeting the stopping criterion.

The shared eigensolver compares off-diagonal magnitude and pivot size in relative matrix units. Its norm calculation avoids squaring raw covariance entries, which could overflow or underflow at extreme units. The package migration caught and corrected the previous absolute pivot cutoff and overflowing norm: these could silently return unrotated coordinate directions for tiny or very large covariance inputs. Scale-invariance regression tests cover input multipliers from `1e-150` to `1e100`. Fitting rejects unsupported nonfinite intermediate values; this does not imply arbitrary-magnitude numerical support.

## Model files

`serializePcaModel` and `deserializePcaModel` validate the version, allowed fields, dimensions, finite values, orthonormal components, variance fractions, row membership and missingness/convergence settings. The model is plain JSON using schema `scatterlab.pca/1`. No scores or source responses are needed to score new rows. Validation establishes a consistent supported model representation; it does not authenticate the model's author or prove that its parameters were fitted from a particular dataset.

The workbench compatibility function `internal/runPCA` delegates to the same fitting kernel and retains its existing label-based column names, replacement behavior and rounded display coefficients. Those application conventions are not part of the public model API.
