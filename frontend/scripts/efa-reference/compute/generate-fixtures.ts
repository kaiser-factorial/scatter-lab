import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { prepareEfa } from "../../../src/lib/efa/prepare";
import { correlate } from "../../../src/lib/efa/correlation";
import { weightedMoments } from "../../../src/lib/efa/weighted-moments";
import { extractDwls } from "../../../src/lib/efa/dwls";
import { weightedInferenceSteps } from "../../../src/lib/efa/weighted-inference";
import { cpuTraceBlock, type RobustTraceBlock } from "../../../src/lib/efa/trace-kernel";
import { mulberry32 } from "../../../src/lib/random";
import { encodeBlock } from "./binary";
import type { EfaSpec } from "../../../src/lib/efa/types";
import type { DataTable } from "../../../src/lib/table";

const output = process.argv[2] ?? "public/efa-qualification/compute/fixtures";
await mkdir(output, { recursive: true });
const manifest: object[] = [];
async function save(name: string, block: RobustTraceBlock, source: string) {
  const encoded = Buffer.from(encodeBlock(block)), start = performance.now(), reference = cpuTraceBlock(block), baselineMs = performance.now() - start;
  await writeFile(`${output}/${name}.bin`, encoded);
  await writeFile(`${output}/${name}.reference.bin`, new Uint8Array(reference.buffer));
  manifest.push({ name, source, inputSha256: createHash("sha256").update(encoded).digest("hex"), bytes: encoded.length,
    rows: block.left.length, cols: block.right.length, pairs: block.left[0].length, parameters: block.leftProjection[0].length, diagonal: block.diagonal,
    baselineNodeMs: baselineMs, referenceSha256: createHash("sha256").update(new Uint8Array(reference.buffer)).digest("hex") });
}
for (const name of ["normal", "pairwise", "complete", "skew", "heavy-tail"]) {
  const path = `src/lib/__tests__/fixtures/efa-weighted/${name}.input.json`;
  const raw = await readFile(path), input = JSON.parse(raw.toString()) as DataTable & { categories: number[][]; reverse: number[]; missing: "pairwise" | "complete"; nFactors: number };
  const spec: EfaSpec = { extraction: "dwls", items: input.columns.map((column, i) => ({ column, categories: input.categories[i], reverse: input.reverse.includes(i) })), nFactors: input.nFactors, rotation: "oblimin", missing: input.missing, seed: 73021, label: name, sample: { partition: "all" } };
  const data = prepareEfa(input, spec, Array.from({ length: input.nRows }, (_, i) => i)), correlation = correlate(data), moments = weightedMoments(data, correlation), fit = extractDwls(correlation.matrix, moments, spec.nFactors);
  const steps = weightedInferenceSteps(data, moments, fit.loadings, fit.convergence.objective, undefined, { space: "cases" });
  const first = steps.next();
  if (first.done) throw new Error("Expected case-space kernel");
  const provenance = `${path} sha256:${createHash("sha256").update(raw).digest("hex")}`;
  await save(`${name}-diagonal`, first.value, provenance);
  const second = steps.next(cpuTraceBlock(first.value));
  if (second.done) throw new Error("Expected second case block");
  await save(`${name}-offdiagonal`, second.value, provenance);
  await save(`${name}-ragged`, { ...second.value, left: second.value.left.slice(0, 19), leftProjection: second.value.leftProjection.slice(0, 19), right: second.value.right.slice(0, 7), rightProjection: second.value.rightProjection.slice(0, 7) }, provenance);
  steps.return(undefined as never);
}
// Width stress fixture: actual 500-item / five-factor dimensions, not a claim
// that a full 20,000-row model was fitted. Full-pipeline checks are separate.
const random = mulberry32(20261031);
const matrix = (rows: number, columns: number, scale: number) => Array.from({ length: rows }, () => Float64Array.from({ length: columns }, () => scale * (random() - 0.5)));
await save("wide-500-items", { left: matrix(32, 124750, 0.02), right: matrix(32, 124750, 0.02), leftProjection: matrix(32, 2490, 0.01), rightProjection: matrix(32, 2490, 0.01), diagonal: false }, "Synthetic width stress; mulberry32 seed 20261031; no complete fit");
const cancelA = matrix(32, 4096, 1), cancelB = matrix(32, 4096, 1);
await save("cancellation-stress", { left: cancelA, right: cancelB, leftProjection: cancelA.map(row => Float64Array.from(row, v => v * (1 + 1e-7))), rightProjection: cancelB, diagonal: false }, "Synthetic near-cancellation stress; continues saved generator stream");
await writeFile(`${output}/manifest.json`, JSON.stringify({ schema: 1, fixtures: manifest, tolerance: "max absolute error / max(1, abs(reference)) <= 1e-5 for GPU; 1e-10 for Scala float64", generatedAt: new Date().toISOString() }, null, 2) + "\n");
console.log(`Wrote ${manifest.length} identical-input kernel fixtures to ${output}`);
