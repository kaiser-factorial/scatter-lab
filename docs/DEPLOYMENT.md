# Deployment build

Scatter Lab uses one pnpm workspace and one root `pnpm-lock.yaml` for the frontend,
`@scatterlab/stats`, and the local Plotly adapter. The root `package.json` pins
pnpm 12.18.0. Install from the repository root so the statistics package receives
its declared build tools before the frontend prebuild runs. Each package's
`node_modules` contains links into the shared dependency installation; those link
directories are required for package-scoped module resolution.

`frontend/vercel.json` makes the deployment sequence explicit:

```sh
# Working directory: frontend/
npx --yes pnpm@12.18.0 -C .. install --frozen-lockfile --prod=false
npx --yes pnpm@12.18.0 run build
```

The npm-provided `npx` command bootstraps the pinned pnpm executable; pnpm alone
installs the project dependencies from the root lockfile. Both deployment commands
pin pnpm because Vercel's default package-manager selection for an override may
use an older bundled version. This configuration does not require enabling
experimental Corepack in the Vercel dashboard. See Vercel's
[package-manager selection documentation](https://vercel.com/docs/package-managers).

`--prod=false` retains compilers and build tools even when `NODE_ENV=production`.
The workspace enables pre/post scripts, so the frontend `prebuild` builds
`@scatterlab/stats`, generates the package reference snapshot, and prepares the
selected Plotly bundle before Next.js builds the application. The statistics
build uses its own declared compiler dependency. Workspace links also make the
local Plotly adapter available without fetching replacement packages from the registry.

For the Vercel project, use `frontend` as the Root Directory and keep **Include
source files outside of the Root Directory in the Build Step** enabled. The
sibling statistics package, root workspace configuration, and root lockfile must
be available during the build. The framework preset is Next.js, and the
repository configuration supplies the install and build commands. Use Node 24.x
as declared by the frontend's engine range; the standalone statistics package
accepts Node 24 or later. Vercel's documentation covers
[per-project install/build overrides](https://vercel.com/docs/project-configuration/vercel-json)
and [access to shared files outside the Root Directory](https://vercel.com/docs/monorepos/monorepo-faq).

Keep the application on **Node 24.x for this release**, aligned with the root and
frontend engine ranges, GitHub Actions and Node type declarations. Node 24 remains
an LTS line through April 30, 2028; Node 26 is also LTS and supported by Vercel, but
its adoption should receive a separate build, numerical and deployment check.
The browser CPU/WebGPU calculations use the visitor's browser engine, so changing
the hosting Node version does not directly accelerate those calculations.
[Node release schedule](https://github.com/nodejs/Release)

Vercel selects a major runtime and manages its minor/patch updates. Use `24.x`,
not an open-ended range such as `>=24` that permits a newer hosted major. Confirm
the actual build runtime in deployment logs; this repository configuration does
not establish which version an already deployed site is using.
[Vercel Node version policy](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)

For a clean local build with the pinned pnpm already available, run this from the
repository root:

```sh
pnpm install --frozen-lockfile --prod=false
pnpm --filter frontend run build
```

Changing the deployment configuration only takes effect in a deployment that
includes the change; a successful local build does not establish remote deployment
success.

## Regression coverage

`frontend/scripts/ci/deployment.check.mjs` verifies that both configured deployment
commands match the repository's pnpm pin, then executes their pnpm arguments
against an isolated offline workspace fixture using that installed version. It
checks that the statistics prebuild runs, that the frontend imports the built
statistics package and the local Plotly adapter, and that declared build dependencies
remain available with `NODE_ENV=production`. It also checks that the install uses
one unchanged root lockfile, shares the compiler installation, and rejects a
manifest change under `--frozen-lockfile`.

The fixture does not download pnpm through `npx`, compile the actual statistical
source, or run Next.js. The clean deployment build checks the real bootstrap,
locked dependencies, and application; the normal numerical checks validate the
actual statistics package.
