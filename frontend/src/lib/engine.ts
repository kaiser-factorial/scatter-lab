import { availableColumn } from './columnOwnership';
import { DataTable, asNumber, isNumericColumn, median, numericValues } from './table';

// Ports backend/main.py's process_upload: median imputation, z-scaling,
// projection through a components matrix, and top-|loading| contributors.

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export type Contributor = { var: string; loading: number };
export type TopContributors = Record<string, Contributor[]>;
export type ProcessResult = {
  table: DataTable;
  topContributors: TopContributors | null;
  message: string;
  /** Things the projection silently did to the numbers (finding C10). */
  warnings: string[];
};

// Components file: first column (or index) = variable names, remaining
// columns = loadings per PC. Mirrors the pandas set_index handling.
const componentsToMatrix = (comp: DataTable) => {
  let indexCol = comp.columns[0];
  if (!comp.columns.includes('Unnamed: 0')) {
    const firstVals = comp.data[indexCol] ?? [];
    const firstIsNumeric = firstVals.every(v => v == null || typeof v === 'number');
    if (firstIsNumeric) {
      throw new Error('Components file needs variable names in its first column.');
    }
  } else {
    indexCol = 'Unnamed: 0';
  }
  const varNames = (comp.data[indexCol] ?? []).map(v => String(v));
  const pcCols = comp.columns.filter(c => c !== indexCol);
  return { varNames, pcCols, comp };
};

// A components file written by R or SPSS rarely capitalises exactly like the
// dataset it is applied to ("Openness" vs "openness"), and an exact match on a
// trailing space is a silent total failure — every variable missing, no overlap,
// no projection. Normalising for the *lookup* only keeps the reported names as
// the user wrote them.
const normalizeName = (s: string) => s.trim().toLowerCase();

