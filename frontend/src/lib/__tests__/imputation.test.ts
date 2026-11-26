import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { imputeIterativePCA, runPCA } from '../pca';
import type { DataTable } from '../table';

// These assert RECOVERY OF KNOWN VALUES, which is the only honest way to claim
// one imputation method is better than another: take complete data, punch holes
// in it, impute, and compare against the truth that was removed.

const IRIS = fileURLToPath(new URL('../../../public/demo/iris.csv', import.meta.url));
const MEAS = ['SepalLengthCm', 'SepalWidthCm', 'PetalLengthCm', 'PetalWidthCm'];

const iris = () => {
  const lines = readFileSync(IRIS, 'utf8').trim().split('\n');
  const head = lines[0].split(',');
  return MEAS.map(m => {
    const j = head.indexOf(m);
    return lines.slice(1).map(l => Number(l.split(',')[j]));
  });
};

const lcg = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;

/** Punch MCAR holes, returning the damaged copy and where the holes are. */
const punch = (truth: number[][], rate: number, seed: number) => {
  const r = lcg(seed);
  const holes: [number, number][] = [];
  const out: (number | null)[][] = truth.map(c => c.slice() as (number | null)[]);
  truth.forEach((col, j) => col.forEach((_, i) => {
    if (r() < rate) { out[j][i] = null; holes.push([j, i]); }
  }));
  return { punched: out, holes };
};

const medianFill = (cols: (number | null)[][]) => cols.map(c => {
  const v = (c.filter(x => x != null) as number[]).slice().sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
});

const mae = (holes: [number, number][], truth: number[][], get: (j: number, i: number) => number) =>
  holes.reduce((s, [j, i]) => s + Math.abs(get(j, i) - truth[j][i]), 0) / holes.length;

describe('imputeIterativePCA — recovery of known values', () => {
  const truth = iris();

  it('recovers punched-out iris values far better than the column median', () => {
    // Iris has genuine correlation structure, which is exactly the situation
    // a low-rank reconstruction can exploit and a per-column median cannot.
    for (const rate of [0.05, 0.2, 0.35]) {
      const { punched, holes } = punch(truth, rate, 20260805);
      const med = medianFill(punched);
      const res = imputeIterativePCA(punched, { rank: 2, standardize: true });
      const medMae = mae(holes, truth, j => med[j]);
      const pcaMae = mae(holes, truth, (j, i) => res.columns[j][i]);
      // Measured improvement is 52-58%; assert a conservative floor so the test
      // fails on a broken algorithm rather than on ordinary numeric drift.
      expect(pcaMae).toBeLessThan(medMae * 0.7);
      // Recovery accuracy and optimization convergence are separate claims.
      // The canonical observed-reconstruction stopping rule needs more than
      // the default 200 passes for the 20% and 35% masks at tolerance 1e-8.
      expect(res.converged).toBe(rate === 0.05);
      if (res.converged) expect(res.iterations).toBeLessThan(200);
      else expect(res.iterations).toBe(200);
    }
  });

  // Independently matched against missMDA 1.20 / FactoMineR 2.12 with
  // threshold=1e-8 and maxiter=1000; see the retained Iris boundary report in
  // scripts/efa-reference/congruence/iris-boundary-report.json.
  it.each([
    { seed: 20260805, iterations: [115, 298, 887] },
    { seed: 7, iterations: [99, 238, 574] },
    { seed: 42, iterations: [72, 371, 770] },
    { seed: 20260806, iterations: [74, 216, 524] },
  ])('reaches the stopping criterion with a larger budget for Iris masks from seed $seed', ({ seed, iterations }) => {
    [0.05, 0.2, 0.35].forEach((rate, at) => {
      const { punched, holes } = punch(truth, rate, seed);
      const med = medianFill(punched);
      const res = imputeIterativePCA(punched, { rank: 2, standardize: true, maxIter: 1000 });
      expect(res.converged).toBe(true);
      expect(res.iterations).toBe(iterations[at]);
      expect(res.iterations).toBeLessThan(1000);
      expect(mae(holes, truth, (j, i) => res.columns[j][i])).toBeLessThan(mae(holes, truth, j => med[j]) * 0.7);
    });
  });

  it('never alters an observed value', () => {
    const { punched } = punch(truth, 0.25, 7);
    const res = imputeIterativePCA(punched, { rank: 2, standardize: true });
    punched.forEach((col, j) => col.forEach((v, i) => {
      if (v != null) expect(res.columns[j][i]).toBeCloseTo(v, 12);
    }));
  });

  it('is a no-op on complete data', () => {
    const res = imputeIterativePCA(truth as (number | null)[][], { rank: 2 });
    expect(res.iterations).toBe(0);
    expect(res.converged).toBe(true);
    truth.forEach((col, j) => col.forEach((v, i) => expect(res.columns[j][i]).toBe(v)));
  });

  it('regularization keeps it from badly overfitting unstructured data', () => {
    // With independent noise there is no low-rank signal to recover, so it
    // cannot beat the median — but shrinkage must stop it running away.
    const r = lcg(4242);
    const gauss = () => { let s = 0; for (let i = 0; i < 12; i++) s += r(); return s - 6; };
    const noise = Array.from({ length: 4 }, () => Array.from({ length: 200 }, gauss));
    const { punched, holes } = punch(noise, 0.15, 99);
    const med = medianFill(punched);
    const res = imputeIterativePCA(punched, { rank: 2, standardize: true });
    const ratio = mae(holes, noise, (j, i) => res.columns[j][i]) / mae(holes, noise, j => med[j]);
    expect(ratio).toBeLessThan(1.25);  // measured ~1.05
  });

  it('clamps rank below the variable count so residual noise is estimable', () => {
    const { punched } = punch(iris(), 0.1, 3);
    expect(imputeIterativePCA(punched, { rank: 99 }).rank).toBe(3); // p - 1
    expect(imputeIterativePCA(punched, { rank: 0 }).rank).toBe(1);
  });
});

