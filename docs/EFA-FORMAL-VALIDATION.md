# Formal assurance boundaries for PCA/EFA

The current narrow proof campaign establishes **nine native SAW properties**:
five exact-rational Gaussian algebra identities and four source-derived cell
update identities. Three deliberately false contracts produce native
counterexamples. This is useful component evidence, **not a proof that the
TypeScript optimizer is equivalent to R, lavaan, or an exact real-number
maximum-likelihood optimizer**. Numerical cross-implementation results have a
separate validation matrix and error ledger.

## What transferred from the crypto project

The reviewed reference is `crypto/hash-visualizer/VALIDATION.md`, with the
source-directed loop contracts in `validation/ts-loop-proof/README.md` and the
strict assembly review in
`validation/sha1-wrapper-proof/ASSEMBLY_REVIEW.md`. That project proves bounded
word algorithms using exact bounded integer arithmetic. Its AST interpreter,
standard builtin semantics, source translation, proof receipt checker and
composition assumptions remain trusted. Its proof record also distinguishes
current claims from historical intermediate milestones.

The transferred practices are:

- Bind statements to actual source, generated models, native logs, tool identity
  and explicit theorem domains; reject stale or substituted evidence.
- Require negative controls to produce actual counterexamples. Parser errors,
  timeouts, missing tools and unsupported operations are not refutations.
- Regenerate source-derived models before accepting a retained receipt.
- Keep solver theorems, structural source checks, execution tests, numerical
  agreement, and statistical adequacy as separate claims.
- Check the entire stated domain. An identity in two dimensions is not silently
  generalized to every item count.

The crypto interpreter cannot simply be reused for EFA: it explicitly bounds
Number arithmetic to exact integers. Likelihood estimation instead uses
floating-point sums, square roots, logarithms, linear algebra and iterative
optimization. Different correct accumulation/optimization paths need not be
bit-identical.

## Proved propositions

The models, source recognizers, runner and native receipts are under
`frontend/scripts/efa-reference/formal/`.

| Contract | Quantified domain | What it establishes |
|---|---|---|
| Gaussian sufficient statistics | Three arbitrary two-dimensional rational rows, arbitrary rational means and symmetric quadratic coefficients | The rowwise residual quadratic equals within-pattern scatter plus the centered pattern-mean term |
| Mean-gradient increment | The same domain plus any rational increment in the first mean coordinate | The exact linear coefficient is the mean gradient; the remaining term is the stated quadratic increment |
| Determinant lemma | Two nonzero rational diagonal entries and a rational rank-one loading vector | The determinant of `D + l l'` equals `det(D) × (1 + l' D^-1 l)` |
| Woodbury inverse | Same domain, additionally nonzero `1 + l' D^-1 l` | The three distinct entries of the analytic inverse equal the Woodbury expression |
| Conditional-mean algebra | A nonsingular rational symmetric 2×2 observed covariance, arbitrary cross-covariance and residual vectors | The explicit solve and regression-coefficient expressions agree |
| Numeric observed-cell preservation | Any nonzero 8-bit observation mask and arbitrary 64-bit original/replacement payloads | The actual recognized guarded numeric assignment leaves the observed payload unchanged |
| Numeric missing-cell replacement | Zero observation mask and arbitrary 64-bit payloads | That assignment uses the computed replacement |
| FIML observed-cell preservation | Present finite-number payload, including zero, and arbitrary calculated payload | The actual recognized nullish-coalescing branch returns the original observed value |
| FIML missing-cell replacement | Missing input and arbitrary calculated payload | That branch uses its calculated fallback |

The five rational identities are handwritten mathematical models, not
translations of the full likelihood implementation. Their connection to the
production objective is supported by independent code review and numerical
objective/gradient comparisons. They do not prove logarithms, positive
definiteness, general-dimensional identities, line searches, stopping rules,
global optimality, or error bounds for floating-point arithmetic.

The two source recognizers read the TypeScript AST. The numeric recognizer
requires a copied output, exactly one guarded cell write, identical mask/write
indices, and no unsupported aliases or calls involving the output. The FIML
recognizer selects the returned `means: values.map` expression in the
`createConditionalProjector` closure and lowers its nullish branch. The calculated value
is opaque. Standard array operations, the restricted lowering and finite
numeric/null input contracts are trusted. These are cell-operation theorems;
the entire enclosing loops, object state, source compiler and browser are not
proved.

