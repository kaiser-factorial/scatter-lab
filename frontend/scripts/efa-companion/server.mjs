import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { compile, nativeKernel, protocol, kernelSha256 } from './runtime.mjs';
import { MAX_SOURCE, validateSource, validateRange } from './validation.mjs';
const option = (key, fallback) => process.argv.find(a => a.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const origin = option('origin'), port = Number(option('port', '8787')), threads = Number(option('threads', '4'));
if (!origin || new URL(origin).origin !== origin || !['http:', 'https:'].includes(new URL(origin).protocol) || !Number.isInteger(port) || port < 0 || port > 65535 || ![1, 2, 4].includes(threads)) throw new Error('Use --origin=<exact workbench origin> [--port=8787] [--threads=1|2|4].');
const classpath = await compile(path.resolve(option('cache', '.efa-companion')));
const token = randomBytes(32).toString('hex'), authorization = Buffer.from(`Bearer ${token}`);
let active, creating = false;
const stopped = new Set();
const remember = id => { stopped.add(id); if (stopped.size > 256) stopped.delete(stopped.values().next().value); };
const stop = async job => {
  if (!job) return;
  if (!job.stopping) { job.cancelled = true; job.upload = undefined; job.stopping = job.kernel.stop().finally(() => { if (active === job) active = undefined; }); }
  await job.stopping;
};
const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 120000, headersTimeout: 10000 }, async (req, res) => {
  const finish = (status, body = {}) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); } };
  const auth = Buffer.from(req.headers.authorization ?? '');
  const address = server.address();
  if (req.headers.host !== `127.0.0.1:${address.port}` || req.headers.origin !== origin) { finish(403, { code: 'origin' }); return; }
  res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    if (!['GET', 'POST', 'DELETE'].includes(req.headers['access-control-request-method']) || (req.headers['access-control-request-headers'] ?? '').split(',').some(h => !['authorization', 'content-type'].includes(h.trim().toLowerCase()))) { finish(403); return; }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE'); res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    finish(204); return;
  }
  if (auth.length !== authorization.length || !timingSafeEqual(auth, authorization)) { finish(401, { code: 'authentication' }); return; }
  try {
    if (req.url === '/v1/health' && req.method === 'GET') { finish(200, { protocol, kernelSha256 }); return; }
    const create = /^\/v1\/jobs\/([a-f0-9-]{36})$/.exec(req.url);
    if (create && req.method === 'POST') {
      if (stopped.has(create[1])) { finish(409); return; }
      if (active || creating) { finish(409, { code: 'busy' }); return; }
      creating = true;
      const kernel = nativeKernel(classpath, threads), job = { id: create[1], kernel, lease: Date.now(), started: Date.now(), rows: 0, busy: false, cancelled: false };
      active = job;
      const abort = () => { if (!res.writableEnded) void stop(job); }; res.once('close', abort);
      try { const info = await kernel.ready; job.runtime = `${info.backend}; Java ${info.java}; requested BLAS threads ${threads}`; if (job.cancelled) throw new Error(); finish(201, { id: job.id }); }
      catch { await stop(job); finish(503, { code: 'native-unavailable' }); }
      finally { creating = false; res.removeListener('close', abort); }
      return;
    }
    const match = /^\/v1\/jobs\/([a-f0-9-]{36})(?:\/(source|source-start|source-chunk|source-finish|block|heartbeat))?$/.exec(req.url);
    if (!match) { finish(404); return; }
    if (req.method === 'DELETE' && !match[2]) remember(match[1]);
    const job = active;
    if (!job || job.id !== match[1]) { finish(req.method === 'DELETE' ? 200 : 404, { stopped: true }); return; }
    if (req.method === 'DELETE' && !match[2]) { await stop(job); finish(200, { stopped: true }); return; }
    if (job.cancelled) { finish(409); return; }
    job.lease = Date.now();
    if (req.method === 'GET' && !match[2]) { finish(200, { runtime: job.runtime }); return; }
    if (req.method === 'POST' && match[2] === 'heartbeat') { finish(200); return; }
    if (req.method !== 'POST' || !['source', 'source-start', 'source-chunk', 'source-finish', 'block'].includes(match[2])) { finish(405); return; }
    if (job.busy) { finish(409); return; }
    const action = match[2], limit = action === 'source' ? 4 * 1024 ** 2 : action === 'source-chunk' ? 4 * 1024 ** 2 + 4 : action === 'block' ? 20 : 4, length = Number(req.headers['content-length']);
    if (req.headers['content-type'] !== 'application/octet-stream' || !Number.isInteger(length) || length < (action.startsWith('source-') ? 4 : 20) || length > limit || req.headers['transfer-encoding']) { finish(413, { code: 'body' }); return; }
    job.busy = true;
    try {
      let bytes = Buffer.allocUnsafe(length), offset = 0;
      const abort = () => { if (!res.writableEnded) void stop(job); };
      res.once('close', abort);
      for await (const chunk of req) { if (offset + chunk.length > length || job.cancelled) throw new Error(); chunk.copy(bytes, offset); offset += chunk.length; }
      if (offset !== length || job.cancelled) throw new Error();
      if (action === 'source-start') {
        const size = bytes.readUInt32LE(0);
        if (length !== 4 || size < 24 || size > MAX_SOURCE || job.upload) throw new Error();
        job.upload = { bytes: Buffer.allocUnsafe(size), offset: 0 }; job.rows = 0;
        finish(200); res.removeListener('close', abort); return;
      }
      if (action === 'source-chunk') {
        const upload = job.upload;
        if (!upload || length <= 4 || bytes.readUInt32LE(0) !== upload.offset || upload.offset + length - 4 > upload.bytes.length) throw new Error();
        bytes.copy(upload.bytes, upload.offset, 4); upload.offset += length - 4;
        finish(200); res.removeListener('close', abort); return;
      }
      if (action === 'source-finish') {
        if (length !== 4 || bytes.readUInt32LE(0) !== 0 || !job.upload || job.upload.offset !== job.upload.bytes.length) throw new Error();
        bytes = job.upload.bytes; job.upload = undefined;
      } else if (job.upload) throw new Error();
      let expected;
      if (action === 'source' || action === 'source-finish') { job.rows = await validateSource(bytes, () => !job.cancelled); expected = 8; }
      else expected = validateRange(bytes, job.rows);
      if (job.cancelled) throw new Error();
      const result = await kernelRequest(job, bytes);
      if (result.length !== expected || job.cancelled) throw new Error();
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(result);
      res.removeListener('close', abort);
    } catch { await stop(job); finish(422, { code: 'native-request' }); }
    finally { job.busy = false; }
  } catch { finish(500, { code: 'companion' }); }
});
async function kernelRequest(job, bytes) { return job.kernel.request(bytes); }
server.maxConnections = 16;
const lease = setInterval(() => { if (active && (Date.now() - active.lease > 120000 || Date.now() - active.started > 8 * 60 * 60 * 1000)) void stop(active); }, 1000);
server.on('clientError', (_, socket) => socket.destroy());
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, token, origin, protocol, kernelSha256 })));
const shutdown = async () => { clearInterval(lease); await stop(active); server.closeAllConnections(); server.close(() => process.exit(0)); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