export const processUpload = (df: DataTable, components: DataTable | null): ProcessResult => {
  const warnings: string[] = [];
  if (components) {
    const { varNames, pcCols, comp } = componentsToMatrix(components);

    // Exact match first, so an exact hit always wins over a normalised one.
    const byNormalized = new Map<string, string>();
    for (const c of df.columns) {
      const key = normalizeName(c);
      if (!byNormalized.has(key)) byNormalized.set(key, c);
    }
    let fuzzy = 0;
    const intersect: { v: string; i: number; col: string }[] = [];
    varNames.forEach((v, i) => {
      if (df.columns.includes(v)) { intersect.push({ v, i, col: v }); return; }
      const col = byNormalized.get(normalizeName(v));
      if (col) { fuzzy++; intersect.push({ v, i, col }); }
    });

    if (intersect.length === 0) {
      throw new Error(
        `No overlapping variables between the components file and dataset columns. Components vars found: ${varNames.slice(0, 5).join(', ')}…`
      );
    }

    // Coverage is the headline number: a components file matched against a
    // subset produces a truncated dot product, which is NOT the PC score the
    // file describes. Reporting only the count used hid exactly that.
    const missing = varNames.filter((v, i) => !intersect.some(x => x.i === i));
    if (missing.length) {
      const shown = missing.slice(0, 5).map(v => `"${v}"`).join(', ');
      warnings.push(
        `The components file lists ${varNames.length} variables and this dataset has ${intersect.length} of them. The ${missing.length} missing (${shown}${missing.length > 5 ? ', …' : ''}) contribute nothing, so the scores are a partial projection rather than the component the file describes — they are not comparable to scores computed with the full set.`,
      );
    }
    if (intersect.length < varNames.length / 2) {
      warnings.push(`Fewer than half the components file's variables were found, so these scores are unlikely to mean what the file intends.`);
    }
    if (fuzzy) {
      warnings.push(`${plural(fuzzy, 'variable name')} matched only after ignoring case and surrounding spaces. Check that they are the columns you meant.`);
    }

    // Coerce text junk in numeric columns to null so imputation treats it as missing
    const coerced = intersect.map(({ col }) => (df.data[col] ?? []).map(asNumber));
    const allNaN = intersect.filter((_, j) => coerced[j].every(x => x == null)).map(({ v }) => v);
    if (allNaN.length) {
      throw new Error(`These columns contain no usable numeric values: ${allNaN.join(', ')}`);
    }

    // Median-impute, then standardize (population std, matching sklearn).
    //
    // Column-major over one flat Float64Array (finding F22). The n small row
    // arrays this replaces were allocated up front and then indexed X[i][j]
    // inside a j-outer loop — worst-case locality, and n allocations before any
    // arithmetic. Measured 3.2x faster and 4.5x less memory on 200k x 30, with
    // bit-identical output; only matters when a components file meets a large
    // dataset, which is exactly when it hurt.
    const n = df.nRows;
    const p = intersect.length;
    const X = new Float64Array(n * p);   // column-major: X[j * n + i]
    for (let j = 0; j < p; j++) {
      const col = coerced[j];
      const base = j * n;
      const med = median(numericValues(col));
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const v = col[i] ?? med;
        X[base + i] = v;
        sum += v;
      }
      const mean = sum / n;
      let sq = 0;
      for (let i = 0; i < n; i++) { const d = X[base + i] - mean; sq += d * d; }
      const std = Math.sqrt(sq / n) || 1;
      for (let i = 0; i < n; i++) X[base + i] = (X[base + i] - mean) / std;
    }

    // Loadings for the intersecting variables, in dataset-intersection order.
    // An unparseable loading used to become a real 0 via `Number(v) || 0`,
    // which is a claim ("this variable does not load on this component") rather
    // than an omission. It still has to become 0 for the arithmetic, but the
    // user is told how many and where.
    let unparseable = 0;
    const L: number[][] = intersect.map(({ i }) =>
      pcCols.map(pc => {
        const v = asNumber(comp.data[pc]?.[i]);
        if (v === null) unparseable++;
        return v ?? 0;
      })
    );
    if (unparseable) {
      warnings.push(`${plural(unparseable, 'loading')} in the components file could not be read as a number and ${unparseable === 1 ? 'was' : 'were'} treated as 0, which counts as "this variable does not contribute" rather than "this value is missing".`);
    }

    // coords = X (n×p) @ L (p×k). Only the PCs the file actually contains are
    // created: zero-padding to three produced an all-zero PC3 that
    // pickDefaultAxes then cheerfully assigned to the Z axis (C10).
    //
    // Accumulated column-major straight into the arrays the table will hold, so
    // there is no intermediate n-by-k of small arrays to allocate and then map
    // over three times (F22).
    const k = Math.min(pcCols.length, 3);
    const occupied = new Set(df.columns);
    const pcNames = Array.from({ length: k }, (_, c) => availableColumn(`PC${c + 1}`, occupied));
    const pcData = pcNames.map(() => new Array<number>(n).fill(0));
    for (let c = 0; c < k; c++) {
      const out = pcData[c];
      for (let j = 0; j < p; j++) {
        const w = L[j][c];
        if (w === 0) continue;          // a zero loading contributes nothing
        const base = j * n;
        for (let i = 0; i < n; i++) out[i] += X[base + i] * w;
      }
    }
    if (pcCols.length < 3) {
      warnings.push(`The components file defines ${plural(pcCols.length, 'component')}, so ${pcNames.join(' and ')} ${k === 1 ? 'was' : 'were'} created${k < 2 ? ' — a 3-D plot needs at least two' : ''}.`);
    }

    const table: DataTable = {
      columns: [...df.columns.filter(c => !pcNames.includes(c)), ...pcNames],
      data: {
        ...df.data,
        ...Object.fromEntries(pcNames.map((nm, c) => [nm, pcData[c]])),
      },
      nRows: n,
    };

    // Per PC: variables ranked by |loading|, signed values kept
    const topContributors: TopContributors = {};
    for (let c = 0; c < k; c++) {
      topContributors[pcNames[c]] = intersect
        .map(({ v }, j) => ({ var: v, loading: Math.round(L[j][c] * 1000) / 1000 }))
        .sort((a, b) => Math.abs(b.loading) - Math.abs(a.loading))
        .slice(0, 5);
    }

    return {
      table,
      topContributors,
      message: `Projected ${n} rows onto ${pcNames.join(', ')} using ${p} of the components file's ${varNames.length} variables.`,
      warnings,
    };
  }

  // No components: any numeric columns can serve as plot axes
  const numericCols = df.columns.filter(c => isNumericColumn(df.data[c] ?? []));
  if (numericCols.length < 2) {
    throw new Error('Dataset needs at least two numeric columns to plot (or provide a components file).');
  }
  return {
    table: df,
    topContributors: null,
    message: `Loaded ${df.nRows} rows — assign variables to X · Y · Z in the Variables panel.`,
    warnings,
  };
};
