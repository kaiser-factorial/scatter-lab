import { build } from "esbuild";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import { gzipSync, gunzipSync } from 'node:zlib';
const directory = "/tmp/scatter-efa-scala", exec = promisify(execFile);
const option = (key, fallback) => process.argv.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const sourcePath = option('source', 'scripts/efa-reference/compute/TraceServer.scala');
const mainClass = option('class', 'TraceServer');
const threads = Number(option('threads', '1'));
if (![1, 2, 4].includes(threads)) throw new Error('Invalid BLAS thread request');
const nativeArguments = process.argv.includes('--row-cache') ? ['--row-cache'] : [];
const sourceDigest = createHash('sha256').update(await readFile(sourcePath)).digest('hex');
const classes = `/tmp/scatter-pipeline-${sourceDigest.slice(0, 16)}-${threads}`;
await mkdir(classes, { recursive: true });
const dependencies = JSON.parse(await readFile(`${directory}/dependencies.json`, 'utf8'));
const jars = dependencies.map(d => `${directory}/${d.artifact.split('/').at(-1)}`);
for (let i = 0; i < jars.length; i++) if (createHash('sha256').update(await readFile(jars[i])).digest('hex') !== dependencies[i].sha256) throw new Error('Dependency hash mismatch');
const pipelineArchive = process.argv.find(arg => arg.startsWith('--pipeline-archive='))?.slice('--pipeline-archive='.length);
let pipelineBundle = '/tmp/scatter-compute-pipeline.mjs';
if (pipelineArchive) {
  const bytes = gunzipSync(await readFile(pipelineArchive));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (!pipelineArchive.endsWith(`/${digest}.mjs.gz`)) throw new Error('Archived pipeline hash mismatch');
  pipelineBundle = `/tmp/scatter-compute-pipeline-${digest}.mjs`;
  await writeFile(pipelineBundle, bytes);
} else await build({ entryPoints: ['scripts/efa-reference/compute/pipeline.worker.mjs'], bundle: true, format: 'esm', platform: 'node', outfile: pipelineBundle });
await build({ entryPoints: ['scripts/efa-reference/compute/binary.ts'], bundle: true, format: 'esm', platform: 'node', outfile: '/tmp/scatter-compute-binary.mjs' });
await exec('java', ['-Dscala.usejavacp=true', '-cp', jars.join(':'), 'scala.tools.nsc.Main', '-d', classes, sourcePath]);
const nativeBytecode = Object.fromEntries(await Promise.all((await readdir(classes)).filter(name => name === `${mainClass}.class` || (name.startsWith(`${mainClass}$`) && name.endsWith('.class'))).sort().map(async name => [name, createHash('sha256').update(await readFile(`${classes}/${name}`)).digest('hex')])));
const { runPipeline } = await import(pipelineBundle);
const { encodeBlock, encodeOrdinalSource, encodeOrdinalRange } = await import('/tmp/scatter-compute-binary.mjs');
const nativeLibPath = process.platform === 'darwin' ? '/System/Library/Frameworks/Accelerate.framework/Accelerate' : undefined;
async function createKernel(backend) {
  const started = performance.now();
  const child = spawn('java', [...(nativeLibPath ? [`-Ddev.ludovic.netlib.blas.nativeLibPath=${nativeLibPath}`] : []), '-cp', [classes, ...jars].join(':'), mainClass, ...nativeArguments], { env: { ...process.env, VECLIB_MAXIMUM_THREADS: String(threads), OPENBLAS_NUM_THREADS: String(threads) }, stdio: ['pipe', 'pipe', 'pipe'] });
  let pending, bytes = Buffer.alloc(0), ended = false, stderr = '';
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', (code, signal) => { if (!ended) { const error = new Error(`Scala child exited ${code ?? signal}: ${stderr}`); reject(error); pending?.reject(error); } });
    child.stderr.on('data', chunk => { stderr += chunk; const line = stderr.split('\n').find(s => s.startsWith('{"ready":true')); if (line) resolve(JSON.parse(line)); });
  });
  child.stdout.on('data', chunk => {
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length < 4) return;
    const length = bytes.readUInt32BE(0);
    if (length < 8 || length > 24 + 128 * 128 * 8) { pending?.reject(new Error('Invalid child response')); child.kill(); return; }
    if (bytes.length >= length + 4 && pending) {
      const packet = bytes.subarray(4, length + 4); bytes = bytes.subarray(length + 4);
      const callback = pending; pending = undefined; callback.resolve(packet);
    }
  });
  const metadata = await ready;
  const headerDoubles = metadata.replyHeaderDoubles ?? 1;
  if (![1, 3].includes(headerDoubles)) throw new Error('Unknown native reply header');
  const timings = { startupMs: performance.now() - started, packMs: 0, roundTripMs: 0, nativeStageMs: 0, ...(headerDoubles === 3 ? { materializeMs: 0, blasMs: 0 } : {}), calls: 0, sentBytes: 0, sourceInitializations: 0, sourceInitMs: 0 };
  let residentSource;
  const request = async payload => {
    const header = Buffer.alloc(4); header.writeUInt32BE(payload.length);
    const sent = performance.now();
    const reply = await new Promise((resolve, reject) => {
      pending = { resolve, reject };
      child.stdin.write(header, error => { if (error) reject(error); });
      child.stdin.write(payload, error => { if (error) reject(error); });
    });
    timings.roundTripMs += performance.now() - sent; timings.sentBytes += payload.length + 4;
    return reply;
  };
  return { metadata: { ...metadata, precision: 'float64', scope: 'Local Scala BLAS child kernel; surrounding pipeline remains TypeScript/Node', transport: backend === 'scala-resident' ? 'Resident encoded source and projections, followed by row-range requests' : 'Expanded matrices sent for every block', nativeStageTiming: backend === 'scala-resident' ? 'Ordinal block expansion plus BLAS' : 'BLAS only', requestedBlasThreads: threads }, timings,
    async run(block) {
      if (pending) throw new Error('Only one in-flight block is supported');
      const resident = backend === 'scala-resident';
      if (resident && residentSource !== block.ordinal?.source) {
        if (!block.ordinal) throw new Error('Resident kernel requires ordinal source');
        const start = performance.now(), payload = Buffer.from(encodeOrdinalSource(block.ordinal.source));
        timings.packMs += performance.now() - start;
        await request(payload);
        timings.sourceInitializations++; timings.sourceInitMs += performance.now() - start;
        residentSource = block.ordinal.source;
      }
      const start = performance.now(), payload = Buffer.from(resident ? encodeOrdinalRange(block) : encodeBlock(block));
      timings.packMs += performance.now() - start;
      const reply = await request(payload);
      const rows = resident ? block.ordinal.leftRows : block.left.length;
      const cols = resident ? block.ordinal.rightRows : block.right.length;
      if (reply.length !== (headerDoubles + rows * cols) * 8) throw new Error('Invalid native output shape');
      timings.nativeStageMs += reply.readDoubleLE(0); timings.calls++;
      if (headerDoubles === 3) { timings.materializeMs += reply.readDoubleLE(8); timings.blasMs += reply.readDoubleLE(16); }
      const result = new Float64Array((reply.length - headerDoubles * 8) / 8);
      for (let i = 0; i < result.length; i++) result[i] = reply.readDoubleLE(headerDoubles * 8 + 8 * i);
      return result;
    },
    destroy() { ended = true; child.stdin.end(); child.kill(); },
  };
}
const output = process.argv[2] ?? 'scripts/efa-reference/compute/scala-pipeline.json';
const blockSize = Number(process.argv.find(s => s.startsWith('--block='))?.split('=')[1] ?? 32);
const budgetBytes = Number(process.argv.find(s => s.startsWith('--budget-mib='))?.split('=')[1] ?? 1024) * 1024 ** 2;
const pipelineSha256 = createHash('sha256').update(await readFile(pipelineBundle)).digest('hex');
const scalaSourceSha256 = sourceDigest;
const protocolSha256 = createHash('sha256').update(await readFile('/tmp/scatter-compute-binary.mjs')).digest('hex');
const sourceArchives = {};
await mkdir('scripts/efa-reference/compute/archives', { recursive: true });
for (const [name, path, digest] of [['pipeline', pipelineBundle, pipelineSha256], ['protocol', '/tmp/scatter-compute-binary.mjs', protocolSha256], ['scala', sourcePath, scalaSourceSha256]]) {
  const archive = `scripts/efa-reference/compute/archives/${digest}.${name === 'scala' ? 'scala' : 'mjs'}.gz`;
  try { await writeFile(archive, gzipSync(await readFile(path)), { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  sourceArchives[name] = archive;
}
let latest, lastProgress = performance.now();
const timer = setInterval(() => {
  if (latest) { console.log(JSON.stringify(latest)); void writeFile(output.replace('.json', '.progress.json'), JSON.stringify(latest, null, 2) + '\n'); }
}, 30000);
try {
  const candidate = process.argv.includes('--streamed') ? 'scala-blas' : 'scala-resident';
  const fixture = process.argv.find(s => s.startsWith('--fixture='))?.split('=')[1] ?? (process.argv.includes('--large') ? 'large' : undefined);
  const report = await runPipeline({ backends: fixture ? [candidate] : ['cpu', candidate], fixtures: fixture ? [fixture] : undefined, blockSize, budgetBytes }, {
    progress: p => {
      latest = { recordedAt: new Date().toISOString(), backend: candidate, ...p };
      if (performance.now() - lastProgress > 30000) {
        lastProgress = performance.now(); console.log(JSON.stringify(latest));
        writeFileSync(output.replace('.json', '.progress.json'), JSON.stringify(latest, null, 2) + '\n');
      }
    }, kernelFactory: createKernel,
    loadReference: async name => ({ input: JSON.parse(await readFile(`src/lib/__tests__/fixtures/efa-weighted/${name}.input.json`, 'utf8')), reference: JSON.parse(await readFile(`src/lib/__tests__/fixtures/efa-weighted/${name}.reference.json`, 'utf8')) }),
  });
  Object.assign(report, { recordedAt: new Date().toISOString(), dependencies, nativeLibPath, node: process.version, pipelineSha256, pipelineArchive, scalaSourceSha256, sourcePath, mainClass, nativeArguments, nativeBytecode, protocolSha256, sourceArchives, blockSize, budgetBytes, hardware: { cpu: os.cpus()[0].model, architecture: os.arch(), memoryBytes: os.totalmem() } });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, error: report.error, fits: report.results.map(r => ({ backend: r.backend, fixture: r.fixture, totalMs: r.totalMs, passed: r.passed })) }));
  if (['failed', 'numerical-failures'].includes(report.status)) process.exitCode = 1;
} finally { clearInterval(timer); }
