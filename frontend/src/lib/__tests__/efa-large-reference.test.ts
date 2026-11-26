import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { extractMinres } from "../efa/extraction";

// Expensive numerical regression gate, enabled explicitly in the independent-R CI
// job. These matrices are shared inputs: this checks extraction, not R polychorics.
const large = it.skipIf(process.env.EFA_LARGE_PARITY !== "1");
for (const [input, reference, seed] of [
  ["parallel-large-correlation.json", "parallel-large-r.reference.json", 8801],
  [
    "parallel-large-8802-correlation.json",
    "parallel-large-8802-r.reference.json",
    8802,
  ],
  [
    "parallel-large-8804-correlation.json",
    "parallel-large-8804-r.reference.json",
    8804,
  ],
] as const) {
  large(
    `qualifies the 500-item null extraction for saved seed ${seed}`,
    () => {
      const folder = new URL("./fixtures/efa-extensions/", import.meta.url),
        bytes = readFileSync(new URL(input, folder)),
        matrix = JSON.parse(bytes.toString()) as number[][],
        expected = JSON.parse(
          readFileSync(new URL(reference, folder), "utf8"),
        ) as {
          provenance: { inputSha256: string };
          loadings: number[][];
          communalities: number[];
          objective: number;
        };
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        expected.provenance.inputSha256,
      );
      const result = extractMinres(matrix, 1),
        loadings = result.loadings.map((row) => row[0]),
        sign =
          loadings.reduce((sum, v, i) => sum + v * expected.loadings[i][0], 0) <
          0
            ? -1
            : 1;
      expect(result.convergence.converged).toBe(true);
      expect(result.convergence.gradient).toBeLessThan(1e-8);
      expect(
        Math.abs(result.convergence.objective - expected.objective),
      ).toBeLessThan(1e-5);
      expect(
        Math.max(
          ...loadings.map((v, i) =>
            Math.abs(sign * v - expected.loadings[i][0]),
          ),
        ),
      ).toBeLessThan(1e-3);
      expect(
        Math.max(
          ...loadings.map((v, i) =>
            Math.abs(v * v - expected.communalities[i]),
          ),
        ),
      ).toBeLessThan(1e-4);
      let maxReproducedDifference = 0;
      for (let i = 0; i < loadings.length; i++)
        for (let j = 0; j <= i; j++)
          maxReproducedDifference = Math.max(
            maxReproducedDifference,
            Math.abs(
              loadings[i] * loadings[j] -
                expected.loadings[i][0] * expected.loadings[j][0],
            ),
          );
      expect(maxReproducedDifference).toBeLessThan(1e-4);
    },
    600000,
  );
}
