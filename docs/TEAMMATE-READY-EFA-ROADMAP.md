# Scatter Lab: teammate-ready EFA release

**Release decision: hold the push until every gate below has evidence on the same candidate.** The deliverable is a workflow, not a new estimator. A teammate should be able to run Iris PCA, inspect a survey EFA, and reproduce their steps from the input and an analysis record without a saved workspace.

## Candidate and ownership

The November 24, 2026 statistical handoff is the local safeguard authority; the older [project handoff](../HANDOFF.md) is background and backlog. Do not publish the ignored local handoff. The starting commit is `7382376` on `codex/efa-mice-stability-wls`. It is **not** the full release: the shared checkout also contains pending numerical runtime, UI, pnpm, CI, privacy, and hosting changes. The previously reported 107 focused tests were run in that shared tree on Node 26, not against a clean Node 24 release.

Review the pending changes by subsystem before selecting an integration commit. The lockfile, vendored adapters, and root/frontend build changes must be reviewed together; worker/runtime and documentation changes must agree. Exclude local package stores, participant files, caches, and unrelated deletions. Do not blanket-stage, clean, or reset the shared tree. Record the reviewed SHA in the release receipt; use it for all qualification and preview checks. Opening a new feature branch from the old HEAD does not preserve uncommitted work.

## Three workstreams for this push

| Track | Deliverable | What to verify |
| --- | --- | --- |
| Numerical qualification | Keep new KS inference blocked, ECDF descriptive, and the four retained tests explicitly independent-sample only. Respect sparse-data, privacy, convergence, unsupported design and estimated-correction boundaries. | Package consumer and actual browser worker agree with pinned references under matched preprocessing, row membership, extraction, rotation and scoring. A finite result, timeout, matching seed number or passing unit test is not sufficient evidence. |
| Demo and layout | One click imports pinned Iris; consent precedes switching from existing work. Retain Iris PCA/clustering, then explicitly switch to an ordinal survey, run a saved browser CPU EFA, inspect item loadings and plot respondent scores. No automatic chat docking. Resizable controls; stack comparisons on narrow canvases. | The import runs through the parser; loading/fit failures are visible. Source, item wording, category order, exact fit and seed/fixture are documented. F1/F2 and optional F3 identify estimated scores and their run; scored/omitted counts agree with the fit. Never treat omitted scores as zero. |
| Provenance | Export versioned JSONL, human-readable Markdown, and SHA-256 checksums from the same local event stream, even just after import. Preserve older traces as legacy prose. | Capture input digest and import settings, lineage/split rule/RNG/membership digest, filters, ordered variables and preprocessing, run and backend, convergence and warnings, derived columns and final view. Distinguish fitting, scoring and viewing populations. Preview sensitive metadata; omit raw records, participant identifiers, credentials and chat. A checksum authenticates neither the author nor an untrusted replacement manifest. |

**Dataset rule:** prefer the [SAPA/IPIP bfi demonstration data](https://personality-project.org/r/html/bfi.html), not the original Big Five Inventory. Public-domain permission for IPIP items is not by itself permission to redistribute respondents' answers. Pin the source and checksum and omit demographics if using the real response file. Otherwise ship a labeled, seeded synthetic ordinal fixture with a public generator. Never substitute private participant data.

**What a dot means:** PCA projects a centered (and optionally scaled) response onto a fitted component direction. EFA estimates a respondent's latent-factor position from their item responses and a fitted model. An item loading is not a respondent score. Show the loading heatmap first so users can interpret the score axes; the demo should not imply that rotations, factor labels or signs are universal. See the [scoring and missing-data contract](EFA.md).

## Release checklist

- [ ] Review the integration diff and record its clean SHA. Inspect the locked Node 24.x/pnpm install and hosted build settings described in [Deployment](DEPLOYMENT.md).
- [ ] Run package tests, packed consumer, frontend/worker/TypeScript, all saved numerical contracts, baseline-aware lint, and production build per [CI](CI.md). Compare fitted and held-out scores, convergence and score membership. Document failures rather than increasing tolerances. Keep fresh R calibration, performance and supported GPU device checks distinct.
- [ ] On the hosted preview for **that SHA**, exercise both chapters on wide and narrow screens. Verify saved run, score counts and aligned coordinates; test failure/cancellation, protected holdout rows, CPU fallback, reruns with existing work, both dock positions, keyboard resizing and reopening the drawer. Check current assistant guidance, direct KS refusal and ECDF availability.
- [ ] Independent teammate trial: give a teammate only original input(s) and the exported record. Ask them to recreate the split/filters, identify fitting vs. plotted rows, repeat the fit within the documented tolerance, reproduce axes/encodings, and explain a point without coaching. Verify an edited export fails against the original checksum. Record what the teammate could not recover. A scripted replay is not a substitute for this trial.
- [ ] Attach the checks and teammate feedback to the candidate. Only then authorize the release push and verify the hosted result. Do not deploy to production as a substitute for a preview.

## After the push — separate feature branches

| Branch / topic | First milestone | Qualification boundary |
| --- | --- | --- |
| `codex/multigroup-efa` | Reproduce a published multigroup example and compare [lavaan EFA](https://lavaan.ugent.be/tutorial/efa.html) and [group syntax](https://lavaan.ugent.be/tutorial/groups.html) with MATLAB [`factoran`](https://www.mathworks.com/help/stats/factoran.html). Start with common items, aligned descriptive loadings, group sizes and diagnostics. | Alignment is not invariance. Treat jointly constrained ordinal models, identification, thresholds and latent mean comparisons as a separate research and validation milestone. |
| `codex/geometric-fits` | Add line/plane overlays minimizing **perpendicular** RMSE in data coordinates. Record scales, fit population, equation, residuals and export settings. Test exact/noisy, vertical, filtered and nonunique solutions. | Do not silently choose a response axis. Predicting an outcome with a nonlinear response surface differs from finding a curve or surface through an unordered cloud. |
| `codex/study-design-inference` | Record question, measurement level, independence vs. pairing, participant and occasion matching. Qualify independent distribution tests with ties and paired categorical methods on pinned references and calibration simulations. | No row-order pairing, generic paired KS, or substitution of a different null. Require separate qualification of constrained, sparse, or singular cases. |
| Reproducibility and general backlog | Verify a record locally and dry-run replay before considering execution or opt-in assistant review. Then revisit clustering variables, large-data rendering/import, and SPSS import. | No automatic execution of imported history; none of these items blocks the current release. |
