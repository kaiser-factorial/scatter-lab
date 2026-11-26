# Statistics library architecture

Scatter Lab is now a host application for the local `@scatterlab/stats` package
under `packages/statistics`. The package is private and is not published. One
pnpm workspace manages the frontend, statistics package and local UI adapters,
with one root `pnpm-lock.yaml`. The frontend uses `workspace:*` to resolve the
statistics package locally.

## Ownership

The numerical source moved from `frontend/src/lib` to
`packages/statistics/src/internal` while preserving its dependency graph.
Frontend compatibility modules re-export those exact implementations. The app
and a Node consumer therefore execute the same mathematical kernels.
`src/pca.ts`, `src/efa.ts`, `src/data.ts`, `src/missing.ts`, `src/stats.ts`,
`src/diagnostics.ts` and `src/cluster.ts` define the public library boundary.

The package owns numerical input validation, measurement and category semantics,
correlations, extraction, rotation, imputation, scoring, model serialization and
numerical diagnostics. The frontend owns dataset IDs/locks, splits, row filters,
saved runs, score-column naming, formatting, downloads, React, worker lifecycles,
WebGPU adapters, and assistant permission/privacy projections. Pure CPU entry
points do not create workers or select acceleration implicitly.

The active compute contract permits only CPU and WebGPU. Retired Scala settings
are rejected explicitly rather than migrated to CPU. Scala benchmark sources
and transport reference code remain under `frontend/scripts/efa-companion/`;
they are excluded from the application import graph and the package tarball.

PCA's public fit and legacy app run share one raw calculation. Public models
retain full precision; the app adapter retains its original display rounding
and column names. New-data scoring uses retained training preprocessing. Input
row selections are explicit indices rather than workspace state. Model JSON
is validated and versioned; numerical summaries and optimizer statuses remain
separate from the app's acceptance/retry controls.

The statistical adviser is available to library callers. It returns raw local
diagnostics, not permission to disclose those diagnostics. The app's existing
aggregate projection is still the route used by the assistant.

## Build and development

```sh
pnpm install --frozen-lockfile
pnpm run build:stats
dev start frontend --detach --json --yes
```

The TypeScript build emits native ESM modules and declarations, adds explicit
`.js` import extensions, and records source hashes in `dist/build-manifest.json`.
It preserves module identity across public/compatibility imports. No bundled
duplicate copy of numerical classes is substituted for the source modules.
Next's Turbopack root is the repository root so it can watch the sibling package.
The frontend development script watches library TypeScript and rebuilds it;
predev and prebuild also build it before starting Next.

For other local applications, build the package and install its directory or
a `pnpm pack` tarball. See the package README and API documents. The exported
`internal/*` path remains an explicitly unstable bridge for the current app
and validation harness; new external clients should use the named public APIs.

## Verification and provenance

`pnpm run check` combines package tests, the frontend's component/worker/type
checks, retained R reference comparisons and actual tarball-consumer checks.
The package-consumer gate verifies emitted hashes, installs the packed artifact,
executes native ESM PCA/EFA and completion, type-checks a separate consumer, and
runs a self-contained browser bundle without DOM or network. The latter tests
runtime portability; it does not measure browser interaction or visual layout.

The original bytes of the moved modules are retained under
`validation/library-migration/baseline/`, with hashes and destination paths in
`baseline.json`. This is a timestamped working-tree snapshot, not a claim about
a clean Git revision. The archived formal receipts bind those original bytes;
fresh receipts and gates bind the numerical modules at their new package paths.

R data, reference generation, fixtures, formal artifacts, UI code and optional
runtime backends are excluded from the npm tarball. CI builds from current
source and checks actual reference denominators. Detailed statistical
qualification and known discrepancies live in the package's `VALIDATION.md`
and the existing EFA congruence documents.
