import { expect, it } from "vitest";
import { FitInvariantCache, type FitInvariant } from "../efa/fit-cache";
const value = (bytes: number) => ({
  extraction: {}, weighted: {}, inference: { identified: {}, test: {}, plan: {}, covariance: new Float64Array(bytes / 8) },
}) as FitInvariant;
it("evicts least recently used covariance entries under both byte and entry bounds", () => {
  const cache = new FitInvariantCache(4000, 2), a = value(800), b = value(800), c = value(800);
  expect(cache.acceptsCovariance(100)).toBe(false);
  expect(cache.acceptsCovariance(10)).toBe(true);
  expect(cache.put("a", a)).toBe(true); expect(cache.put("b", b)).toBe(true);
  expect(cache.get("a")).toBe(a);
  cache.put("c", c); expect(cache.get("b")).toBeUndefined(); expect(cache.get("a")).toBe(a);
  expect(cache.put("huge", value(8000))).toBe(false); expect(cache.get("a")).toBe(a);
  const small = new FitInvariantCache(1500, 5);
  small.put("a", a); small.put("b", b); expect(small.get("a")).toBeUndefined(); expect(small.get("b")).toBe(b);
  expect(new FitInvariantCache(4000, 0).put("a", a)).toBe(false);
});
