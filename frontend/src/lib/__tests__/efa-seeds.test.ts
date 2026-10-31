import { expect, it } from "vitest";
import { validateReplicates } from "../efa/parallel";
import { validateMiceOptions } from "../efa/mice";
import { validateStability } from "../efa/stability";

it("rejects parallel-analysis seed offsets that would repeat through floating-point rounding", () => {
  const seed = Number.MAX_SAFE_INTEGER;
  expect(seed + 1).toBe(seed + 2);
  expect(() => validateReplicates(2, seed)).toThrow(/safe integer range/);
  expect(() => validateReplicates(3, seed)).toThrow(/safe integer range/);
  expect(() => validateReplicates(3, seed - 2)).not.toThrow();
  expect(() => validateReplicates(100, 8801)).not.toThrow();
});
it("rejects imputation chain seeds outside the exact integer range", () => {
  const options = {
    imputations: 3,
    iterations: 1,
    seed: Number.MAX_SAFE_INTEGER,
    predictors: [
      [1, 2],
      [0, 2],
      [0, 1],
    ],
  };
  expect(() => validateMiceOptions(options, 3)).toThrow(/safe integer range/);
  expect(() =>
    validateMiceOptions({ ...options, seed: options.seed - 2 * 104729 }, 3),
  ).not.toThrow();
});
it("rejects resampling seed offsets that cannot be represented distinctly", () => {
  const options = {
    replicates: 3,
    seed: Number.MAX_SAFE_INTEGER,
    confidence: 0.95,
    crossLoadingThreshold: 0.3,
  };
  expect(() => validateStability(options)).toThrow(/safe integer range/);
  expect(() => validateStability({ ...options, replicates: 2 })).toThrow(
    /safe integer range/,
  );
  expect(() =>
    validateStability({ ...options, seed: options.seed - 2 }),
  ).not.toThrow();
});
