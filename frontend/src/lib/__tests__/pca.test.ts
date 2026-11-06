import { describe, it, expect } from 'vitest';
import { runPCA, deriveRunLabel } from '../pca';
import type { DataTable } from '../table';

// deterministic LCG so results are stable across runs
const makeRng = (seed: number) => {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296 - 0.5;
  };
};

describe('runPCA — analytic two-variable case', () => {
  // For a 2×2 correlation matrix with correlation r, the eigenvalues are
  // 1±r and the first eigenvector is [1,1]/√2 — a closed-form check.
  const n = 4000;
  const rng = makeRng(42);
  const a: number[] = [], b: number[] = [];
  for (let i = 0; i < n; i++) {
    const shared = rng(), ua = rng(), ub = rng();
    a.push(shared + 0.6 * ua);
    b.push(shared + 0.6 * ub);
  }
  const table: DataTable = { columns: ['a', 'b'], data: { a, b }, nRows: n };
  const res = runPCA(table, ['a', 'b'], { k: 2 });

  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  const ma = mean(a), mb = mean(b);
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
  }
  const r = cov / Math.sqrt(va * vb);

  it('recovers the analytic eigenvalues (1±r)/2', () => {
    expect(res.varianceExplained[0]).toBeCloseTo((1 + r) / 2, 9);
    expect(res.varianceExplained[1]).toBeCloseTo((1 - r) / 2, 9);
  });

  it('recovers the analytic loadings ±1/√2', () => {
    const l1 = res.loadings.PC1.map(x => Math.abs(x.loading));
    expect(l1[0]).toBeCloseTo(Math.SQRT1_2, 3);
    expect(l1[1]).toBeCloseTo(Math.SQRT1_2, 3);
  });

  it('variance explained is a complete decomposition', () => {
    expect(res.cumulative[res.cumulative.length - 1]).toBeCloseTo(1, 9);
  });
});

describe('runPCA — structural properties on 5 variables', () => {
  const rng = makeRng(7);
  const names = ['v1', 'v2', 'v3', 'v4', 'v5'];
  const cols: Record<string, number[]> = Object.fromEntries(names.map(n => [n, []]));
  for (let i = 0; i < 800; i++) {
    const f1 = rng(), f2 = rng();
    cols.v1.push(f1 + 0.3 * rng());
    cols.v2.push(f1 + 0.3 * rng());
    cols.v3.push(f2 + 0.3 * rng());
    cols.v4.push(f2 + 0.3 * rng());
    cols.v5.push(rng());
  }
  const table: DataTable = { columns: names, data: cols, nRows: 800 };
  const res = runPCA(table, names, { k: 5 });

  const vec = (pc: string) => names.map(nm => res.loadings[pc].find(x => x.var === nm)!.loading);
  const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i], 0);

  it('components are orthonormal', () => {
    expect(dot(vec('PC1'), vec('PC1'))).toBeCloseTo(1, 1);
    expect(dot(vec('PC1'), vec('PC2'))).toBeCloseTo(0, 1);
  });

  it('eigenvalues come out in descending order', () => {
    res.varianceExplained.forEach((v, i, arr) => {
      if (i > 0) expect(v).toBeLessThanOrEqual(arr[i - 1] + 1e-12);
    });
  });

  it('score variance equals the eigenvalue (standardized: eigenvalue = share × p)', () => {
    const s1 = res.table.data.PC1 as number[];
    const ms = s1.reduce((s, x) => s + x, 0) / s1.length;
    const varS = s1.reduce((s, x) => s + (x - ms) ** 2, 0) / s1.length;
    expect(varS).toBeCloseTo(res.varianceExplained[0] * 5, 6);
  });

  it('appends the PC score columns to the table', () => {
    for (const c of ['PC1', 'PC2', 'PC3', 'PC4', 'PC5']) {
      expect(res.table.columns).toContain(c);
    }
  });
});

describe('runPCA — robustness', () => {
  it('median-imputes missing values instead of failing', () => {
    const table: DataTable = {
      columns: ['x', 'y'],
      data: { x: [1, 2, null, 4, 5, 6], y: [2, 4, 6, null, 10, 12] },
      nRows: 6,
    };
    const res = runPCA(table, ['x', 'y'], { k: 2 });
    expect(Number.isFinite((res.table.data.PC1 as number[])[2])).toBe(true);
  });

  it('rejects a constant variable under standardization with a clear error', () => {
    const table: DataTable = {
      columns: ['x', 'y'],
      data: { x: [1, 2, 3, 4], y: [5, 5, 5, 5] },
      nRows: 4,
    };
    expect(() => runPCA(table, ['x', 'y'], { k: 2 })).toThrow(/constant/);
  });
});

