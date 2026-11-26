import type { DataTable } from '../table';
import type { EfaRun } from './types';

// Immutable input and output arrays give unchanged live tables a fast path.
// Restoring from disk or editing one of those arrays requires worker verification.
const verified = new WeakMap<EfaRun['result'], DataTable['data'][string][]>();
function scoreArrays(table: DataTable, run: EfaRun, columns: string[]) {
  return [...run.spec.items.map(item => item.column), ...columns].map(name => table.data[name]);
}
export function rememberScores(table: DataTable, run: EfaRun, columns: string[]) {
  verified.set(run.result, scoreArrays(table, run, columns));
}
export function scoresVerified(table: DataTable, run: EfaRun) {
  const saved = verified.get(run.result);
  const current = scoreArrays(table, run, run.scoreColumns);
  return !!saved && saved.length === current.length && current.every((column, i) => saved[i] === column);
}

export function scoreCaption(dataset: string, runs: EfaRun[], table: DataTable, axes: string[], mask: boolean[] | null) {
  const run = runs.find(candidate => axes.length >= 2 && axes.every((axis, index) => candidate.scoreColumns[index] === axis && table.data[axis]));
  if (!run || !scoresVerified(table, run)) return undefined;
  let scored = 0, total = 0;
  for (let row = 0; row < table.nRows; row++) {
    if (mask && !mask[row]) continue;
    total++;
    if (axes.every(axis => Number.isFinite(table.data[axis][row]))) scored++;
  }
  return `Estimated respondent scores · ${dataset} · ${run.spec.label} r${run.revision} · ${(run.spec.extraction ?? 'minres').toUpperCase()} / ${run.result.correlationMethod ?? run.result.provenance.correlation} / ${run.spec.rotation} · ${run.result.likelihood ? 'Gaussian conditional scores' : 'Regression score approximations'} · ${scored.toLocaleString()} scored / ${(total - scored).toLocaleString()} omitted${mask ? ' within filter' : ''}`;
}
