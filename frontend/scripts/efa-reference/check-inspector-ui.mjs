import { chromium, expect } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
const table = JSON.parse(await readFile("src/lib/__tests__/fixtures/efa/mixed.input.json", "utf8"));
const artifactDirectory = process.argv[3] ?? "scripts/efa-reference";
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(process.argv[2] ?? "http://localhost:3000");
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
  await page.getByRole("button", { name: "Preview sample", exact: true }).click();
  await expect(page.getByText("Preview: 1500 fitting rows")).toBeVisible();
  await page.getByRole("button", { name: "Run EFA", exact: true }).click();
  await page.getByRole("button", { name: "Close results", exact: true }).click({ timeout: 30000 });
  await page.getByRole("button", { name: "Open computation inspector" }).click();
  await expect(inspector.getByText("accepted", { exact: true })).toBeVisible();
  await expect(inspector.getByText("Correlations", { exact: true }).first()).toBeVisible();
  const download = page.waitForEvent("download");
  await inspector.getByRole("button", { name: "Export diagnostics" }).click();
  const report = JSON.parse(await readFile(await (await download).path(), "utf8"));
  if (report.status !== "completed" || report.publication !== "accepted" || report.workersCreated < 1 || report.requests.fit.workerMs <= 0) throw new Error("Incomplete instrumentation report");
  if (JSON.stringify(report).includes("item1") || JSON.stringify(report).includes("Public inspector fixture")) throw new Error("Source identifiers leaked into diagnostic export");
  await mkdir(`${artifactDirectory}/screenshots`, { recursive: true });
  for (const theme of ["primary", "terminal"]) {
    await page.evaluate(theme => { document.documentElement.setAttribute("data-theme", theme); }, theme);
    await page.screenshot({ path: `${artifactDirectory}/screenshots/compute-${theme}.png` });
  }
  await inspector.getByRole("button", { name: "Diagnostics", exact: true }).click();
  await expect(inspector.getByText(/Boundary items:/)).toBeVisible();
  await inspector.getByRole("button", { name: "Logs", exact: true }).click();
  await expect(inspector.getByText(/At most 512/)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open computation inspector" }).click();
  const box = await inspector.boundingBox();
  if (!box || box.x < 0 || box.width > 390) throw new Error("Inspector overflows narrow viewport");
  await page.screenshot({ path: `${artifactDirectory}/screenshots/compute-mobile.png` });
  await inspector.getByRole("button", { name: "Close computation inspector" }).focus();
  await page.keyboard.press("Shift+Tab");
  if (!await page.evaluate(() => !!document.activeElement?.closest("dialog"))) throw new Error("Focus escaped modal");
  if (errors.length) throw new Error(errors.join("\n"));
  await writeFile(`${artifactDirectory}/inspector-ui-verification.json`, JSON.stringify({ status: "passed", recordedAt: new Date().toISOString(), checks: ["empty state", "real worker timings", "accepted result", "export without source identifiers", "both themes", "390px viewport", "Escape and focus return", "focus containment"], report }, null, 2) + "\n");
  console.log("Inspector browser verification passed");
} finally { await browser.close(); }
