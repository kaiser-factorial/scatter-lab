import { it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import os from "node:os";
import { mulberry32 } from "../random";
import { prepareEfa } from "../efa/prepare";
import { correlate } from "../efa/correlation";
import { fitEfa, scoreEfa } from "../efa/fit";
import type { DataTable } from "../table";
import type { EfaSpec } from "../efa/types";

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
it.skipIf(process.env.EFA_BENCHMARK !== "1")(
  "qualifies 500 items × 20,000 respondents",
  () => {
    const { table, spec } = benchmarkData(),
      timings: Record<string, number> = {},
      convergence: unknown[] = [];
    let start = performance.now();
    const data = prepareEfa(
      table,
      spec,
      Array.from({ length: table.nRows }, (_, i) => i),
    );
    timings.prepare = performance.now() - start;
    start = performance.now();
    const cor = correlate(data);
    timings.correlations = performance.now() - start;
    start = performance.now();
    const result = fitEfa(data, cor, spec);
    timings.fit = performance.now() - start;
    convergence.push(
      result.extraction.convergence,
      result.rotation.convergence,
    );
    for (const rotation of ["promax", "varimax"] as const) {
      start = performance.now();
      const r = fitEfa(
        data,
        cor,
        { ...spec, rotation },
        undefined,
        result.extraction,
      );
      timings[rotation] = performance.now() - start;
      convergence.push(r.rotation.convergence);
    }
    start = performance.now();
    const scores = scoreEfa(data, result);
    timings.scores = performance.now() - start;
    expect(scores.filter((s) => s[0] !== null)).toHaveLength(20000);
    start = performance.now();
    const holdout = prepareEfa(
        table,
        spec,
        Array.from({ length: 6000 }, (_, i) => i + 14000),
      ),
      hcor = correlate(holdout),
      hfit = fitEfa(holdout, hcor, spec);
    timings.holdout = performance.now() - start;
    convergence.push(hfit.extraction.convergence, hfit.rotation.convergence);
    const report = {
      runtime: process.version,
      hardware: {
        platform: os.platform(),
        arch: os.arch(),
        cpu: os.cpus()[0].model,
        logicalCPUs: os.cpus().length,
      },
      dimensions: { items: 500, respondents: 20000 },
      timingsMs: timings,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      convergence,
    };
    writeFileSync(
      "scripts/efa-reference/node-benchmark.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(JSON.stringify(report));
  },
  1800000,
);
