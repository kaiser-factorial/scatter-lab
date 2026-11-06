// Seeded pseudo-random numbers, shared so every "random" choice in the app is
// reproducible. Clustering promises byte-identical results across runs, and a
// diagnostic that sampled differently each time would quietly break that
// promise for suggest_k and suggest_eps.
//
// mulberry32: small, fast, and good enough for sampling and k-means++ seeding.
// Not for anything security-related.
export const mulberry32 = (seed: number) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * A seeded random subset of `0..n-1`, in ascending order, of size `min(n, cap)`.
 *
 * Deliberately random rather than evenly strided. Striding looks harmless and
 * is fine on shuffled data, but real research files are usually ordered — one
 * row per participant per wave, blocks of trials, cases sorted by condition —
 * and a stride that lands on the period samples a single stratum. At n = 4,800
 * with a 1,200 cap the stride is exactly 4, so a four-wave longitudinal file
 * would hand the diagnostic one wave and call it the dataset.
 *
 * Partial Fisher–Yates: O(cap) swaps, no rejection loop, no duplicates.
 */
export const sampleIndices = (n: number, cap: number, seed = 0x5CA7): number[] => {
  if (n <= cap) return Array.from({ length: n }, (_, i) => i);
  const rand = mulberry32(seed);
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < cap; i++) {
    const j = i + Math.floor(rand() * (n - i));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, cap).sort((a, b) => a - b);
};
