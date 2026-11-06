# Assistant application reference

The assistant receives an authored application overview on every model request.
The current user question also selects up to two implementation-guide sections,
with a combined 5,000-character limit. Selection is local, deterministic keyword
and phrase matching; it does not wait for the model to request a lookup and does
not require embeddings or another service. Only authored guide text enters this
system context; the question is not copied into that reference block. Generic
follow-up questions may select no additional section, while the overview and
conversation remain available.

`frontend/src/lib/app-guide.ts` owns these sections. The existing
`get_methods_reference` tool remains available for interpretation guidance and
now includes EFA, factor parallel analysis, FIML/completion and MICE/stability
implementation topics. Neither guide text nor source inspection establishes a
dataset's assumptions or replaces actual analysis results.

The authored guide can describe app behavior and cite the project documents or
frontend files used to write it. Those paths record **authoring provenance**, not
the tool allowlist. Only paths inside the statistics package described below are
inspectable. The assistant uses the guide and current app tools for UI behavior,
privacy policy and run-specific facts; it does not infer app behavior from a
package default when the app may supply a different setting.

## Inspecting implementation source

Two read-only tools inspect the `@scatterlab/stats` package in both private and
open data modes:

- `search_app_reference`: search published file paths and contents, or list files
  with an empty query. Results contain paths, source hashes, line numbers and
  short excerpts. Whole-word/identifier matching, distinct-term coverage and
  rarer-term weighting prevent repetitive substring matches from dominating.
- `read_app_source`: read an exact published path with one-based `startLine` and
  at most 120 lines. A 16,000-character text budget returns explicit pagination
  rather than silently omitting the rest of the file.

The assistant is instructed to read surrounding lines before making code claims,
cite the returned paths/lines, distinguish package APIs from app behavior, and
report unavailable coverage. App adapters are not in the inspectable snapshot.
Source inspection is optional model behavior;
automatic guide injection is enforced by the request construction. A scripted
tool replay verifies plumbing, not whether a live model will always inspect or
correctly explain the source.

## What ships

`frontend/scripts/generate-app-reference.mjs` produces a content-addressed JSON
asset under `frontend/public/assistant-reference/` and a small generated manifest
under `frontend/src/lib/generated/`. The current allowlist contains:

- TypeScript source under `packages/statistics/src`, including public APIs and
  the numerical kernels used by the app.
- Exactly five package documents: `packages/statistics/README.md`, `PCA.md`,
  `EFA.md`, `VALIDATION.md` and `NOTICE.md`.

The exact allowlist lives in the generator. **Only the statistics package is
published in this snapshot.** All frontend files and app documents elsewhere in
the repository are excluded, along with environment files, datasets, workspace
exports, dependency trees, tests, validation fixtures and other repository
content. The package's private/unpublished npm status does not
make these selected assets private: **the reference source is intentionally
publicly downloadable wherever this frontend build is served**. Add files to
the allowlist only when they are intended to be shipped with the app.

The generator rejects symlinks, malformed text, oversized files and unexpected
inventory growth. It preserves exact UTF-8 text and records each file's SHA-256.
The client lazily fetches one fixed same-origin asset, rejects redirects, verifies
its complete size and SHA-256 against the bundled manifest, and caches it for
subsequent lookups. Model arguments select records within that verified corpus;
they cannot become arbitrary URLs or filesystem reads. Retrieval does not
execute source code or expand dataset access. Retrieved excerpts join the
conversation sent to the configured assistant endpoint, just like other tool
results; no separate embedding/search provider receives the query.

## Generation and verification

`predev` and `prebuild` build the numerical package and then generate the source
snapshot. `pretest` and `ci:fast` generate it for tests. Generated assets and the
manifest are ignored by Git. `npm run build:reference` in `frontend/` can refresh
the reference explicitly; it snapshots source and does not compile the package.

The `dev` launcher runs the normal frontend development script, which watches
the package source and the five package documents. A successful library rebuild
refreshes the reference; package-document refreshes verify that the existing library
build still matches its sources. Failed builds retain the previous snapshot.
An already-running launcher process needs its next normal restart to pick up
changes to the watcher script itself. Prior package-only content-addressed assets
are retained locally for existing tabs. Earlier generated snapshots containing
files outside the package allowlist are removed when the reference is generated.
Deployment asset-retention behavior remains a hosting concern. If an older tab's
asset is unavailable, its lookup fails explicitly and does not substitute a newer
source version.

Verification commands, from `frontend/`:

```sh
npm run ci:fast
npm run build
# Start/reuse the local app from the repository with the required launcher:
dev start frontend --detach --json --yes
node scripts/check-app-reference-browser.mjs http://localhost:3000
```

The tests cover authored-context routing, private-mode tool availability,
allowlist and symlink boundaries, deterministic source hashes, corrupt/missing
assets, argument/output bounds, real-corpus retrieval questions and assistant
dispatch. The browser check uses the real app bridge and same-origin asset with
a scripted model, makes no paid model requests, blocks third-party requests and
does not load or modify datasets.
