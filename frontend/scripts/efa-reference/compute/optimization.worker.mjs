import { createGpuKernel } from './webgpu-kernel.mjs';
import { decodeBlock, difference, encodeOrdinalSource } from './binary.ts';
import { residentFixture } from './resident-fixture.mjs';
const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
const configurations = {
  'gpu-split': { split: true },
  'gpu-compensated-split': { split: true, compensatedSplit: true },
  'gpu-compensated-reduced': { split: true, compensatedSplit: true, reduce: true },
  'gpu-portable-reduced': { split: true, portable: true, reduce: true },
};
const flatErrors = (expected, actual, tolerance) => {
  if (expected.length !== actual.length) throw new Error('Output dimensions differ');
  let maxAbs = 0, maxScaled = 0, failures = 0;
  for (let i = 0; i < expected.length; i++) {
    const error = Math.abs(expected[i] - actual[i]), scaled = error / Math.max(1, Math.abs(expected[i]));
    maxAbs = Math.max(maxAbs, error); maxScaled = Math.max(maxScaled, scaled);
    if (!Number.isFinite(actual[i]) || !Number.isFinite(expected[i]) || scaled > tolerance) failures++;
  }
  return { maxAbs, maxScaled, failures, tolerance, passed: failures === 0 };
};
self.onmessage = async ({ data: options }) => {
  const results = [], metadata = [], mode = options.experimentMode ?? 'kernels';
  let kernel;
  try {
    let resident, reference, sourceSha256;
    if (mode === 'resident') {
      self.postMessage({ stage: 'Preparing synthetic resident inputs' });
      resident = residentFixture();
      reference = await (await fetch('./optimization-reference.json')).json();
      let encoded = encodeOrdinalSource(resident.source);
      sourceSha256 = await hash(encoded); encoded = undefined;
      if (sourceSha256 !== reference.inputSha256) throw new Error('Resident input hash does not match the native Float64 reference');
    } else if (mode !== 'kernels') throw new Error('Unknown optimization experiment');
    const manifest = mode === 'kernels' ? await (await fetch('./fixtures/manifest.json')).json() : undefined;
    const defaults = Object.keys(configurations).filter(backend => !options.strictMath || backend !== 'gpu-portable-reduced');
    for (const backend of options.backends ?? defaults) {
      if (!configurations[backend]) throw new Error(`Unknown experimental variant ${backend}`);
      try {
        kernel = await createGpuKernel({ ...configurations[backend], resident: mode === 'resident', strictMath: options.strictMath ? true : undefined });
        metadata.push({ ...kernel.metadata, variant: backend });
        const fixtures = mode === 'kernels' ? manifest.fixtures : reference.results.map((value, index) => ({ name: `resident-range-${index}`, index, range: value.range }));
        for (const fixture of fixtures) {
          self.postMessage({ stage: `${backend}: ${fixture.name}` });
          let block, expected, inputSha256;
          if (mode === 'kernels') {
            const raw = await (await fetch(`./fixtures/${fixture.name}.bin`)).arrayBuffer();
            const expectedBytes = await (await fetch(`./fixtures/${fixture.name}.reference.bin`)).arrayBuffer();
            inputSha256 = await hash(raw);
            if (inputSha256 !== fixture.inputSha256 || await hash(expectedBytes) !== fixture.referenceSha256) throw new Error('Kernel fixture hash mismatch');
            block = decodeBlock(raw); expected = new Float64Array(expectedBytes);
          } else {
            block = resident.blocks[fixture.index]; expected = reference.results[fixture.index].output; inputSha256 = sourceSha256;
          }
          const before = { ...kernel.timings }, iterationMs = [];
          let output;
          for (let repeat = 0; repeat < 5; repeat++) {
            const started = performance.now(); output = await kernel.run(block); iterationMs.push(performance.now() - started);
          }
          const compare = tolerance => mode === 'kernels' ? difference(block, expected, output, tolerance) : flatErrors(expected, output, tolerance);
          const errors = compare(1e-10), baselineToleranceErrors = compare(1e-5);
          results.push({ fixture: fixture.name, range: fixture.range, backend, precision: kernel.metadata.precision, inputSha256, iterationMs, errors, baselineToleranceErrors, passed: errors.passed,
            measurements: Object.fromEntries(Object.entries(kernel.timings).filter(([key]) => !['startupMs', 'peakOwnedGpuBufferBytes'].includes(key)).map(([key, value]) => [key, value === null ? null : value - before[key]])),
            ownedGpuBufferBytes: kernel.timings.peakOwnedGpuBufferBytes, outputSha256: await hash(output.buffer), output: Array.from(output) });
        }
      } catch (error) { results.push({ backend, fixture: 'experiment-failure', passed: false, error: String(error) }); }
      finally { kernel?.destroy(); kernel = undefined; }
    }
    self.postMessage({ result: { status: results.every(value => value.passed) ? 'passed' : 'numerical-failures', mode, strictMathRequested: !!options.strictMath, developerOnly: !!options.strictMath, scope: 'Targeted precision/readback experiments. Neither a completed full fit nor default-browser qualification when developer flags are required.', sourceSha256, metadata, results } });
  } catch (error) { kernel?.destroy(); self.postMessage({ result: { status: 'failed', error: String(error), mode, results, metadata } }); }
};
