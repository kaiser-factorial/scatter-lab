# Where Scatter Lab processes and sends data

The default analysis path is local to the browser. A website server delivers
the JavaScript, styles, fonts and other assets that the browser executes; it
does not need the dataset to perform the default calculations. Opening a file
in Scatter Lab is a local file read, even when the interface calls it an upload.
Optional assistant and feedback features have separate destinations.

This document describes the application source, not a capture of a particular
deployment's traffic or a guarantee about a configured provider's retention.
Downloaded exports and text typed into chat or feedback may contain individual data.

## Default local analysis

[`parse.ts`](../frontend/src/lib/parse.ts) reads CSV with `File.text()`, XLSX with
`File.arrayBuffer()` and a local workbook worker, and Parquet with
`File.arrayBuffer()` and the local decoder. These file-import paths do not
POST the selected file to the hosting server.

The `@scatterlab/stats` package supplies the CPU numerical implementations.
The frontend [`EfaService`](../frontend/src/lib/efa/service.ts) runs EFA jobs in
browser Web Workers and transfers their inputs through worker messages. A
worker is a browser execution context, not a remote service. The default EFA
compute setting is Browser CPU. See the [library architecture](STATISTICS-LIBRARY.md)
for the package/app boundary.

Saved workspaces and session autosave use the browser's IndexedDB through
[`workspaces.ts`](../frontend/src/lib/workspaces.ts). This is browser storage,
not an app-managed cloud account. Closing a tab is not a reliable way to erase
an autosaved session, and browser storage can also be cleared or evicted.

The page still requests code/assets from its hosting origin. The Iris demo is a
GET of `/demo/iris.csv`; the package-source inspector fetches its published
`/assistant-reference/<hash>.json` asset. Hosting infrastructure may record
ordinary request information. Those asset downloads do not contain the user's
analysis file in their request bodies.

## WebGPU

**WebGPU is local GPU computation.** The
[`WebGPU kernel`](../frontend/src/lib/efa/backends/webgpu-kernel.mjs) requests a
browser GPU adapter/device, copies numerical arrays into GPU buffers and submits
compute commands. The browser and operating-system graphics driver mediate
access to the local GPU; the app does not send this calculation to a cloud GPU
service. A secure website origin is required by the browser API, which does not
make the calculation remote. In this app, WebGPU accelerates WLSMV trace work;
other fit stages still run in browser workers.

Browser CPU and WebGPU are the application's compute options. Scala/JVM/native
BLAS comparison code remains under `frontend/scripts/efa-companion` as
development reference material. It is not connected as an application backend:
the app does not offer JVM installation, pairing or analysis transfer to a Scala
service. Historical benchmark records describe those experiments, not a current
product capability.

## Assistant requests

[`assistant.ts`](../frontend/src/lib/assistant.ts) sends chat completions directly
from the browser to the configured OpenAI-compatible endpoint. The request
includes the user's text, conversation history, app instructions and guide,
permitted dataset/column metadata, tool definitions and prior tool results.
Requested package-source excerpts become tool results in that conversation.

- **Dataset summaries:** app tools withhold respondent rows and apply the aggregate,
  small-group/category and identifier-value restrictions. The assistant still
  receives permitted metadata and summaries; these are not automatically
  anonymous or differentially private.
- **User-entered text:** the app does not automatically redact text typed into
  chat. A user message can itself contain identifying or respondent-level data.
- **Local endpoint:** the permitted context is still sent over the configured
  API connection. It stays on the computer when that endpoint is genuinely
  local and its runtime performs inference locally. The app does not inspect
  that runtime's configuration or disable other networking because its address
  looks local.

The capability policy is in [`dataPolicy.ts`](../frontend/src/lib/dataPolicy.ts)
and the aggregate projections are in
[`aggregatePolicy.ts`](../frontend/src/lib/aggregatePolicy.ts). Model settings
and the API key are stored in browser localStorage. The key is sent to the
configured endpoint for authentication; it is not an application-server secret.
OpenRouter OAuth separately navigates to OpenRouter and exchanges an
authorization code/verifier for a key through
[`openrouterAuth.ts`](../frontend/src/lib/openrouterAuth.ts). Model-list requests
contact the configured endpoint's `/models` path.

## Feedback

When Supabase feedback is configured, the rating buttons in
[`AssistantPanel.tsx`](../frontend/src/components/AssistantPanel.tsx) send the
rating, model identifier, tool names and event/idempotency identifiers. The first
rating record contains no conversation text. If the user submits the optional
reason, that record also contains the reason and, when **Include this exchange**
is checked, the preceding user message and assistant reply. That checkbox starts
checked. The exchange may contain whatever data was typed or appeared in the
reply.

[`feedback.ts`](../frontend/src/lib/feedback.ts) queues records in IndexedDB and
POSTs them to the configured Supabase REST table. Pending records can be retried
when the panel mounts or the page closes, so disconnecting the model does not
withdraw already queued feedback. If feedback is not configured, its UI is
hidden. The service's actual storage permissions and retention depend on its
deployment; this source review did not inspect a live Supabase project.

## Downloads and rendered external content

Workspace, data and plot exports are constructed locally and offered as browser
downloads. Workspace and dataset exports can contain raw data. Interactive HTML exports embed the plotted traces and the
Plotly bundle; creating one fetches the bundle from the app's own `/vendor/`
path. The app's interactive plots and HTML exports explicitly disable Plotly's
cloud-upload button; static image exports disable plot interactions. Browser
downloads do not themselves publish the file, but the resulting
file can disclose its contents when shared. The browser/operating system chooses
the destination, which may be a user-configured synced folder.

Assistant Markdown currently supports external links and the renderer's default
image handling. Following a link, or rendering a remote Markdown image, can
contact its destination independently of a statistical calculation or model
request, subject to browser and deployment policies. There is no image-specific
suppression in the current component. This is a source-observed capability, not
evidence that a response has disclosed data through an image request. Choosing a
local model is not a whole-page network-isolation control.

These distinctions are why the app describes default analysis as local, rather
than promising that no bytes ever leave the tab or that no server exists.
