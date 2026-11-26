import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
const dir = 'scripts/efa-reference/compute';
const sha = data => createHash('sha256').update(data).digest('hex');
const median = values => { const a = [...values].sort((a, b) => a - b); return (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2; };
const summaries = [];
for (const name of (await readdir(dir)).filter(name => /^layout-.*-v4\.json$/.test(name)).sort()) {
  const report = JSON.parse(await readFile(`${dir}/${name}`, 'utf8'));
  if (report.status !== 'passed' || report.developerOnly || report.webgpuRuntimeFlags.length || report.results.length !== 10) throw new Error(`Invalid qualification: ${name}`);
  for (const result of report.results) {
    if (!result.passed || result.errors.tolerance !== 1e-10 || result.errors.maxScaled > 1e-10) throw new Error(`Failed numerical gate: ${name}`);
    if (result.output) {
      // Deduplicate exact outputs across paired runs without discarding evidence.
      const bytes = Buffer.from(Float64Array.from(result.output).buffer), hash = sha(bytes);
      if (hash !== result.outputSha256) throw new Error('Output byte hash mismatch');
      const path = `${dir}/archives/${hash}.f64le.gz`;
      await writeFile(path, gzipSync(bytes), { flag: 'wx' }).catch(e => { if (e.code !== 'EEXIST') throw e; });
      result.outputArtifact = { path, sha256: hash, length: result.output.length, encoding: 'gzip-compressed little-endian Float64' };
      delete result.output;
    }
    const bytes = gunzipSync(await readFile(result.outputArtifact.path));
    if (sha(bytes) !== result.outputSha256 || bytes.length !== result.outputArtifact.length * 8) throw new Error('Archived output invalid');
  }
  await writeFile(`${dir}/${name}`, JSON.stringify(report, null, 2) + '\n');
  summaries.push({ file: `${dir}/${name}`, sourceSha256: report.sourceSha256, workerSha256: report.workerSha256,
    blockSize: report.blockSize ?? 128, subBlock: report.subBlock, loading: report.metadata[0].loading,
    sumWarmRangeMediansMs: report.results.reduce((s, r) => s + median(r.iterationMs.slice(1)), 0),
    meanGpuMsPerTenRanges: report.results.reduce((s, r) => s + r.measurements.gpuMs, 0) / 5,
    meanReductionGpuMsPerTenRanges: report.results.reduce((s, r) => s + r.measurements.reductionGpuMs, 0) / 5,
    peakOwnedGpuBufferBytes: Math.max(...report.results.map(r => r.ownedGpuBufferBytes)),
    maxScaledError: Math.max(...report.results.map(r => r.errors.maxScaled)), outputSha256: report.results.map(r => r.outputSha256) });
}
const group = names => summaries.filter(r => names.some(suffix => r.file.endsWith(suffix)));
const layouts = Object.fromEntries(['columnar', 'cooperative', 'respondent'].map(loading => {
  const runs = group([`layout-${loading}128-b-v4.json`, `layout-${loading}128-c-v4.json`]);
  return [loading, { meanSumWarmMediansMs: runs.reduce((s, r) => s + r.sumWarmRangeMediansMs, 0) / runs.length, runs: runs.length }];
}));
const blocks = Object.fromEntries([128, 256].map(block => {
  const runs = group([`layout-block${block}-c-v4.json`, `layout-block${block}-d-v4.json`]);
  return [block, { meanSumWarmMediansMs: runs.reduce((s, r) => s + r.sumWarmRangeMediansMs, 0) / runs.length, runs: runs.length }];
}));
const report = { status: 'passed', scope: 'Targeted 500-item / 20000-row resident kernels; not new full-fit timings. Each range has five calls; wall summary excludes its first call. GPU times include all five calls. Paired orders are reversed. Initial a and block a/b retain preliminary versions; final block comparison is c/d.', layouts, blocks, summaries };
await writeFile(`${dir}/cache-layout-summary-v4.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ layouts, blocks, allMaxScaledError: Math.max(...summaries.map(r => r.maxScaledError)) }));
