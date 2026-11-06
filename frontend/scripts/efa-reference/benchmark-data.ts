import { mulberry32 } from "../../src/lib/random";
import type { DataTable } from "../../src/lib/table";
import type { EfaSpec } from "../../src/lib/efa/types";
export function benchmarkData(n = 20000, p = 500) {
  const random = mulberry32(8801),
    normal = () =>
      Math.sqrt(-2 * Math.log(Math.max(1e-12, random()))) *
      Math.cos(2 * Math.PI * random());
  const columns = Array.from({ length: p }, (_, i) => `Q${i + 1}`),
    data: DataTable["data"] = Object.fromEntries(
      columns.map((c) => [c, Array(n)]),
    );
  for (let i = 0; i < n; i++) {
    const common = normal(),
      f = Array.from({ length: 5 }, () => 0.45 * common + 0.89 * normal());
    for (let j = 0; j < p; j++) {
      const z = 0.65 * f[j % 5] + 0.76 * normal();
      data[columns[j]][i] =
        z < -1 ? 1 : z < -0.3 ? 2 : z < 0.3 ? 3 : z < 1 ? 4 : 5;
    }
  }
  const spec: EfaSpec = {
    items: columns.map((column) => ({
      column,
      categories: [1, 2, 3, 4, 5],
      reverse: false,
    })),
    nFactors: 5,
    rotation: "oblimin",
    missing: "pairwise",
    seed: 8801,
    label: "qualification",
    sample: { partition: "all" },
  };
  return { table: { columns, data, nRows: n }, spec };
}
