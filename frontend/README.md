# Scatter Lab frontend

The Next.js application is part of the repository's pnpm workspace. Use Node 24
and the root manifest's pnpm 12.18.0 pin. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run build:stats
dev start frontend --detach --json --yes
```

Open the ready URL printed by `dev`. The launcher checks readiness and reuses a
healthy server. Changes to `src/app/page.tsx` reload in the browser; the development
script also watches and rebuilds the shared statistics package.

Use `pnpm --dir frontend run build` from the root for a production build. Its
prebuild prepares the statistics package, assistant reference snapshot and
Plotly bundle. Do not install this directory as a separate project; its local
`workspace:*` dependencies and the shared root lockfile require the repository
workspace.

See the [main README](../README.md) for app behavior,
[dependency maintenance](../docs/DEPENDENCIES.md) for the shared store and
`node_modules` layout, [CI](../docs/CI.md) for verification commands, and
[deployment](../docs/DEPLOYMENT.md) for Vercel configuration.
