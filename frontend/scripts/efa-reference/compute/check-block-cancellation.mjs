import { chromium, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
const table = JSON.parse(await readFile("src/lib/__tests__/fixtures/efa-weighted/normal.input.json", "utf8"));
for (const column of table.columns) { const values = table.data[column]; table.data[column] = Array.from({ length: 12000 }, (_, i) => values[i % values.length]); }
table.nRows = 12000;
const artifactDirectory = process.argv[3] ?? "scripts/efa-reference/compute/cache-ui-v4";
await mkdir(artifactDirectory, { recursive: true });
const backend = process.argv[2] ?? "webgpu";
const pairing = backend === "scala" ? JSON.parse(await readFile("/tmp/scatter-efa-companion-pairing.json", "utf8")) : undefined;
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", e => errors.push(e.message));
  await page.goto("http://localhost:3000");
  await page.getByRole("button", { name: "Open computation inspector" }).click();
  const inspector = page.getByRole("dialog", { name: "Computation inspector" });
  await expect(inspector.getByText(/No computations yet/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(inspector).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Open computation inspector" })).toBeFocused();
  await page.waitForFunction(() => window.__scatterlabBridge?.current);
  await page.evaluate(async () => window.__scatterlabBridge.current.loadDemoData("open"));
  await page.waitForFunction(() => window.__scatterlabBridge.current.snapshot().datasets.length > 0);
  await page.evaluate(table => {
    const bridge = window.__scatterlabBridge.current, snapshot = bridge.snapshot(), first = snapshot.datasets[0];
    bridge.restore({ ...snapshot, datasets: [{ ...first, name: "Public inspector fixture", table,
      axes: { x: table.columns[0], y: table.columns[1], z: null }, axes2d: { x: table.columns[0], y: table.columns[1] }, pcaRuns: [], efa: { runs: [], splits: [] } }],
      activeId: first.id, pinnedViews: [], analysisViews: [], rowFilter: null, colorBy: "", shapeBy: "", viewMode: "2D" });
  }, table);
  await page.getByRole("button", { name: "EFA", exact: true }).click();
  await page.getByRole("button", { name: "Select ordinal candidates" }).click();
  await page.getByLabel("EFA extraction").selectOption("wlsmv");
  await page.getByLabel("EFA compute backend").selectOption(backend);
  await page.getByText("Memory and block settings", { exact: true }).click();
  await page.getByLabel("EFA block rows", { exact: true }).selectOption("256");
  if (backend === "scala") {
    await page.getByLabel("Companion URL").fill(pairing.url);
    await page.getByLabel("Pairing token").fill(pairing.token);
    await page.getByRole("button", { name: "Connect local companion" }).click();
    await expect(page.getByText("Companion paired for this session.")).toBeVisible();
    await expect(page.getByLabel("Pairing token")).toHaveCount(0);
  }
  await page.getByRole("button", { name: "Preview sample", exact: true }).click();
  await expect(page.getByText(`Preview: ${table.nRows} fitting rows`)).toBeVisible();
  await page.getByRole("button", { name: "Run EFA", exact: true }).click();
  await page.getByRole("button", { name: "Open computation inspector" }).click();
  await expect(inspector.getByText(/Exact robust trace blocks:/)).toBeVisible({ timeout: 60000 });
  const started = performance.now();
  await inspector.getByRole("button", { name: "Cancel job" }).click();
  await expect(inspector.getByText("cancelled", { exact: true })).toBeVisible();
  if (backend === "scala") await expect(inspector.getByText(/Process cleanup: native-exited/)).toBeVisible({ timeout: 5000 });
  const cancellationMs = performance.now() - started;
  if (cancellationMs > 1000) throw new Error("Cancellation acknowledgement exceeded one second");
  const download = page.waitForEvent("download");
  await inspector.getByRole("button", { name: "Export diagnostics" }).click();
  const report = JSON.parse(await readFile(await (await download).path(), "utf8"));
  if (report.status !== "cancelled" || report.execution.selfCheck.passed !== true) throw new Error("Incomplete cancellation report");
  const runs = await page.evaluate(() => window.__scatterlabBridge.current.snapshot().datasets[0].efa.runs.length);
  if (runs !== 0 || report.publication !== "discarded") throw new Error("Cancelled run published a result");
  if (errors.length) throw new Error(errors.join("\n"));
  await writeFile(`${artifactDirectory}/cancel-${backend}.json`, JSON.stringify({ status: "passed", recordedAt: new Date().toISOString(), cancellationMs, report }, null, 2) + "\n");
  console.log(JSON.stringify({ status: "passed", backend, cancellationMs, publishedRuns: runs }));
} finally { await browser.close(); }