describe('deriveRunLabel', () => {
  it('finds a shared prefix once counters are stripped', () => {
    expect(deriveRunLabel(['openness_1', 'openness_2', 'openness_3'])).toBe('openness');
  });

  it('finds a shared suffix (Q1_Need style)', () => {
    expect(deriveRunLabel(['Q1_Need', 'Q2_Need', 'Q5_Need'])).toBe('Need');
  });

  it('returns null for mixed subsets and too-short affixes', () => {
    expect(deriveRunLabel(['O1', 'O2', 'N1', 'N2'])).toBeNull();  // nothing shared
    expect(deriveRunLabel(['O1', 'O2', 'O3'])).toBeNull();        // "O" too short
  });
});

describe('runPCA — labeled runs and composites', () => {
  const rng = makeRng(7);
  const n = 200;
  const cols: Record<string, number[]> = {};
  for (const name of ['o1', 'o2', 'o3', 'n1', 'n2', 'n3']) {
    cols[name] = Array.from({ length: n }, () => rng());
  }
  const base: DataTable = { columns: Object.keys(cols), data: cols, nRows: n };

  it('k=1 with a label yields a single COMP_ column', () => {
    const res = runPCA(base, ['o1', 'o2', 'o3'], { k: 1, label: 'openness' });
    expect(res.columns).toEqual(['COMP_openness']);
    expect(res.table.columns).toContain('COMP_openness');
    expect(res.varianceExplained).toHaveLength(1);
  });

  it('labeled runs coexist; re-running a label replaces only its own columns', () => {
    const t1 = runPCA(base, ['o1', 'o2', 'o3'], { k: 1, label: 'openness' }).table;
    const t2 = runPCA(t1, ['n1', 'n2', 'n3'], { k: 1, label: 'neuroticism' }).table;
    expect(t2.columns).toContain('COMP_openness');
    expect(t2.columns).toContain('COMP_neuroticism');

    // re-run openness with k=2 → COMP_openness is replaced by PC1/2_openness
    const res3 = runPCA(t2, ['o1', 'o2', 'o3'], { k: 2, label: 'openness' });
    expect(res3.replaced).toEqual(['COMP_openness']);
    expect(res3.table.columns).toContain('PC1_openness');
    expect(res3.table.columns).not.toContain('COMP_openness');
    expect(res3.table.columns).toContain('COMP_neuroticism'); // untouched
  });

  it('a bare run replaces only bare PC columns, not labeled ones', () => {
    const t1 = runPCA(base, ['o1', 'o2', 'o3'], { k: 2, label: 'openness' }).table;
    const t2 = runPCA(t1, Object.keys(cols), { k: 2 }).table;
    expect(t2.columns).toEqual(expect.arrayContaining(['PC1', 'PC2', 'PC1_openness', 'PC2_openness']));
    const t3 = runPCA(t2, Object.keys(cols), { k: 2 }).table;
    expect(t3.columns.filter(c => c === 'PC1')).toHaveLength(1); // replaced, not duplicated
  });

  it('sanitizes labels used in column names', () => {
    const res = runPCA(base, ['o1', 'o2'], { k: 1, label: '  sensation seeking! ' });
    expect(res.columns).toEqual(['COMP_sensation_seeking']);
  });
});

describe('runPCA — imputation accounting (finding A9)', () => {
  const table: DataTable = {
    columns: ['a', 'b', 'c'],
    data: {
      a: [1, 2, null, 4, 5, 6],          // 1 missing
      b: [2, 4, 6, null, 10, null],      // 2 missing
      c: [1, 2, 3, 4, 5, 6],             // complete
    },
    nRows: 6,
  };

  it('counts imputed cells against the full variable x row grid', () => {
    const res = runPCA(table, ['a', 'b', 'c'], { k: 2 });
    expect(res.missing.imputedCells).toBe(3);
    expect(res.missing.totalCells).toBe(18); // 3 variables x 6 rows
  });

  it('names the affected variables worst-first and omits complete ones', () => {
    const res = runPCA(table, ['a', 'b', 'c'], { k: 2 });
    expect(res.missing.byVariable).toEqual([{ var: 'b', n: 2 }, { var: 'a', n: 1 }]);
  });

  it('reports nothing when the selected variables are complete', () => {
    const res = runPCA(table, ['c', 'a'], { k: 2 });
    expect(res.missing.byVariable.map(m => m.var)).toEqual(['a']);
    const clean: DataTable = {
      columns: ['p', 'q'], data: { p: [1, 2, 3, 4], q: [2, 1, 4, 3] }, nRows: 4,
    };
    expect(runPCA(clean, ['p', 'q'], { k: 2 }).missing.imputedCells).toBe(0);
  });

  it('counts rows past the end of a short column as imputed', () => {
    const short: DataTable = {
      columns: ['x', 'y'],
      data: { x: [1, 2, 3, 4], y: [1, 3] }, // y stops early
      nRows: 4,
    };
    expect(runPCA(short, ['x', 'y'], { k: 2 }).missing).toMatchObject({
      imputedCells: 2,
      byVariable: [{ var: 'y', n: 2 }],
    });
  });
});

