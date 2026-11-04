// Targeted optimization harness. Run sequentially after the full baseline fits.
// It never publishes application results or executes the full JS CPU baseline.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { delimiter } from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';
import { residentFixture } from './resident-fixture.mjs';

const option = (key, fallback) => process.argv.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const output = process.argv[2];
if (!output || output.startsWith('--')) throw new Error('Provide a new output JSON path');
try { await access(output); throw new Error('The output path already exists; preserve it and use a new path'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const threads = Number(option('threads', '1')), repeats = Number(option('repeats', '5'));
if (![1, 2, 4].includes(threads) || !Number.isSafeInteger(repeats) || repeats < 2 || repeats > 20) throw new Error('Invalid threads or repetitions');
const sourcePath = option('source', 'scripts/efa-reference/compute/TraceServer.scala');
const mainClass = option('class', 'TraceServer');
const nativeArguments = process.argv.includes('--row-cache') ? ['--row-cache'] : [];
const referencePath = option('reference', undefined);
const reference = referencePath ? JSON.parse(await readFile(referencePath, 'utf8')) : undefined;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const exec = promisify(execFile), dependencyDirectory = '/tmp/scatter-efa-scala';
const dependencies = JSON.parse(await readFile(`${dependencyDirectory}/dependencies.json`, 'utf8'));
const jars = dependencies.map(d => `${dependencyDirectory}/${d.artifact.split('/').at(-1)}`);
for (let i = 0; i < jars.length; i++) if (hash(await readFile(jars[i])) !== dependencies[i].sha256) throw new Error('Dependency hash mismatch');
const sourceSha256 = hash(await readFile(sourcePath));
const classes = `/tmp/scatter-resident-${sourceSha256.slice(0, 16)}-${threads}`;
await mkdir(classes, { recursive: true });
const compileStarted = performance.now();
await exec('java', ['-Dscala.usejavacp=true', '-cp', jars.join(delimiter), 'scala.tools.nsc.Main', '-d', classes, sourcePath]);
const compileMs = performance.now() - compileStarted;
const binaryBundle = `/tmp/scatter-resident-protocol-${process.pid}.mjs`;
await build({ entryPoints: ['scripts/efa-reference/compute/binary.ts'], bundle: true, format: 'esm', platform: 'node', outfile: binaryBundle });
const protocolSha256 = hash(await readFile(binaryBundle));
const { encodeOrdinalSource, encodeOrdinalRange } = await import(binaryBundle);
const generated = performance.now();
let fixture = residentFixture();
const fixtureMs = performance.now() - generated, manifest = fixture.manifest;
const beforePack = performance.now();
let payload = Buffer.from(encodeOrdinalSource(fixture.source));
const packMs = performance.now() - beforePack, inputSha256 = hash(payload), sourceBytes = payload.length;
if (reference && (reference.inputSha256 !== inputSha256 || reference.results?.length !== fixture.blocks.length)) throw new Error('Reference input fingerprint or block count differs');
const ranges = fixture.blocks.map(encodeOrdinalRange).map(bytes => Buffer.from(bytes));
fixture = undefined;

const nativeLibPath = process.platform === 'darwin' ? '/System/Library/Frameworks/Accelerate.framework/Accelerate' : undefined;
const launched = performance.now();
const child = spawn('java', [...(nativeLibPath ? [`-Ddev.ludovic.netlib.blas.nativeLibPath=${nativeLibPath}`] : []), '-cp', [classes, ...jars].join(delimiter), mainClass, ...nativeArguments], {
  env: { ...process.env, VECLIB_MAXIMUM_THREADS: String(threads), OPENBLAS_NUM_THREADS: String(threads) }, stdio: ['pipe', 'pipe', 'pipe'],
});
let pending, incoming = Buffer.alloc(0), stderr = '', stopping = false, dispatchAcknowledged;
const ready = new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (!stopping) { const error = new Error(`Native child exited ${code ?? signal}: ${stderr}`); reject(error); pending?.reject(error); }
  });
  child.stderr.on('data', chunk => {
    stderr = (stderr + chunk).slice(-65536);
    const line = stderr.split('\n').find(value => value.startsWith('{"ready":true'));
    if (line) resolve(JSON.parse(line));
    if (stderr.includes('{"probeDispatched":true}')) dispatchAcknowledged?.();
  });
});
child.stdout.on('data', chunk => {
  incoming = Buffer.concat([incoming, chunk]);
  if (incoming.length < 4) return;
  const length = incoming.readUInt32BE(0);
  if (length < 8 || length > 32 + 128 * 128 * 8) { pending?.reject(new Error('Invalid native reply length')); child.kill(); return; }
  if (incoming.length >= length + 4 && pending) {
    const reply = incoming.subarray(4, length + 4); incoming = incoming.subarray(length + 4);
    const callback = pending; pending = undefined; callback.resolve(reply);
  }
});
const request = packet => {
  if (pending) throw new Error('Only one in-flight request is supported');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('Native request exceeded five minutes')); child.kill(); }, 300000);
    pending = { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
    const header = Buffer.alloc(4); header.writeUInt32BE(packet.length);
    child.stdin.write(header, error => { if (error) pending?.reject(error); });
    child.stdin.write(packet, error => { if (error) pending?.reject(error); });
  });
};
const median = values => { const sorted = values.slice().sort((a, b) => a - b); return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2; };
const difference = (expected, actual) => {
  if (expected.length !== actual.length) throw new Error('Reference output shape differs');
  let maxAbsolute = 0, maxScaled = 0, failures = 0;
  for (let i = 0; i < expected.length; i++) {
    const absolute = Math.abs(expected[i] - actual[i]), scaled = absolute / Math.max(1, Math.abs(expected[i]));
    maxAbsolute = Math.max(maxAbsolute, absolute); maxScaled = Math.max(maxScaled, scaled);
    if (!Number.isFinite(expected[i]) || !Number.isFinite(actual[i]) || scaled > 1e-10) failures++;
  }
  return { maxAbsolute, maxScaled, failures, tolerance: 1e-10, passed: failures === 0 };
};
let partialResults, runtimeMetadata;
try {
  const metadata = await ready, startupMs = performance.now() - launched;
  runtimeMetadata = metadata;
  const initStarted = performance.now();
  await request(payload); payload = undefined;
  const sourceInitMs = performance.now() - initStarted;
  const headerDoubles = metadata.replyHeaderDoubles ?? 1;
  if (![1, 3].includes(headerDoubles)) throw new Error('Unknown native timing header');
  const results = ranges.map((_, index) => ({ range: manifest.ranges[index], calls: [], output: undefined }));
  partialResults = results;
  const iterationMs = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    const iterationStart = performance.now();
    for (let i = 0; i < ranges.length; i++) {
      const before = performance.now(), reply = await request(ranges[i]), roundTripMs = performance.now() - before;
      const result = results[i], length = result.range[2] * result.range[3];
      if (reply.length !== (headerDoubles + length) * 8) throw new Error('Invalid native output shape');
      const values = Array.from({ length }, (_, j) => reply.readDoubleLE((j + headerDoubles) * 8));
      if (values.some(value => !Number.isFinite(value))) throw new Error('Non-finite native output');
      const errors = reference ? difference(reference.results[i].output, values) : result.output ? difference(result.output, values) : undefined;
      result.calls.push({ roundTripMs, nativeStageMs: reply.readDoubleLE(0), ...(headerDoubles === 3 ? { materializeMs: reply.readDoubleLE(8), blasMs: reply.readDoubleLE(16) } : {}), errors });
      result.output ??= values;
    }
    iterationMs.push(performance.now() - iterationStart);
  }
  const passed = results.every(result => result.calls.every(call => !call.errors || call.errors.passed));
  let cancellation;
  if (metadata.cancellationProbe === true) {
    let dispatchTimer;
    const dispatched = new Promise((resolve, reject) => {
      dispatchTimer = setTimeout(() => reject(new Error('Native cancellation probe did not start')), 10000);
      dispatchAcknowledged = () => { clearTimeout(dispatchTimer); resolve(); };
    });
    const probePacket = Buffer.from(ranges[1]); probePacket.writeUInt32LE(0x45464134, 0);
    const probe = request(probePacket);
    // Attach immediately: an unexpected native exit must not become an
    // unhandled rejection while the dispatch acknowledgement is awaited.
    void probe.catch(() => {});
    try { await dispatched; } finally { clearTimeout(dispatchTimer); }
    stopping = true;
    const beforeKill = performance.now();
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    if (!child.kill('SIGTERM')) throw new Error('Native cancellation signal was not delivered');
    pending?.reject(new Error('Intentional native cancellation probe')); pending = undefined;
    await probe.catch(() => {});
    const terminal = await exited, acknowledgedMs = performance.now() - beforeKill;
    cancellation = { acknowledgedMs, passed: acknowledgedMs < 1000, requestedSignal: 'SIGTERM', terminal, range: manifest.ranges[1], scope: 'Actual owned JVM exit after acknowledging a repeated 128-row resident kernel workload. Excludes compilation, startup and input preparation; not an application companion UI cancellation test.' };
  }
  const report = {
    status: !passed ? 'numerical-failures' : cancellation?.passed === false ? 'cancellation-failure' : reference ? 'passed' : 'reference-recorded', recordedAt: new Date().toISOString(),
    scope: 'Resident case-block kernel benchmark. Generation, compilation, JVM startup and source initialization are separate. Does not measure a complete EFA fit.',
    referencePath, referenceSha256: referencePath ? hash(await readFile(referencePath)) : undefined,
    sourcePath, sourceSha256, protocolSha256, dependencies, inputSha256, sourceBytes, manifest, mainClass, nativeArguments,
    requestedBlasThreads: threads, threadCountCaveat: 'Environment request; actual BLAS thread count is not observed.',
    hardware: { cpu: os.cpus()[0].model, architecture: os.arch(), memoryBytes: os.totalmem() }, metadata,
    compileMs, fixtureMs, packMs, startupMs, sourceInitMs, iterationMs,
    firstIterationMs: iterationMs[0], subsequentMedianMs: median(iterationMs.slice(1)), results, cancellation,
  };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, requestedBlasThreads: threads, firstIterationMs: report.firstIterationMs, subsequentMedianMs: report.subsequentMedianMs }));
  if (!passed || cancellation?.passed === false) process.exitCode = 1;
} catch (error) {
  await writeFile(output, JSON.stringify({ status: 'failed', recordedAt: new Date().toISOString(), error: String(error), sourcePath, sourceSha256, protocolSha256, inputSha256, manifest, requestedBlasThreads: threads, metadata: runtimeMetadata, results: partialResults ?? [], stderr }, null, 2) + '\n', { flag: 'wx' });
  console.error(String(error)); process.exitCode = 1;
} finally {
  stopping = true;
  if (!child.stdin.destroyed) child.stdin.end();
  if (child.exitCode === null && child.signalCode === null) child.kill();
}
