import { writeFileSync } from 'node:fs';
import { benchmarkData } from '../benchmark-data';
import { prepareEfa } from '../../../src/lib/efa/prepare';
import { correlate } from '../../../src/lib/efa/correlation';
import { fitEfa } from '../../../src/lib/efa/fit';
import { weightedMoments } from '../../../src/lib/efa/weighted-moments';
import { extractDwls } from '../../../src/lib/efa/dwls';
import { rotate } from '../../../src/lib/efa/rotation';
import { runPCA } from '../../../src/lib/pca';
import { mulberry32 } from '../../../src/lib/random';
import type { Progress } from '../../../src/lib/efa/types';

const method = process.env.BENCHMARK_METHOD!;
const output = process.env.BENCHMARK_OUTPUT!;
const timings: Record<string, number> = {};
let lastSaved = 0;
const report: Record<string, unknown> = { recordedAt: new Date().toISOString(), status: 'running', method, runtime: process.version, dimensions: { respondents: 20000, items: 500, factors: 5 }, dataSeed: 8801, timingsMs: timings, qualification: 'Single isolated Node CPU run; runtime and execution qualification only. Not browser responsiveness, R speed comparison, or full-size cross-implementation accuracy proof.' };
function save() { report.peakRssKiB = process.resourceUsage().maxRSS; writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); }
function timed<T>(stage: string, f: () => T): T { report.stage = stage; save(); const start = performance.now(); const value = f(); timings[stage] = performance.now() - start; console.log(`${method}: ${stage} ${timings[stage].toFixed(1)} ms`); save(); return value; }
const progress: Progress = value => { if (performance.now() - lastSaved > 1000) { report.progress = value; lastSaved = performance.now(); save(); } };
try {
  const { table, spec } = timed('generation', () => benchmarkData());
  if (method === 'fiml-block' || method === 'fiml-fragmented') {
    let count = 0;
    const random = mulberry32(73291);
    table.columns.forEach((column, j) => { for (let i = 0; i < table.nRows; i++) if (method === 'fiml-block' ? (i % 3 === 1 && j < 50) || (i % 3 === 2 && j >= 450) : random() < .05) { table.data[column][i] = null; count++; } });
    report.missingCells = count; report.missingness = method === 'fiml-block' ? '3 fixed patterns: complete, first50 missing, last50 missing; i mod3' : 'independent MCAR .05, mulberry32 seed73291';
  }
  if (method === 'pca') {
    const result = timed('PCA complete standardized', () => runPCA(table, table.columns, { k: 5, standardize: true, missing: 'complete' }));
    report.result = { rowsUsed: result.missing.rowsUsed, components: result.k, eigenvalues: result.eigenvalues.slice(0, 8), firstFiveVarianceFraction: result.varianceExplained.reduce((sum, x) => sum + x, 0) };
  } else {
    const ml = method === 'ml' || method.startsWith('fiml');
    spec.extraction = ml ? 'ml' : method === 'weighted' ? 'wlsmv' : 'minres';
    spec.correlation = ml ? 'pearson' : 'polychoric';
    spec.missing = method.startsWith('fiml') ? 'fiml' : 'complete';
    spec.rotation = 'promax';
    report.settings = { extraction: spec.extraction, correlation: spec.correlation, missing: spec.missing, rotation: spec.rotation, seed: spec.seed, likelihood: ml ? { starts: 3, maxIterations: 2000, tolerance: 1e-7, uniquenessFloor: 1e-6 } : null };
    const data = timed('preparation', () => prepareEfa(table, spec, Array.from({ length: table.nRows }, (_, i) => i))), correlation = timed('correlation', () => correlate(data, progress));
    report.inputSha256 = data.fingerprint;
    if (method === 'weighted') {
      const moments = timed('pair influence preparation', () => weightedMoments(data, correlation, progress)), extraction = timed('DWLS point extraction', () => extractDwls(correlation.matrix, moments, 5, progress));
      report.convergence = extraction.convergence;
      report.rotations = Object.fromEntries((['promax', 'oblimin', 'varimax'] as const).map(rotation => [rotation, timed(`${rotation} rotation`, () => rotate(extraction.loadings, rotation, spec.seed, 4, true).convergence)]));
      report.excluded = 'Full WLSMV robust correction and rotated SEs are excluded from this 500-item point-fit timing.';
      if (!extraction.convergence.converged) throw new Error('DWLS point extraction did not converge');
    } else {
      const fit = timed(`${ml ? 'ML' : 'MINRES'} extraction and Promax`, () => fitEfa(data, correlation, spec, progress));
      report.convergence = fit.extraction.convergence;
      report.rotations = { promax: fit.rotation.convergence, ...Object.fromEntries((['oblimin', 'varimax'] as const).map(rotation => [rotation, timed(`${rotation} rotation`, () => rotate(fit.extraction.loadings, rotation, spec.seed, 4, ml).convergence)])) };
      if (fit.likelihood) report.likelihood = { logLikelihood: fit.likelihood.logLikelihood, nRows: fit.likelihood.nRows, patternCount: fit.likelihood.patternCount, selectedStart: fit.likelihood.selectedStart, starts: fit.likelihood.starts, settings: fit.likelihood.settings };
      if (!fit.extraction.convergence.converged || !fit.rotation.convergence.converged) throw new Error('Fit or rotation did not converge');
    }
  }
  report.status = 'passed';
} catch (error) { report.status = 'error'; report.error = String(error); process.exitCode = 1; }
save();
