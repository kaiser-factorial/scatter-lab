# Dependency maintenance

Scatter Lab uses one pnpm workspace and one root `pnpm-lock.yaml` for the
frontend, `packages/statistics` and `frontend/vendor/*` adapters. Node 24 and
pnpm 12.18.0 are pinned in the root manifest. Run `pnpm install --frozen-lockfile`
from the root to install all workspace packages; see the
[deployment sequence](DEPLOYMENT.md) for the build configuration. Do not create
separate npm lockfiles or run independent frontend installations.

## Why there are several node_modules directories

The directory count does not count independent installations or full copies.
With pnpm's isolated layout, a package's `node_modules` exposes links for its
declared dependencies. The workspace's `node_modules/.pnpm` holds the resolved
dependency graph, backed by pnpm's shared content-addressable store. Importing
those files can use filesystem links or copies depending on the filesystem and
configuration. See pnpm's [dependency layout](https://pnpm.io/symlinked-node-modules-structure)
and [package import settings](https://pnpm.io/settings/node-modules#packageimportmethod).

| Location | Purpose |
| --- | --- |
| Root `node_modules` | Workspace dependency graph, package links and tooling. |
| `frontend/node_modules` | Links and executables for dependencies declared by the app. |
| `packages/statistics/node_modules` | Links and executables for the library's declared dependencies; tools may also keep local caches here. |

An unfamiliar package can be a transitive dependency required by a direct one,
or a peer dependency needed by a plugin. Inspect it with
[`pnpm why -r PACKAGE`](https://pnpm.io/cli/why); use
[`pnpm list -r --depth Infinity`](https://pnpm.io/cli/list) to inspect the full graph. Multiple versions
or peer combinations can be legitimate, so pnpm does not promise one copy of
every package. Before this migration, the statistics package's small
`node_modules` directory contained only a test cache and macOS metadata, not a
third installed dependency tree. The migration unifies installation and lockfile
ownership; it does not aim to eliminate every directory named `node_modules`.

## Current stable releases and compatibility

The 2026-11-06 refresh checked npm's `latest` tags and the authoritative SheetJS
distribution. Direct registry dependencies use exact versions, preserved by the
pnpm migration and recorded in the root lockfile. Notable updates are
Next.js 16.4.5, React/React DOM 19.3.1,
Plotly GL3D 4.2.0, the React Plotly factory 4.1.0, ml-matrix 6.15.1, Vitest 5.1.0,
Playwright 1.65.0, and Tailwind 4.3.5.

Three development dependencies intentionally follow compatibility constraints:

| Dependency | Selected | Reason |
| --- | --- | --- |
| TypeScript | 6.0.3 | The statistics build uses the JavaScript compiler API and the current typescript-eslint packages declare `<6.1.0`. TypeScript 7.0.2 changes that API surface; it is not a drop-in upgrade. |
| ESLint | 9.39.5 | The current React, import and accessibility plugins used by `eslint-config-next` declare ESLint 9 support, excluding 10.14.0. Recheck these peers before moving to 10; do not suppress peer conflicts to force the upgrade. |
| `@types/node` | 24.19.2 | Matches the Node 24 deployment/CI runtime. Node 26 types would admit APIs unavailable in that target. |

These are explicit exceptions, not a claim that every package is on its newest
major. ESLint 9 is deprecated upstream; the migration is waiting on the current
Next lint plugin peer ranges. Microsoft's [TypeScript 7 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
describes the compiler API transition and side-by-side tooling options.
SheetJS remains on its authoritative [0.20.3 CDN release](https://docs.sheetjs.com/docs/getting-started/installation/frameworks/),
rather than the older npm `xlsx` distribution.

## Small local adapters

Terminal sections, Legend and Notes are implemented by Scatter Lab using HTML and the existing React runtime. The earlier layout was inspired by [lumpenspace/ccru](https://github.com/lumpenspace/ccru); its component code and website dependencies are not included. See the licensing audit before publishing older candidate history.

`frontend/vendor/react-plotly-factory` retains the upstream React factory and its
runtime chunk, declarations, source maps and MIT license. It accepts the app's
chosen prebuilt GL3D bundle and has only a React peer. The original package's
mandatory full `plotly.js` peer installed a second, unused Plotly distribution
and its dependency tree. The app and interactive exports use
`plotly.js-gl3d-dist-min`; the app plots and exported HTML disable Plotly's
cloud-upload button.

The remaining adapter has a README and `PROVENANCE.json` with its exact upstream source,
hashes and local packaging changes. Keep copied files verbatim when updating:
fetch the upstream archive without running package scripts, review its changes,
replace the required files, refresh provenance and the lockfile, then run the
adapter tests and real-browser checks. Preserve the original license status.
Do not add the upstream website package or full Plotly peer to obtain an update.

The vendor directory is excluded from Tailwind's automatic source scan to retain
the same utility coverage it had while these files lived in `node_modules`.

## Verification

- `pnpm install --frozen-lockfile` verifies that manifests agree with the shared
  lockfile. `pnpm list -r --depth Infinity` shows the installed graph, and
  `pnpm why -r PACKAGE` traces why an unfamiliar package is present.
- `pnpm outdated -r` reports available updates; review
  releases and peer ranges before changing them.
- `pnpm run check` covers package behavior, app tests, numerical references and
  packed consumers. `pnpm --dir frontend run ci:lint` checks for new findings.
- `pnpm --dir frontend run build` checks production bundling and types.
- With a server started through `dev`, run
  `node scripts/check-dependency-ui.mjs after http://localhost:PORT` from
  `frontend/`. It checks both themes, 2D/3D rendering, pinned graph identity,
  resizing, PCA, clustering and downloads using the bundled Iris data. Artifacts
  are written to ignored `.ci-artifacts/dependency-ui/after/`.
