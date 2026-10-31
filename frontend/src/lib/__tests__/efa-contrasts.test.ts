import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ordinalContrasts } from "../efa/mice";

const reference = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/efa-extensions/ordinal-contrasts.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { cases: Record<string, number[][]> };
it("matches independent R ordered contrasts through eleven-point scales", () => {
  for (const [levels, expected] of Object.entries(reference.cases)) {
    const result = ordinalContrasts(Number(levels));
    expect(
      Math.max(
        ...result.flatMap((row, i) =>
          row.map((v, j) => Math.abs(v - expected[i][j])),
        ),
      ),
    ).toBeLessThan(1e-10);
  }
});
it("rejects oversized or invalid ordinal metadata before constructing a quadratic predictor basis", () => {
  for (const levels of [0, 1, 2.5, NaN, Infinity, 65535])
    expect(() => ordinalContrasts(levels)).toThrow(/declared categories/);
});
