# @scatterlab/stats

Statistical computing in TypeScript for Node and browsers. This is the numerical
library used by Scatter Lab: the app's workers, controls, dataset management and
assistant are adapters around these same implementations.

The package is currently private, version `0.1.0`, and not published. It uses
native ESM and ships TypeScript declarations. Node 24 or newer is the tested
runtime target. Browser use requires a bundler and Web Crypto for EFA model
fingerprinting. CPU calculations need neither R nor a Python process. R is used
in development to generate independent numerical references.

```ts
import { fitPca, transformPca } from '@scatterlab/stats/pca';
import type { InputTable } from '@scatterlab/stats/data';

const table: InputTable = {
  columns: ['a', 'b', 'c'],
  nRows: 5,
  data: { a: [1, 2, 4, 5, 6], b: [4, 1, 3, 2, 5], c: [2, null, 3, 6, 4] },
};
const fit = fitPca(table, {
  rows: [0, 1, 2, 3],
  k: 2,
  missing: 'median',
  measurements: { a: 'continuous', b: 'continuous', c: 'continuous' },
});
const holdout = transformPca(fit.model, table, { rows: [4] });
// The held-out row uses training means, scales, replacements and components.
console.log(holdout.rows, holdout.scores);
```

## Entry points

| Import | Purpose |
| --- | --- |
| `@scatterlab/stats/data` | Typed columnar input, explicit row selection, copied materialization |
| `@scatterlab/stats/pca` | Fit PCA, score new rows, serialize and validate fitted models |
| `@scatterlab/stats/efa` | Fit EFA, score new rows, likelihood completion, rotations, parallel analysis and bootstrap stability |
| `@scatterlab/stats/missing` | Train/apply column mean or median imputers; ordinal chained imputations |
| `@scatterlab/stats/stats` | Descriptive summaries, associations, group comparisons and hypothesis tests |
| `@scatterlab/stats/diagnostics` | Measurement/distribution summaries and method recommendations |
| `@scatterlab/stats/cluster` | Explicitly prepared numeric K-means and DBSCAN |

The root entry point exports those namespaces plus `VERSION`. `internal/*` is a
temporary compatibility surface for the workbench and reference harness; its
types and names are not a stable external API. It contains no UI implementation.

## Inputs and results

`InputTable` uses column names, equally sized column arrays and `nRows`. Cells
must be finite numbers, strings or `null`. The table validator rejects
`undefined`, `NaN` and infinities. Null and empty strings are missing in the
decomposition/imputation workflows. Numeric-string handling remains
method-specific and explicit: PCA and the existing descriptive helpers retain
workbench coercion, whereas Gaussian EFA and the standalone column imputer
require actual numeric cells. Convert input deliberately when combining methods.

Row indices are zero-based positions in the supplied input. Each operation
reports the selected/scored/fitting rows relevant to its result. Scores are
row-major; model parameters keep their documented orientation. Unscored rows
remain represented by null scores. No operation mutates a supplied table, creates
an app score-column name, changes a split, or sends data to an assistant.

PCA, EFA and column-imputation models retain training preprocessing, use
versioned JSON formats, and validate serialization. Holdout scoring never
relearns means, scales or replacement values from the scoring batch. See
[PCA.md](PCA.md) and [EFA.md](EFA.md) for model, missingness and convergence
contracts. Fitted model parameters can still carry sensitive information.

```ts
import { fitColumnImputer, applyColumnImputer } from '@scatterlab/stats/missing';

const imputer = fitColumnImputer(table, {
  method: 'mean', rows: [0, 1, 2, 3],
  measurements: { a: 'continuous', b: 'continuous', c: 'continuous' },
});
const completed = applyColumnImputer(imputer, table, { rows: [4] });
// completed.table is a copy; completed.filled identifies exactly changed cells.
```

Ordinal mean/median filling respects a declared category order. Automatic
measurement detection is a heuristic, not evidence that a variable is ordinal.
For the standalone missing-data APIs, supplying an `orders` entry selects ordinal
handling even for numeric category codes and an omitted or `auto` measurement.
Declaring both a category order and `continuous` is rejected; remove the order
when the values should be treated as continuous measurements.
Declare continuous measurements explicitly for integer-valued measurements when
that is their intended interpretation. `imputeOrdinal` uses explicit predictor
lists and returns separate completed datasets, traces and failures. Fixed MICE
sweeps do not demonstrate chain convergence or perform pooled inference; they
are not an out-of-sample imputation model.

Method advice is local numerical information, including raw category/profile
details. It is **not** the app's assistant-safe aggregate projection. Hosts must
apply their own privacy policy before sharing it. The workbench keeps that
projection and its permissions in the frontend.

K-means retains ten deterministic starts and reports their seeds and iteration
limit. Its inherited kernel does not expose a stopping certificate, so the
public result says `convergence: 'not-reported'`. DBSCAN uses Euclidean distance,
self-inclusive neighborhoods, and `-1` for noise. Both expect a finite,
rectangular matrix of already prepared observations; neither silently scales or
imputes it.
The facades reject numeric ranges the inherited squared-distance kernels cannot
represent. DBSCAN requires `eps * eps` to be finite and nonzero. K-means requires
each maximum absolute coordinate times row count to be finite, every nonzero
coordinate span to have a nonzero finite square, and row count times the sum of
squared coordinate spans to be finite. Returned assignments, centers and total
sum of squares are checked. Rescale extreme data explicitly before clustering;
sparse array holes are invalid input, not missing values to fill automatically.

## Build and qualify

From the repository root:

```sh
npm ci
npm run build:stats
npm run test:stats
npm run check:package
```

The last command packs the actual distribution, installs it in an isolated
consumer, checks native ESM and declarations, and executes a browser bundle. It
uses the npm cache populated by installation, so the consumer install is
offline. Package tests and R comparison data stay outside the shipped tarball.

See [VALIDATION.md](VALIDATION.md) for reference conventions and known numerical
boundaries. Passing finite reference cases is not a universal equivalence proof.
The separate SAW campaign proves narrowly defined extracted components; it does
not prove an entire factor-analysis implementation.
