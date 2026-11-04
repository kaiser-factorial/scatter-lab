// Independent sampler stays responsive while a child numerical stage blocks.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
const [output, command, ...args] = process.argv.slice(2);
if (!output || !command) throw new Error('run-monitored.mjs report-prefix command [arguments]');
const exec = promisify(execFile), started = Date.now();
const child = spawn(command, args, { stdio: 'inherit', detached: true });
let peakRss = 0, samples = 0, errors = 0, sampling = false, lastSample;
const sample = async () => {
  if (sampling || !child.pid) return;
  sampling = true;
  try {
    const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,rss=']);
    const entries = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    const members = new Set([child.pid]);
    for (let pass = 0; pass < 10; pass++) for (const [pid, parent] of entries) if (members.has(parent)) members.add(pid);
    const rss = entries.filter(([pid]) => members.has(pid)).reduce((sum, entry) => sum + entry[2] * 1024, 0);
    peakRss = Math.max(peakRss, rss); samples++;
    lastSample = { recordedAt: new Date().toISOString(), rootPid: child.pid, rssBytes: rss, peakRssBytes: peakRss, samples, samplingErrors: errors, elapsedMs: Date.now() - started, method: 'One-second summed process-tree RSS samples; shared pages may be counted more than once' };
    if (samples % 5 === 0) await writeFile(`${output}.memory.json`, JSON.stringify(lastSample, null, 2) + '\n');
  } catch { errors++; } finally { sampling = false; }
};
const timer = setInterval(sample, 1000);
const stop = signal => { if (child.pid) { try { process.kill(-child.pid, signal); } catch {} } };
process.on('SIGINT', () => stop('SIGINT')); process.on('SIGTERM', () => stop('SIGTERM'));
child.on('error', error => { clearInterval(timer); console.error(error); process.exitCode = 1; });
child.on('exit', async (code, signal) => {
  clearInterval(timer); await sample();
  await writeFile(`${output}.memory.json`, JSON.stringify({ ...lastSample, exitCode: code, signal, elapsedMs: Date.now() - started, samplingErrors: errors }, null, 2) + '\n');
  process.exitCode = code ?? 1;
});
