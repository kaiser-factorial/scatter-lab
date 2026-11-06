import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const directory = path.dirname(fileURLToPath(import.meta.url));
export const protocol = 'scatter-efa-companion/2';
export const source = path.join(directory, 'TraceServerPanel.scala');
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const kernelSha256 = sha256(await readFile(source));
export const dependencies = JSON.parse(await readFile(path.join(directory, 'dependencies.json'), 'utf8'));
export function environment(threads) {
  return { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    VECLIB_MAXIMUM_THREADS: String(threads), OPENBLAS_NUM_THREADS: String(threads), OMP_NUM_THREADS: String(threads) };
}
export async function compile(cache) {
  const jars = dependencies.map(d => path.join(cache, path.basename(d.artifact)));
  for (let i = 0; i < jars.length; i++) if (sha256(await readFile(jars[i])) !== dependencies[i].sha256) throw new Error('Pinned dependency verification failed. Run efa:companion:setup.');
  await mkdir(cache, { recursive: true });
  const classes = await mkdtemp(path.join(cache, 'classes-'));
  await promisify(execFile)('java', ['-Dscala.usejavacp=true', '-cp', jars.join(path.delimiter), 'scala.tools.nsc.Main', '-d', classes, source], { env: environment(1), timeout: 60000, maxBuffer: 65536 });
  return [classes, ...jars].join(path.delimiter);
}
export function nativeKernel(classpath, threads) {
  const child = spawn('java', ['-Xmx1536m', ...(process.platform === 'darwin' ? ['-Ddev.ludovic.netlib.blas.nativeLibPath=/System/Library/Frameworks/Accelerate.framework/Accelerate'] : []), '-cp', classpath, 'TraceServerPanel'], { env: environment(threads), stdio: ['pipe', 'pipe', 'pipe'] });
  let pending, buffer = Buffer.alloc(0), stderr = '', closed = false;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const exit = new Promise(resolve => child.once('close', resolve));
  const fail = () => { const error = new Error('Native kernel failed'); rejectReady(error); if (pending) clearTimeout(pending.timer); pending?.reject(error); pending = undefined; };
  child.on('error', fail); child.on('exit', () => { closed = true; fail(); });
  child.stdin.on('error', fail);
  child.stderr.on('data', data => {
    stderr = (stderr + data.toString()).slice(-8192);
    const line = stderr.split('\n').find(s => s.startsWith('{"ready":true'));
    if (line) { try { const info = JSON.parse(line); if (!info.backend.includes('JNI') || info.replyHeaderDoubles !== 3) throw new Error(); resolveReady(info); } catch { fail(); } }
  });
  child.stdout.on('data', data => {
    buffer = Buffer.concat([buffer, data]);
    if (buffer.length < 4) return;
    const length = buffer.readUInt32BE(0);
    if (length < 8 || length > 24 + 256 * 256 * 8 || !pending) { fail(); child.kill(); return; }
    if (buffer.length >= length + 4) {
      const result = buffer.subarray(4, length + 4); buffer = buffer.subarray(length + 4);
      const job = pending; pending = undefined; clearTimeout(job.timer); job.resolve(result);
    }
  });
  const startup = setTimeout(() => { fail(); child.kill(); }, 20000);
  void ready.then(() => clearTimeout(startup), () => clearTimeout(startup));
  return { ready,
    request(bytes) {
      if (closed || pending) return Promise.reject(new Error('Native kernel unavailable'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { fail(); child.kill(); }, 120000);
        pending = { resolve, reject, timer };
        const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length);
        child.stdin.write(header); child.stdin.write(bytes);
      });
    },
    async stop() {
      clearTimeout(startup); if (pending) clearTimeout(pending.timer);
      if (!closed) child.kill('SIGTERM');
      const force = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 400);
      await exit; clearTimeout(force);
    },
  };
}
