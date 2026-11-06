import { readFileSync, writeFileSync } from "node:fs";
import { benchmarkData } from "./benchmark-data";
import { prepareEfa } from "../../src/lib/efa/prepare";
import { permutedData } from "../../src/lib/efa/parallel";
import { correlate } from "../../src/lib/efa/correlation";
import { extractMinres } from "../../src/lib/efa/extraction";
const start = performance.now();
const options = new Map(
  process.argv
    .slice(2)
    .filter((x) => x.startsWith("--"))
    .map((x) => {const [key,value]=x.slice(2).split("=");return [key,value] as const;}),
);
const input = process.argv.slice(2).find((x) => !x.startsWith("--"));
const seed = Number(options.get("seed") ?? 8801),
  iterations = Number(options.get("iterations") ?? 500);
let correlation: number[][];
if (input) correlation = JSON.parse(readFileSync(input, "utf8"));
else {
  const { table, spec } = benchmarkData();
  const data = permutedData(
    prepareEfa(
      table,
      spec,
      Array.from({ length: table.nRows }, (_, i) => i),
    ),
    seed,
  );
  console.log("Prepared", performance.now() - start);
  correlation = correlate(data).matrix;
}
writeFileSync(
  `/tmp/scatter-efa-pa-null-${seed}.json`,
  JSON.stringify(correlation),
);
console.log("Correlated", performance.now() - start);
try {
  const result = extractMinres(
    correlation,
    1,
    (p) =>
      console.log(
        JSON.stringify({ ...p, elapsedMs: performance.now() - start }),
      ),
    iterations,
  );
  writeFileSync(
    `/tmp/scatter-efa-pa-native-${seed}.json`,
    JSON.stringify(result),
  );
  console.log(JSON.stringify(result.convergence));
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
