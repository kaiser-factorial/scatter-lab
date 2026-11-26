# Caller-supplied Plotly factory

This local package exposes the factory from **react-plotly.js 4.1.0**, published
on **2026-07-29** and reviewed here on **2026-11-06**. The copied
factory entry, implementation chunk, declarations, source maps, and MIT license
are byte-for-byte upstream files. `PROVENANCE.json` records their SHA-256 hashes
and the upstream npm artifact's locked URL and integrity.

```tsx
import Plotly from 'plotly.js-gl3d-dist-min';
import createPlotlyComponent from '@scatterlab/react-plotly-factory';

const Plot = createPlotlyComponent(Plotly);
```

The caller must supply a compatible Plotly instance. Scatter Lab continues to
use `plotly.js-gl3d-dist-min`; this package neither imports nor installs a Plotly
bundle. Its only peer dependency is React. It omits upstream's default component,
which imports the full `plotly.js` package, and therefore omits that unused peer.
There is no lifecycle script or build step in this package.

The upstream implementation is retained, including data/layout/config identity
checks, frame-count and revision updates, serialized `Plotly.react` calls, event
callbacks, forwarded graph-div refs, window resize handling, and unmount purge.
Changing this dependency does not rewrite those behaviors or fix upstream edge
cases. Plot sizing, pinned-view identity, WebGL, and exports continue to use the
app's existing integration and Plotly bundle.

The 4.1.0 update centralizes the event registry. It adds `onAnimating`,
`onBeforePlot`, `onIcicleClick`, legend-title callbacks, `onTransitioned` and
`onTreemapClick`; removes `onClickAnywhere` and `onHoverAnywhere`; and stops
`plotly_sunburstclick` from triggering `onUpdate`. Scatter Lab does not use those
removed props. The factory still imports only React and delegates plotting to
the supplied instance. Inspection of these factory artifacts found no added
fetch, socket, beacon or upload path; this statement does not cover the separate
Plotly bundle or the application's configuration.

The adapter regression tests in
`src/components/__tests__/plotly-factory.test.tsx` exercise lifecycle and callback
contracts using a Plotly double. They do not establish WebGL rendering or image
export correctness; those require browser checks with the actual bundle.

To update this vendor copy, review a specific upstream release, copy its factory
entry and every runtime chunk it imports, retain its declarations, source maps,
and license, and update the file hashes and artifact integrity in
`PROVENANCE.json`. Keep the factory caller-supplied, inspect the dependency graph,
then run the adapter tests, type check, production build, and plot/browser checks.
Do not replace the upstream factory with a separately implemented wrapper as part
of a dependency-only update.
