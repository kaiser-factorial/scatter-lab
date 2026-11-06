import { dbscan as runDbscan, kmeans as runKmeans } from './internal/cluster';

function columnData(rows: readonly (readonly number[])[]): number[][] {
  if (!Array.isArray(rows) || !rows.length || !Array.isArray(rows[0]) || !rows[0].length ||
      Array.from(rows).some(row => !Array.isArray(row) || row.length !== rows[0].length || Array.from(row).some(value => typeof value !== 'number' || !Number.isFinite(value))))
    throw new TypeError('Clustering requires a nonempty rectangular matrix of finite numeric rows. Apply missing-data handling and scaling explicitly.');
  return Array.from({ length: rows[0].length }, (_, column) => rows.map(row => row[column]));
}
const labelIndex = (label: string) => label === 'Noise' ? -1 : Number(label.slice('Cluster '.length));
const rangeError = () => new RangeError('Clustering exceeds the supported numeric range for squared Euclidean distances or coordinate sums. Rescale the observations and radius explicitly.');

function kmeansRange(columns: number[][]): void {
  const n = columns[0].length;
  let squaredSpan = 0;
  for (const column of columns) {
    let minimum = Infinity, maximum = -Infinity, maximumAbsolute = 0;
    for (const value of column) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); maximumAbsolute = Math.max(maximumAbsolute, Math.abs(value)); }
    const span = maximum - minimum, square = span * span;
    if (!Number.isFinite(maximumAbsolute * n) || !Number.isFinite(square) || span !== 0 && square === 0) throw rangeError();
    squaredSpan += square;
  }
  if (!Number.isFinite(squaredSpan * n)) throw rangeError();
}

/** Deterministic existing Lloyd implementation: ten k-means++ starts, seeds
 * 42..51 and at most 300 updates per start. No implicit scaling or imputation. */
export function kmeans(rows: readonly (readonly number[])[], options: { k: number }) {
  const columns = columnData(rows);
  if (!options || !Number.isSafeInteger(options.k) || options.k < 1 || options.k > rows.length ||
      new Set(rows.map(row => JSON.stringify(row))).size < options.k)
    throw new RangeError('k must be a positive integer no larger than the number of distinct observations.');
  kmeansRange(columns);
  const labels = runKmeans(columns, options.k).map(labelIndex);
  if (labels.length !== rows.length || labels.some(label => !Number.isSafeInteger(label) || label < 0 || label >= options.k)) throw rangeError();
  const counts = Array(options.k).fill(0) as number[];
  const centers = Array.from({ length: options.k }, () => Array(columns.length).fill(0) as number[]);
  rows.forEach((row, i) => { counts[labels[i]]++; row.forEach((value, j) => centers[labels[i]][j] += value); });
  centers.forEach((center, i) => { if (!counts[i]) throw new Error('K-means returned an empty cluster.'); center.forEach((value, j) => center[j] = value / counts[i]); });
  let withinSumSquares = 0;
  rows.forEach((row, i) => row.forEach((value, j) => { withinSumSquares += (value - centers[labels[i]][j]) ** 2; }));
  if (centers.some(center => center.some(value => !Number.isFinite(value))) || !Number.isFinite(withinSumSquares)) throw rangeError();
  return { labels, centers, counts, withinSumSquares, settings: { k: options.k, starts: 10, seeds: Array.from({ length: 10 }, (_, i) => 42 + i), maxIterations: 300 },
    convergence: 'not-reported' as const };
}

/** Euclidean DBSCAN; minSamples includes the observation itself, noise=-1.
 * Border assignment follows input order. Inputs are already prepared numeric rows. */
export function dbscan(rows: readonly (readonly number[])[], options: { eps: number; minSamples: number }) {
  const columns = columnData(rows);
  if (!options || !Number.isFinite(options.eps) || options.eps <= 0 || !Number.isSafeInteger(options.minSamples) || options.minSamples < 1)
    throw new RangeError('DBSCAN needs a positive finite radius and a positive integer minimum sample count.');
  if (!Number.isFinite(options.eps * options.eps) || options.eps * options.eps === 0) throw rangeError();
  const labels = runDbscan(columns, options.eps, options.minSamples).map(labelIndex);
  if (labels.length !== rows.length || labels.some(label => !Number.isSafeInteger(label) || label < -1 || label >= rows.length)) throw rangeError();
  return { labels, clusters: new Set(labels.filter(label => label >= 0)).size, noise: labels.filter(label => label === -1).length,
    settings: { eps: options.eps, minSamples: options.minSamples, distance: 'euclidean' as const, includesSelf: true } };
}
