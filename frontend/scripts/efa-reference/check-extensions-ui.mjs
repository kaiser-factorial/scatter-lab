import { chromium, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
const fixture = JSON.parse(
  await readFile(
    "src/lib/__tests__/fixtures/efa-extensions/mice-chain-polynomial.reference.json",
    "utf8",
  ),
);
const browser = await chromium.launch({ headless: true, channel: "chrome" });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (
      /Session restore failed|workspace/i.test(m.text()) &&
      m.type() === "error"
    )
      console.log(m.text());
  });
  await page.goto(process.argv[2] ?? "http://localhost:3000");
  await page.waitForFunction(
    () => window.__scatterlabBridge?.current,
    {},
    { timeout: 60000 },
  );
  await page.evaluate(() =>
    window.__scatterlabBridge.current.loadDemoData("open"),
  );
  await page.waitForFunction(
    () => window.__scatterlabBridge.current.snapshot().datasets.length > 0,
  );
  await page.evaluate((table) => {
    const b = window.__scatterlabBridge.current,
      s = b.snapshot(),
      d = s.datasets[0];
    b.restore({
      ...s,
      datasets: [
        {
          ...d,
          name: "MICE synthetic fixture",
          table,
          axes: { x: table.columns[0], y: table.columns[1], z: null },
          axes2d: { x: table.columns[0], y: table.columns[1] },
          pcaRuns: [],
          efa: { runs: [], splits: [] },
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
  }, fixture.table);
  await page.getByRole("button", { name: "EFA", exact: true }).click();
  await page.getByRole("button", { name: "Select ordinal candidates" }).click();
  await page.getByLabel("Factors", { exact: true }).fill("1");
  await page.getByLabel("Missing values", { exact: true }).selectOption("mice");
  await page.getByLabel("Imputations", { exact: true }).fill("2");
  await page.getByLabel("Sweeps per imputation", { exact: true }).fill("3");
  await page.getByLabel("Imputation seed", { exact: true }).fill("22031");
  await page
    .getByRole("button", { name: "Preview sample", exact: true })
    .click();
  await expect(page.getByText("Preview: 400 fitting rows")).toBeVisible();
  await page
    .getByRole("button", { name: "Run MICE + EFA", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: /Ordinal MICE/ });
  await expect(dialog).toBeVisible({ timeout: 30000 });
  await expect(dialog.getByText(/2\/2 fitted imputations/)).toBeVisible();
  await expect(
    dialog.getByRole("table", { name: "MICE pattern heatmap", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Structure", exact: true }).click();
  await dialog.getByLabel("Imputation view", { exact: true }).selectOption("0");
  await expect(
    dialog.getByRole("table", { name: "MICE structure heatmap", exact: true }),
  ).toBeVisible();
  await dialog
    .getByText("Iteration traces and failures", { exact: true })
    .click();
  await expect(
    dialog.getByRole("columnheader", { name: "Mean rank", exact: true }),
  ).toBeVisible();
  for (const theme of ["primary", "terminal"]) {
    await page.evaluate((theme) => {
      document.documentElement.setAttribute("data-theme", theme);
      document.documentElement.classList.remove(
        "primary",
        "terminal",
        "light",
        "dark",
      );
      document.documentElement.classList.add(theme);
      localStorage.setItem("theme", theme);
    }, theme);
    await page.screenshot({
      path: `scripts/efa-reference/screenshots/efa-mice-${theme}.png`,
    });
  }
  const first = await page.evaluate(
    () =>
      window.__scatterlabBridge.current.snapshot().datasets[0].efa
        .imputationRuns[0],
  );
  const hashes = first.result.fits.map((f) => f.result.provenance.inputSha256);
  if (
    hashes.some((h) => !h || h === first.result.provenance.inputSha256) ||
    new Set(hashes).size !== 2
  )
    throw new Error(
      "Completed imputations lack distinct response fingerprints.",
    );
  const download = page.waitForEvent("download");
  await dialog
    .getByRole("button", { name: "Export per-imputation CSV" })
    .click();
  const csv = await download;
  await csv.saveAs("/tmp/scatter-efa-mice.csv");
  const text = await readFile("/tmp/scatter-efa-mice.csv", "utf8");
  if (!text.includes("pattern_F1") || !text.includes("uniqueness"))
    throw new Error("MICE CSV lost result fields.");
  await dialog
    .getByLabel("MICE review item4", { exact: true })
    .selectOption("exclude");
  await dialog
    .getByLabel("MICE note item4", { exact: true })
    .fill("Check coverage after removal.");
  await dialog
    .getByLabel("MICE refit reasons", { exact: true })
    .fill("Item coverage comparison");
  await dialog
    .getByRole("button", { name: "Refit MICE selection", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      window.__scatterlabBridge.current.snapshot().datasets[0].efa
        .imputationRuns.length === 2,
    {},
    { timeout: 30000 },
  );
  const after = await page.evaluate(
    () => window.__scatterlabBridge.current.snapshot().datasets[0],
  );
  if (
    after.efa.imputationRuns[1].parentId !== first.id ||
    after.efa.imputationRuns[0].spec.items.length !== 4 ||
    after.efa.imputationRuns[1].spec.items.length !== 3
  )
    throw new Error("MICE refit lineage or retained baseline failed.");
  if (after.efa.imputationRuns.some((r) => r.result.observedPairFloor !== 5))
    throw new Error(
      "Original observed support metadata missing from MICE results.",
    );
  if (JSON.stringify(after.table) !== JSON.stringify(fixture.table))
    throw new Error("Source table changed.");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await page
    .getByLabel("Missing values", { exact: true })
    .selectOption("pairwise");
  await page
    .getByRole("button", { name: "Preview sample", exact: true })
    .click();
  await page.getByRole("button", { name: "Run EFA", exact: true }).click();
  const efa = page.getByRole("dialog", { name: /EFA ·/ });
  await expect(efa).toBeVisible({ timeout: 30000 });
  await efa
    .getByRole("button", { name: "Resampling stability", exact: true })
    .click();
  await efa.getByLabel("Resamples", { exact: true }).fill("10");
  await efa
    .getByRole("button", { name: "Run resampling stability", exact: true })
    .click();
  await expect(efa.getByText(/10\/10 successful refits/)).toBeVisible({
    timeout: 30000,
  });
  await expect(
    efa.getByRole("table", { name: "Stability item intervals", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "scripts/efa-reference/screenshots/efa-stability.png",
  });
  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    window.__scatterlabBridge.current.saveWorkspaceAs(
      "EFA extensions qualification",
    ),
  );
  const saved = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("scatter-lab");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result,
            request = db
              .transaction("workspaces")
              .objectStore("workspaces")
              .get("EFA extensions qualification");
          request.onsuccess = () => {
            resolve(request.result.payload);
            db.close();
          };
        };
      }),
  );
  await writeFile(
    "/tmp/scatter-efa-extensions-workspace.json",
    JSON.stringify(saved),
  );
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            new Promise((resolve, reject) => {
              const open = indexedDB.open("scatter-lab");
              open.onerror = () => reject(open.error);
              open.onsuccess = () => {
                const db = open.result,
                  request = db
                    .transaction("session")
                    .objectStore("session")
                    .get("current");
                request.onsuccess = () => {
                  const efa = request.result?.payload?.datasets?.[0]?.efa;
                  resolve([
                    efa?.imputationRuns?.length ?? 0,
                    efa?.stabilityRuns?.length ?? 0,
                  ]);
                  db.close();
                };
              };
            }),
        ),
      { timeout: 10000 },
    )
    .toEqual([2, 1]);
  await page.reload();
  await page.waitForFunction(
    () =>
      window.__scatterlabBridge?.current?.snapshot().datasets[0]?.efa
        ?.imputationRuns?.length === 2,
    {},
    { timeout: 30000 },
  );
  await page.getByText("EFA extensions qualification", { exact: true }).click();
  await page.waitForFunction(
    () =>
      window.__scatterlabBridge.current.snapshot().datasets[0]?.efa
        ?.stabilityRuns?.length === 1,
    {},
    { timeout: 30000 },
  );
  await page.getByRole("button", { name: "EFA", exact: true }).click();
  await page.getByRole("button", { name: /Open MICE results/ }).click();
  await expect(dialog).toBeVisible();
  const report = {
    status: errors.length ? "failed" : "passed",
    recordedAt: new Date().toISOString(),
    checks: [
      "explicit MICE settings and predictor review",
      "original observed pair support computed in worker and persisted",
      "per-imputation pattern/structure heatmaps",
      "iteration traces",
      "two themes",
      "per-imputation CSV",
      "immutable item refit and predictor remapping",
      "source preservation",
      "resampling intervals",
      "session and workspace restoration",
      "keyboard dismissal",
    ],
    pageErrors: errors,
  };
  await writeFile(
    "scripts/efa-reference/extensions-ui-verification.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
  if (errors.length) throw new Error(errors.join("\n"));
} catch (error) {
  if (page) {
    await page.screenshot({
      path: "/tmp/scatter-efa-extensions-ui-failure.png",
    });
    console.log((await page.locator("body").innerText()).slice(-6000));
  }
  throw error;
} finally {
  await browser.close();
}