describe('runPCA — missing: iterative', () => {
  const table: DataTable = {
    columns: ['a', 'b', 'c'],
    data: {
      a: [1, 2, null, 4, 5, 6, 7, 8],
      b: [2, 4, 6, 8, null, 12, 14, 16],
      c: [1, 3, 5, 7, 9, 11, null, 15],
    },
    nRows: 8,
  };

  it('scores every row and reports the iteration count', () => {
    const res = runPCA(table, ['a', 'b', 'c'], { k: 2, missing: 'iterative' });
    expect(res.missing.strategy).toBe('iterative');
    expect(res.missing.rowsUsed).toBe(8);
    expect(res.missing.rowsDropped).toBe(0);
    expect(res.missing.imputedCells).toBe(3);
    expect(res.missing.converged).toBe(true);
    expect(res.missing.iterations).toBeGreaterThan(0);
    expect((res.table.data.PC1 as (number | null)[]).every(v => typeof v === 'number')).toBe(true);
  });

  it('gives a different answer than median imputation on the same data', () => {
    const a = runPCA(table, ['a', 'b', 'c'], { k: 2, missing: 'median' });
    const b = runPCA(table, ['a', 'b', 'c'], { k: 2, missing: 'iterative' });
    expect(a.varianceExplained[0]).not.toBeCloseTo(b.varianceExplained[0], 6);
  });

  it('matches median imputation when nothing is missing', () => {
    const clean: DataTable = {
      columns: ['p', 'q', 'r'],
      data: { p: [1, 2, 3, 4, 5], q: [2, 1, 4, 3, 6], r: [5, 3, 2, 4, 1] },
      nRows: 5,
    };
    const a = runPCA(clean, ['p', 'q', 'r'], { k: 2, missing: 'median' });
    const b = runPCA(clean, ['p', 'q', 'r'], { k: 2, missing: 'iterative' });
    expect(b.varianceExplained[0]).toBeCloseTo(a.varianceExplained[0], 12);
    expect(b.missing.iterations).toBe(0);
  });
});