## Negative controls and evidence checks

The runner requires these native counterexamples:

1. Add one to the grouped quadratic while claiming equality. Native SAW
   refutes its zero-residual instance (zero versus one); this concrete control
   avoids nonlinear counterexample-search heuristics in the pinned solver.
2. Reverse the observation guard in a temporary copy of the actual numeric
   source, regenerate its model, and attempt observed-cell preservation.
3. Replace `value ?? calculated` with `value || calculated` in a temporary
   copy of the actual FIML source. The observed-zero counterexample distinguishes
   nullishness from truthiness.

Production source is never mutated by these controls. Ten source-recognizer
checks cover aliasing, wrong indices, missing guards, incorrect observed
branches, parser errors and source/model provenance. Eight receipt checks reject
wrong theorem counts, duplicate IDs, assumed/failed proofs, absent hash maps,
stale source, changed negative-control artifacts or solver binaries, altered summaries and generic failures passed off as
counterexamples.

`report.json` contains exact source/model hashes, tool identity, proof counts,
logs, native summaries and the unsuccessful floating-point capability probe.
`verify.py` rechecks current artifacts and regenerates the cell contracts
without launching a solver. Context hashes additionally identify the inspected
likelihood/fit/types implementation; hashing a file does **not** prove that
file's implementation.

Earlier receipts and their evidence are retained under `formal/history/`, with
hash-matching source snapshots and an archive note. Those records describe
their historical source versions. Only the live `formal/report.json`, checked
against the current source with `verify.py`, supports the current component
claim.

The package extraction moves the actual numerical implementations to
`packages/statistics/src/internal/efa/`. Both AST recognizers now read those
kernel files, rather than the workbench's compatibility re-exports. The prior
receipt is preserved unchanged under
`formal/history/2026-11-06T12-57-22-pre-package/`, including hash-verified
pre-extraction source and context snapshots. The refreshed live campaign binds
the package kernel paths. Its scope does not include the public data/EFA
facades, model serialization, emitted JavaScript, package exports, or module
resolution. Those boundaries have separate consumer and numerical tests.

## Native floating-point capability

The local tools are SAW 1.6 and Cryptol 3.6.0. SAW/Z3 proved the rational
properties. A separately retained `Float64` semantic-reflexivity probe fails
with `Unimplemented: =.=`. This records a concrete unsupported operation in
this tool build, not a general impossibility theorem about floating-point
verification.

Current SAW documentation lists C, Java, Rust and Cryptol frontends. It does not
supply the missing TypeScript or R semantic connection. Its LLVM FFI guide also
states that `Float` setup is not currently executable through the required
`llvm_fresh_var` support. Cryptol's own floating-point types and arithmetic do
not by themselves establish symbolic support across every SAW backend.
Sources checked on 2026-11-06:
[SAW capabilities](https://tools.galois.com/saw),
[SAW LLVM/FFI support](https://galoisinc.github.io/saw-script/master/saw-user-manual/verifying-code.html),
[Cryptol language manual](https://cryptol.net/files/ProgrammingCryptol.pdf).

## Reproduction

From the workbench root:

```sh
node --test frontend/scripts/efa-reference/formal/source-contract.check.mjs
python3 frontend/scripts/efa-reference/formal/run.py
python3 frontend/scripts/efa-reference/formal/verify.py
python3 frontend/scripts/efa-reference/formal/test_gates.py
```

The runner uses the existing local SAW installation under the sibling crypto
project. Set `SCATTER_SAW` to another SAW executable to reproduce elsewhere;
its version and executable hash are recorded. The runner selects the Z3 binary
beside SAW first and records its resolved path, version and hash too. No file in the crypto project is
modified. Each native process has a 60-second budget. A failed rerun overwrites
the passing status with a failed receipt rather than leaving an apparently
current success.

A release-level statement of TS/R agreement must additionally name the pinned
R packages, datasets, masks, estimators, rotation options, normalization,
convergence status and measured error bounds. Factor sign/permutation alignment
can resolve equivalent labeling; arbitrary post-hoc transformations cannot be
used to conceal different rotation definitions. Passing a finite dataset
matrix is empirical agreement within that matrix, not universal congruence.
