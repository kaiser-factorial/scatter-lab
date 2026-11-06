// Preserve the verbose synthetic outputs losslessly without committing 80+ MB of JSON.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
const path = process.argv[2] ?? 'scripts/efa-reference/compute/paired-full-large-v7.json';
const bytes = await readFile(path), report = JSON.parse(bytes);
if (report.status !== 'passed') throw Error('Only archive a completed, qualified pair');
const archive = `${path}.gz`, compressed = gzipSync(bytes);
if (!gunzipSync(compressed).equals(bytes)) throw Error('Archive round-trip mismatch');
await writeFile(archive, compressed, { flag: 'wx' }).catch(async error => {
  if (error.code !== 'EEXIST' || !gunzipSync(await readFile(archive)).equals(bytes)) throw error;
});
const sha = value => createHash('sha256').update(value).digest('hex');
const retainedArchive = await readFile(archive);
const summary = {
  ...report,
  archive: { path: archive, sha256: sha(retainedArchive), uncompressedSha256: sha(bytes), bytes: retainedArchive.length, uncompressedBytes: bytes.length },
  arms: report.arms.map(({ result, ...arm }) => ({ ...arm, result: {
    dimensions: result.dimensions, inputSha256: result.inputSha256, scope: result.scope,
    totalMs: result.totalMs, dataGenerationMs: result.dataGenerationMs, scoreMs: result.scores.elapsedMs,
    rotations: result.results.map(r => ({ rotation: r.rotation, elapsedMs: r.elapsedMs,
      extractionConvergence: r.extraction.convergence, rotationConvergence: r.rotationConvergence,
      test: r.weighted.robust.test, execution: r.provenance.execution,
      stages: r.report.stages, workerStages: r.report.workerStages })),
  } })),
};
await writeFile(path.replace(/\.json$/, '.summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ status: summary.status, archive: summary.archive, comparison: summary.comparison }));
