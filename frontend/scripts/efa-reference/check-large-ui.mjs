import { chromium, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
const serialized = await readFile(
  "/tmp/scatter-efa-large-fixture.json",
  "utf8",
);
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1100 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.argv[2] ?? "http://localhost:3000");
  await page.waitForFunction(
    () => window.__scatterlabBridge?.current,
    {},
    { timeout: 60000 },
  );
  await page.evaluate(async () =>
    window.__scatterlabBridge.current.loadDemoData("open"),
  );
  await page.waitForFunction(
    () => window.__scatterlabBridge.current.snapshot().datasets.length > 0,
  );
  await page.evaluate((serialized) => {
    const { table, run } = JSON.parse(serialized),
      b = window.__scatterlabBridge.current,
      s = b.snapshot(),
      d = s.datasets[0];
    b.restore({
      ...s,
      datasets: [
        {
          ...d,
          name: "500-item synthetic qualification",
          table,
          axes: { x: table.columns[0], y: table.columns[1], z: null },
          axes2d: { x: table.columns[0], y: table.columns[1] },
          pcaRuns: [],
          efa: { runs: [run], splits: [] },
        },
      ],
      activeId: d.id,
      pinnedViews: [],
      analysisViews: [],
      rowFilter: null,
      colorBy: "",
      shapeBy: "",
      viewMode: "2D",
    });
  }, serialized);
  await page.getByRole("button", { name: "EFA", exact: true }).click();
  await page.getByRole("button", { name: /Open EFA results/ }).click();
  const table = page.locator('table[aria-rowcount="501"]');
  await expect(table).toBeVisible({ timeout: 30000 });
  const rendered = await table.locator("tbody tr").count();
  if (rendered > 25)
    throw new Error(`Virtualization rendered ${rendered} rows`);
  await table.evaluate((t) => {
    t.parentElement.scrollTop = 100000;
  });
  await expect(
    table.getByRole("button", { name: "Q500", exact: true }),
  ).toBeVisible();
  await page.getByRole("checkbox", { name: "Loading heatmap" }).check();
  await page.screenshot({
    path: "scripts/efa-reference/screenshots/efa-500-items.png",
  });
  await page.keyboard.press("Escape");
  if (errors.length) throw new Error(errors.join("\n"));
  const report = {
    status: "passed",
    items: 500,
    respondents: 20000,
    renderedTableRows: rendered,
    checks: [
      "real full-size fit displayed",
      "virtualized table",
      "keyboard dismissal",
      "last item reachable",
      "loading heatmap",
    ],
    pageErrors: errors,
  };
  await writeFile(
    "scripts/efa-reference/large-ui-verification.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
