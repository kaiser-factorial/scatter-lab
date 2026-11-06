import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Matrix } from "../efa/math";
import { identifyLoadings } from "../efa/weighted-inference";
import { rotate } from "../efa/rotation";
import { rotatedUncertainty, rotatedUncertaintyParallel, rotationDerivativeBatch, rotationDerivativeContext, RotationDerivativeAccumulator } from "../efa/weighted-rotation";

const referenceFile = JSON.parse(readFileSync(new URL("./fixtures/efa-weighted/normal.reference.json", import.meta.url), "utf8"));
const pattern = new Matrix(referenceFile.fits.oblimin.est.lambda);
// Restore an orthogonal loading representation from the R pattern and Phi.
import { CholeskyDecomposition } from "ml-matrix";
const loadings = pattern.mmul(new CholeskyDecomposition(new Matrix(referenceFile.fits.oblimin.est.psi)).lowerTriangularMatrix).to2DArray();
for (const method of ["oblimin", "promax", "varimax"] as const) it(`${method}: out-of-order derivative batches reproduce serial uncertainty exactly`, async () => {
  const identified = identifyLoadings(loadings), reference = rotate(loadings, method, 73021, 4, true);
  const q = identified.free.length, covariance = Matrix.eye(q).mul(.001);
  for (let i = 0; i < q; i++) for (let j = 0; j < q; j++) covariance.set(i, j, covariance.get(i, j) + .0001);
  const completed: number[] = [], progress: number[] = [];
  const serial = rotatedUncertainty(identified, covariance, reference, method, 73021);
  const parallel = await rotatedUncertaintyParallel(identified, covariance, reference, method, 73021,
    async (context, start, count) => {
      await new Promise(resolve => setTimeout(resolve, start === 0 ? 40 : 1));
      const batch = rotationDerivativeBatch(context, start, count); completed.push(start); return batch;
    }, 4, value => { if (value.stage === "Rotated standard errors") progress.push(value.completed); });
  expect(completed[0]).not.toBe(0);
  expect(parallel).toEqual(serial);
  expect(progress.at(-1)).toBe(q);
  expect(progress).toEqual([...progress].sort((a, b) => a - b));
});
it("rejects duplicate, incomplete, malformed, wrong-range and failed work", async () => {
  const identified = identifyLoadings(loadings), reference = rotate(loadings, "oblimin", 73021, 4, true), covariance = Matrix.eye(identified.free.length);
  const context = rotationDerivativeContext(identified, reference, "oblimin", 73021), accumulator = new RotationDerivativeAccumulator(context);
  const batch = rotationDerivativeBatch(context, 0, 8);
  expect(() => accumulator.finish(covariance)).toThrow(/incomplete/);
  expect(() => accumulator.add({ ...batch, maxChange: .006 })).toThrow(/Malformed/);
  expect(() => accumulator.add({ ...batch, values: new Float64Array([NaN]) })).toThrow(/Malformed/);
  accumulator.add(batch);
  expect(() => accumulator.add(batch)).toThrow(/duplicate/);
  expect(() => rotationDerivativeBatch(context, 0, 17)).toThrow(/range/);
  await expect(rotatedUncertaintyParallel(identified, covariance, reference, "oblimin", 73021, async () => { throw new Error("peer failed"); }, 4)).rejects.toThrow("peer failed");
  await expect(rotatedUncertaintyParallel(identified, covariance, reference, "oblimin", 73021, async () => batch, 4)).rejects.toThrow(/wrong range/);
  await expect(rotatedUncertaintyParallel(identified, covariance, reference, "oblimin", 73021, async () => batch, 5)).rejects.toThrow(/one and four/);
});
