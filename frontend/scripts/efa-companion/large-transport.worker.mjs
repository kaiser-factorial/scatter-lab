import { createBackend } from '../../src/lib/efa/backends/runtime.ts';
import { createCompanionSession, closeCompanionSession, companionRequest } from '../../src/lib/efa/backends/companion.ts';
import { checkSource, checkBlock } from '../../src/lib/efa/backends/self-check.ts';
import { cpuTraceBlock } from '../../src/lib/efa/trace-kernel.ts';
self.onmessage = async ({ data }) => {
  let session, backend, heartbeat;
  try {
    const started = performance.now(), spec = { extraction: 'wlsmv', compute: { backend: data.backend } };
    self.postMessage({ stage: 'Initializing backend' });
    if (data.backend === 'scala') { session = await createCompanionSession(data.pairing); heartbeat = setInterval(() => { void companionRequest(session, `/v1/jobs/${session.id}/heartbeat`, 'POST').catch(() => {}); }, 15000); }
    backend = await createBackend(spec, session, execution => self.postMessage({ stage: `Kernel ${execution.state}` }), p => self.postMessage({ stage: p.stage }));
    self.postMessage({ stage: 'Generating public 500 × 20000 source' });
    const source = checkSource(500, 20000);
    source.projection = Array.from({ length: 20000 }, (_, row) => Float64Array.from({ length: 2490 }, (_, col) => Math.cos(row * .3 + col) * .01));
    const size = data.backend === 'scala' ? 256 : 128;
    const block = { ordinal: { source, leftStart: 0, rightStart: 0, leftRows: size, rightRows: size }, diagonal: true };
    self.postMessage({ stage: 'Uploading full source and evaluating one selected-size block' });
    const output = await backend.run(block), expected = cpuTraceBlock(checkBlock(source, 0, 0, 2, 2));
    let maxScaledError = 0;
    for (const [out, ref] of [[0, 0], [size, 2], [size + 1, 3]]) maxScaledError = Math.max(maxScaledError, Math.abs(output[out] - expected[ref]) / Math.max(1, Math.abs(expected[ref])));
    if (!Number.isFinite(maxScaledError) || maxScaledError > 1e-10) throw new Error('Large-source sampled numerical control failed');
    self.postMessage({ result: { status: 'passed', backend: data.backend, dimensions: { items: 500, respondents: 20000, parameters: 2490, pairs: 124750 }, blockRows: size, sampledValues: 3, maxScaledError, elapsedMs: performance.now() - started, execution: backend.finish(), scope: 'Full resident-source upload and one block, with three Float64 sampled checks. Not a full EFA fit or a new end-to-end performance benchmark.' } });
  } catch (error) { self.postMessage({ error: error.message }); }
  finally { clearInterval(heartbeat); backend?.destroy(); if (session) await closeCompanionSession(session); }
};