describe('runPCA — complete-case analysis', () => {
  // Rows 2 and 4 each have a gap; complete-case should use the other four.
  const table: DataTable = {
    columns: ['a', 'b'],
    data: {
      a: [1, 2, null, 4, 5, 6],
      b: [2, 4, 6, 8, null, 12],
    },
    nRows: 6,
  };

  it('drops incomplete rows and reports how many', () => {
    const res = runPCA(table, ['a', 'b'], { k: 2, missing: 'complete' });
    expect(res.missing.strategy).toBe('complete');
    expect(res.missing.rowsUsed).toBe(4);
    expect(res.missing.rowsDropped).toBe(2);
    expect(res.missing.imputedCells).toBe(0);
  });

  it('leaves dropped rows unscored rather than fabricating a score', () => {
    const res = runPCA(table, ['a', 'b'], { k: 2, missing: 'complete' });
    const pc1 = res.table.data.PC1 as (number | null)[];
    expect(pc1).toHaveLength(6);          // table shape preserved
    expect(pc1[2]).toBeNull();            // gap in a
    expect(pc1[4]).toBeNull();            // gap in b
    expect(pc1.filter(v => typeof v === 'number')).toHaveLength(4);
  });

  it('median imputation still scores every row', () => {
    const res = runPCA(table, ['a', 'b'], { k: 2, missing: 'median' });
    expect(res.missing.rowsUsed).toBe(6);
    expect(res.missing.rowsDropped).toBe(0);
    expect((res.table.data.PC1 as (number | null)[]).every(v => typeof v === 'number')).toBe(true);
  });

  it('the two strategies genuinely disagree when data are missing', () => {
    const a = runPCA(table, ['a', 'b'], { k: 2, missing: 'median' });
    const b = runPCA(table, ['a', 'b'], { k: 2, missing: 'complete' });
    expect(a.varianceExplained[0]).not.toBeCloseTo(b.varianceExplained[0], 6);
  });

  it('is identical to median imputation when nothing is missing', () => {
    const clean: DataTable = {
      columns: ['p', 'q'], data: { p: [1, 2, 3, 4, 5], q: [2, 1, 4, 3, 6] }, nRows: 5,
    };
    const a = runPCA(clean, ['p', 'q'], { k: 2, missing: 'median' });
    const b = runPCA(clean, ['p', 'q'], { k: 2, missing: 'complete' });
    expect(b.varianceExplained[0]).toBeCloseTo(a.varianceExplained[0], 12);
    expect(b.missing.rowsDropped).toBe(0);
  });

  it('refuses when too few complete cases remain, naming the way out', () => {
    const sparse: DataTable = {
      columns: ['a', 'b'],
      data: { a: [1, null, null, 4], b: [null, 2, 3, null] },
      nRows: 4,
    };
    expect(() => runPCA(sparse, ['a', 'b'], { k: 2, missing: 'complete' }))
      .toThrow(/Complete-case analysis leaves only 0 rows/);
  });
});

describe('runPCA — column mean and median fills', () => {
  it.each([
    ['mean', 3, 16 / 3],
    ['median', 1, 4],
  ] as const)('matches an explicitly %s-filled dataset without changing observed input', (missing, fillX, fillY) => {
    const incomplete: DataTable = {
      columns: ['x', 'y'],
      // Trailing cells are outside the four-row fitting dataset and must not
      // contribute to column statistics or missing-cell accounting.
      data: { x: [0, '1', 8, null, 10000], y: [2, null, 4, 10, -10000] },
      nRows: 4,
    };
    const before = structuredClone(incomplete);
    const completed: DataTable = {
      columns: ['x', 'y'],
      data: { x: [0, 1, 8, fillX], y: [2, fillY, 4, 10] },
      nRows: 4,
    };
    const actual = runPCA(incomplete, ['x', 'y'], { missing, k: 2, standardize: false });
    const expected = runPCA(completed, ['x', 'y'], { missing: 'complete', k: 2, standardize: false });
    for (const column of actual.columns)
      actual.table.data[column].forEach((value, i) => expect(value).toBeCloseTo(expected.table.data[column][i], 12));
    actual.eigenvalues.forEach((value, i) => expect(value).toBeCloseTo(expected.eigenvalues[i], 12));
    expect(actual.missing).toMatchObject({ strategy: missing, imputedCells: 2, totalCells: 8, rowsUsed: 4, rowsDropped: 0 });
    expect(incomplete).toEqual(before);
    expect(actual.table.data.x).toEqual(before.data.x);
    expect(actual.table.data.y).toEqual(before.data.y);
  });

  it.each(['mean', 'median'] as const)('rejects an unobserved column under %s imputation', (missing) => {
    const empty: DataTable = {
      columns: ['x', 'y'], data: { x: [null, null, null], y: [1, 2, 3] }, nRows: 3,
    };
    expect(() => runPCA(empty, empty.columns, { missing })).toThrow('"x" has no numeric values.');
  });
});
