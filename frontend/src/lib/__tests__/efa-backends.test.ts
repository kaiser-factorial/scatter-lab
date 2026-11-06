import { it, expect, vi, afterEach } from "vitest";
import { ordinalSourceChunks, ordinalSourceSize, encodeOrdinalSource } from "../efa/backends/native-protocol";
import { checkSource, numericalSelfCheck } from "../efa/backends/self-check";
import { cpuTraceBlock } from "../efa/trace-kernel";
import { computeSettings } from "../efa/backends/types";
import { createBackend } from "../efa/backends/runtime";
import { validateConnection, connectCompanion } from "../efa/backends/companion";
import type { EfaSpec } from "../efa/types";
const spec = { extraction: "wlsmv" } as EfaSpec;
afterEach(() => vi.unstubAllGlobals());
it.each([128, 256])("self-check covers chunking, missingness, offsets and %i-row blocks", async (blockSize) => {
  const sizes: number[] = [];
  const result = await numericalSelfCheck(async block => { sizes.push(block.left.length); return cpuTraceBlock(block); }, blockSize);
  expect(sizes).toEqual([17, 16, blockSize, blockSize, 3]); expect(result.passed).toBe(true); expect(result.maxScaledError).toBe(0);
});
it.each(["corrupt", "nan", "shape"])("rejects %s backend results instead of publishing a passed check", async mode => {
  await expect(numericalSelfCheck(async block => { const out = cpuTraceBlock(block); if (mode === "shape") return out.slice(1); out[0] += mode === "nan" ? NaN : 1; return out; }, 32)).rejects.toThrow(/self-check/);
});
it("validates method/backend/block budgets and rejects saved credentials", () => {
  expect(computeSettings(spec)).toMatchObject({ backend: "cpu", blockSize: 32 });
  expect(computeSettings({ ...spec, compute: { backend: "webgpu" } })).toMatchObject({ space: "cases", blockSize: 128 });
  expect(computeSettings({ ...spec, compute: { backend: "webgpu", blockSize: 256 } })).toMatchObject({ blockSize: 256 });
  expect(() => computeSettings({ ...spec, extraction: "minres", compute: { backend: "scala" } })).toThrow(/WLSMV/);
  expect(() => computeSettings({ ...spec, compute: { backend: "scala", token: "secret" } as never })).toThrow(/session-only/);
});
it.each(["https://remote.example:443", "http://localhost:8787", "http://127.0.0.1:8787/path", "http://127.0.0.1:8787/?token=secret", "http://user@127.0.0.1:8787"])("rejects nonliteral or credential-bearing companion target %s without fetching", url => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  expect(() => validateConnection({ url, token: "a".repeat(64) })).toThrow(); expect(fetch).not.toHaveBeenCalled();
});
it("does not follow redirects or expose response text on a rejected pairing", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: false, text: () => "private server details" }); vi.stubGlobal("fetch", fetch);
  await expect(connectCompanion({ url: "http://127.0.0.1:8787", token: "b".repeat(64) })).rejects.toThrow(/request failed/);
  expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: "error", credentials: "omit" });
});

it("a failed native self-check prevents any analysis-source request and is visible in execution telemetry", async () => {
  const snapshots: unknown[] = [], operations: string[] = [];
  const fetch = vi.fn(async (url: string, init: { body?: ArrayBuffer }) => {
    const route = new URL(url).pathname; operations.push(route);
    if (route.includes("/source-")) return new Response(new ArrayBuffer(8));
    if (route.endsWith("/block")) {
      const view = new DataView(init.body!);
      return new Response(new ArrayBuffer(24 + 8 * view.getUint32(12, true) * view.getUint32(16, true)));
    }
    return Response.json({ runtime: "synthetic rejection fixture" });
  });
  vi.stubGlobal("fetch", fetch);
  await expect(createBackend({ ...spec, compute: { backend: "scala" } }, { url: "http://127.0.0.1:8787", token: "a".repeat(64), id: "00000000-0000-0000-0000-000000000000" }, value => snapshots.push(value), () => {})).rejects.toThrow(/self-check/);
  expect(operations.filter(p => p.endsWith("/source-start"))).toHaveLength(1);
  expect(snapshots.at(-1)).toMatchObject({ state: "failed", failure: "backend-self-check" });
});

it("bounded source chunks reproduce the qualified native bytes exactly, including odd offsets", () => {
  const source = checkSource(7, 19), bytes = new Uint8Array(ordinalSourceSize(source));
  let at = 0;
  for (const chunk of ordinalSourceChunks(source, 32)) { expect(chunk.byteLength).toBeLessThanOrEqual(32); bytes.set(new Uint8Array(chunk), at); at += chunk.byteLength; }
  expect(at).toBe(bytes.length); expect(bytes).toEqual(new Uint8Array(encodeOrdinalSource(source)));
});

it.each([null, false, 0, "", [], { backend: "webgpu", blockSize: null }, { backend: "scala", memoryMiB: null }])("rejects malformed compute settings without silently defaulting to CPU", compute => {
  expect(() => computeSettings({ ...spec, compute: compute as never })).toThrow();
});
