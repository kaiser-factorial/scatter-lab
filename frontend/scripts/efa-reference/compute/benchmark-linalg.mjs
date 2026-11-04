// Targeted CPU substage measurements, not the skipped full JS/CPU fit.
// Run serially after the no-flags GPU qualification, then retain every result.
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
const output = process.argv[2];
if (!output) throw new Error('Provide a new report path');
const bundle = `/tmp/scatter-weighted-linalg-${process.pid}.mjs`;
await build({ stdin: { contents: `export * from './src/lib/efa/weighted-linalg.ts'; export {identifyLoadings} from './src/lib/efa/weighted-inference.ts'; export {Matrix} from './src/lib/efa/math.ts'; export {mulberry32} from './src/lib/random.ts';`, resolveDir: process.cwd() }, bundle: true, format: 'esm', platform: 'node', outfile: bundle });
const { projectCases, normalizeCaseProjections, covarianceQuadraticForms, identifyLoadings, Matrix, mulberry32 } = await import(bundle);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
const digestRows = rows => { const h = createHash('sha256'); for (const row of rows) h.update(new Uint8Array(row.buffer, row.byteOffset, row.byteLength)); return h.digest('hex'); };
const maxError = (a, b) => {
  if (a.length !== b.length) throw new Error('Dimension mismatch');
  let error = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) throw new Error('Non-finite comparison');
    error = Math.max(error, Math.abs(a[i] - b[i]));
  }
  return error;
};
const random = mulberry32(140591), n = 512, p = 500, k = 5;
const codes = Uint16Array.from({ length: n * p }, () => Math.floor(random() * 5)), observed = Uint8Array.from({ length: n * p }, () => random() > 0.025 ? 1 : 0);
const pairs = [];
for (let i = 0; i < p; i++) for (let j = i + 1; j < p; j++) pairs.push({ i, j, columns: 5, values: Float64Array.from({ length: 25 }, () => random() - 0.5) });
const moments = { nRows: n, pairs, weights: Float64Array.from({ length: pairs.length }, () => 0.5 + random()) }, data = { nRows: n, codes, observed };
const identified = identifyLoadings(Array.from({ length: p }, () => Array.from({ length: k }, () => random() - 0.5)));
// Original pair-major projection loop, retained here as a substage oracle.
const baselineProjection = () => {
  const z = Array.from({ length: n }, () => new Float64Array(identified.free.length));
  for (let a = 0; a < pairs.length; a++) {
    const pair = pairs[a], entries = [];
    for (let f = 0; f < k; f++) {
      if (identified.index[pair.i][f] >= 0) entries.push([identified.index[pair.i][f], identified.loadings[pair.j][f]]);
      if (identified.index[pair.j][f] >= 0) entries.push([identified.index[pair.j][f], identified.loadings[pair.i][f]]);
    }
    for (let row = 0; row < n; row++) {
      const x = pair.i * n + row, y = pair.j * n + row;
      const s = (observed[x] && observed[y] ? pair.values[codes[x] * pair.columns + codes[y]] : 0) * moments.weights[a];
      if (s) for (const [v, value] of entries) z[row][v] += s * value;
    }
  }
  return z;
};
const projections = [], orders = ['baseline', 'tile-32', 'tile-64', 'tile-128'];
let expectedProjection;
for (let repeat = 0; repeat < 3; repeat++) {
  for (const name of repeat % 2 ? orders.slice().reverse() : orders) {
    global.gc?.();
    const start = performance.now();
    const value = name === 'baseline' ? baselineProjection() : projectCases(data, moments, identified, undefined, Number(name.slice(5)));
    const elapsedMs = performance.now() - start, digest = digestRows(value);
    expectedProjection ??= digest;
    projections.push({ name, repeat, elapsedMs, exactMatch: digest === expectedProjection, sha256: digest });
  }
}
const normalization = [], q = 768, cases = 128;
const lower = new Matrix(Array.from({ length: q }, (_, i) => Array.from({ length: q }, (_, j) => j === i ? 3 : j < i ? (random() - 0.5) / Math.sqrt(q) : 0)));
const raw = Array.from({ length: cases }, () => Float64Array.from({ length: q }, () => random() - 0.5));
const baselineNormalization = z => {
  const meat = Matrix.zeros(q, q), inverseLower = Matrix.zeros(q, q);
  for (const v of z) {
    for (let a = 0; a < q; a++) {
      let x = v[a];
      for (let b = 0; b < a; b++) x -= lower.get(a, b) * v[b];
      v[a] = x / lower.get(a, a);
    }
    for (let a = 0; a < q; a++) v[a] /= Math.sqrt(cases);
    for (let a = 0; a < q; a++) for (let b = 0; b <= a; b++) meat.set(a, b, meat.get(a, b) + v[a] * v[b]);
  }
  for (let a = 0; a < q; a++) for (let b = 0; b < a; b++) meat.set(b, a, meat.get(a, b));
  for (let c = 0; c < q; c++) for (let a = 0; a < q; a++) {
    let x = a === c ? 1 : 0;
    for (let b = 0; b < a; b++) x -= lower.get(a, b) * inverseLower.get(b, c);
    inverseLower.set(a, c, x / lower.get(a, a));
  }
  return { meat, inverseLower };
};
let expectedNormalization;
for (let repeat = 0; repeat < 3; repeat++) {
  for (const name of repeat % 2 ? ['typed-triangular', 'baseline'] : ['baseline', 'typed-triangular']) {
    const z = raw.map(row => row.slice()); global.gc?.();
    const start = performance.now(), result = name === 'baseline' ? baselineNormalization(z) : normalizeCaseProjections(z, lower), elapsedMs = performance.now() - start;
    const digests = [digestRows(z), ...[result.meat, result.inverseLower].map(matrix => digestRows(matrix.to2DArray().map(row => Float64Array.from(row))))];
    expectedNormalization ??= digests;
    normalization.push({ name, repeat, elapsedMs, exactMatch: JSON.stringify(digests) === JSON.stringify(expectedNormalization), digests });
  }
}
const propagation = [], parameters = 2490, outputs = 64;
const covariance = new Matrix(Array.from({ length: parameters }, (_, a) => Array.from({ length: parameters }, (_, b) => a === b ? 2 : 0.01 * Math.cos(a + b) / parameters)));
const derivatives = Array.from({ length: outputs }, (_, o) => Float64Array.from({ length: parameters }, (_, a) => o % 8 === 0 && a > 4 ? 0 : random() - 0.5));
const baselinePropagation = () => Float64Array.from(derivatives, row => {
  let variance = 0;
  for (let a = 0; a < parameters; a++) {
    let value = 0;
    for (let b = 0; b < parameters; b++) value += covariance.get(a, b) * row[b];
    variance += row[a] * value;
  }
  return variance;
});
let expectedPropagation;
for (let repeat = 0; repeat < 3; repeat++) {
  for (const name of repeat % 2 ? ['packed-batched', 'baseline'] : ['baseline', 'packed-batched']) {
    global.gc?.();
    const start = performance.now(), result = name === 'baseline' ? baselinePropagation() : covarianceQuadraticForms(covariance, derivatives), elapsedMs = performance.now() - start;
    expectedPropagation ??= result;
    propagation.push({ name, repeat, elapsedMs, maxAbsoluteError: maxError(expectedPropagation, result) });
  }
}
const summaries = records => [...new Set(records.map(value => value.name))].map(name => ({ name, medianMs: median(records.filter(value => value.name === name).map(value => value.elapsedMs)) }));
const report = {
  recordedAt: new Date().toISOString(), status: projections.every(v => v.exactMatch) && normalization.every(v => v.exactMatch) && propagation.every(v => v.maxAbsoluteError < 1e-10) ? 'passed' : 'numerical-failures',
  scope: 'Targeted synthetic CPU substages only; not a full fit. Three alternating-order repetitions include allocation. No full-size JavaScript baseline is run.',
  sourceSha256: hash(await readFile(bundle)), scriptSha256: hash(await readFile(new URL(import.meta.url))),
  seed: 140591, hardware: { cpu: os.cpus()[0].model, architecture: os.arch(), memoryBytes: os.totalmem() }, node: process.version,
  projection: { dimensions: { rows: n, items: p, factors: k, parameters: identified.free.length }, codeSha256: hash(new Uint8Array(codes.buffer)), expectedProjection, results: projections, summary: summaries(projections) },
  normalization: { dimensions: { rows: cases, parameters: q }, expectedNormalization, results: normalization, summary: summaries(normalization) },
  propagation: { dimensions: { outputs, parameters }, results: propagation, summary: summaries(propagation) },
};
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: report.status, projection: report.projection.summary, normalization: report.normalization.summary, propagation: report.propagation.summary }));
if (report.status !== 'passed') process.exitCode = 1;
