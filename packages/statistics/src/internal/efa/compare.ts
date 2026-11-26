import type { EfaRun } from "./types";

/** Maximum-weight one-to-one assignment; pads with dummy factors when k differs. */
export function matchFactors(reference: number[][], candidate: number[][]) {
  const ka = reference[0]?.length ?? 0,
    kb = candidate[0]?.length ?? 0,
    n = Math.max(ka, kb);
  const congruence = Array.from({ length: ka }, (_, a) =>
    Array.from({ length: kb }, (_, b) => {
      let xy = 0,
        xx = 0,
        yy = 0;
      for (let i = 0; i < reference.length; i++) {
        const x = reference[i][a],
          y = candidate[i][b];
        xy += x * y;
        xx += x * x;
        yy += y * y;
      }
      return xx * yy > 0 ? xy / Math.sqrt(xx * yy) : 0;
    }),
  );
  const u = Array(n + 1).fill(0),
    v = Array(n + 1).fill(0),
    p = Array(n + 1).fill(0),
    way = Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const min = Array(n + 1).fill(Infinity),
      used = Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity,
        j1 = 0;
      for (let j = 1; j <= n; j++)
        if (!used[j]) {
          const cost =
            1 - Math.abs(congruence[i0 - 1]?.[j - 1] ?? 0) - u[i0] - v[j];
          if (cost < min[j]) {
            min[j] = cost;
            way[j] = j0;
          }
          if (min[j] < delta) {
            delta = min[j];
            j1 = j;
          }
        }
      for (let j = 0; j <= n; j++)
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else min[j] -= delta;
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }
  const mapping = Array<number | null>(ka).fill(null);
  for (let j = 1; j <= n; j++)
    if (p[j] <= ka && j <= kb) mapping[p[j] - 1] = j - 1;
  const signs = mapping.map((b, a) =>
    b === null ? 1 : congruence[a][b] < 0 ? -1 : 1,
  );
  return {
    mapping,
    signs,
    congruence: mapping.map((b, a) =>
      b === null ? null : Math.abs(congruence[a][b]),
    ),
    unmatchedCandidate: Array.from({ length: kb }, (_, i) => i).filter(
      (i) => !mapping.includes(i),
    ),
  };
}
export function compareEfaRuns(a: EfaRun, b: EfaRun) {
  const shared = a.spec.items
    .map((x) => x.column)
    .filter((x) => b.spec.items.some((y) => x === y.column));
  if (!shared.length) throw new Error("These runs have no shared items.");
  const ai = shared.map((x) => a.spec.items.findIndex((y) => y.column === x)),
    bi = shared.map((x) => b.spec.items.findIndex((y) => y.column === x));
  const match = matchFactors(
    ai.map((i) => a.result.rotation.pattern[i]),
    bi.map((i) => b.result.rotation.pattern[i]),
  );
  const aligned = bi.map((i) =>
    match.mapping.map((f, j) =>
      f === null ? null : b.result.rotation.pattern[i][f] * match.signs[j],
    ),
  );
  const bRows = new Set(b.result.fittingRows),
    commonRows = a.result.fittingRows.filter((i) => bRows.has(i)).length;
  return {
    shared,
    ai,
    bi,
    ...match,
    aligned,
    commonRows,
    removedItems: a.spec.items.length - shared.length,
    addedItems: b.spec.items.length - shared.length,
    sameDatasetRevision: a.datasetRevision === b.datasetRevision,
    sameRows:
      commonRows === a.result.fittingRows.length &&
      commonRows === b.result.fittingRows.length,
  };
}
