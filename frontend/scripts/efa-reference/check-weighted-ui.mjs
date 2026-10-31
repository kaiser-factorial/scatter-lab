import { chromium, expect } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
const input = JSON.parse(
  await readFile("src/lib/__tests__/fixtures/efa/mixed.input.json", "utf8"),
);
const longItem =
  "Item 8 — Confidence when coordinating a complex unfamiliar task with several colleagues and conflicting requirements";
input.data[longItem] = input.data[input.columns[7]];
delete input.data[input.columns[7]];
input.columns[7] = longItem;
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const failures = [];
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("console", (message) => {
    if (/Session restore failed/.test(message.text()))
      console.log(message.text());
  });
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
  await page.evaluate((table) => {
    const b = window.__scatterlabBridge.current,
      s = b.snapshot(),
      d = s.datasets[0];
    b.restore({
      ...s,
      datasets: [
        {
          ...d,
          name: "Public EFA fixture",
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
  }, input);
  await page.getByRole("button", { name: "EFA", exact: true }).click();
  await page.getByRole("button", { name: "Select ordinal candidates" }).click();
  await page
    .getByLabel("EFA extraction", { exact: true })
    .selectOption("wlsmv");
  await page
    .getByRole("button", { name: "Preview sample", exact: true })
    .click();
  await expect(page.getByText("Preview: 1500 fitting rows")).toBeVisible();
  await expect(page.getByText(/Exact WLSMV inference:/)).toBeVisible();
  await page.getByRole("button", { name: "Run EFA", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /EFA · Likert/ });
  await expect(dialog).toBeVisible({ timeout: 30000 });
  await expect(
    dialog.getByText("WLSMV fit and uncertainty", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByTitle(longItem, { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole("table", { name: "pattern heatmap", exact: true }),
  ).toBeVisible();
  const patternValue = await dialog
    .getByRole("table", { name: "pattern heatmap", exact: true })
    .locator("tbody tr")
    .first()
    .locator("td")
    .first()
    .innerText();
  await dialog.getByRole("button", { name: "Structure", exact: true }).click();
  await expect(
    dialog.getByRole("table", { name: "structure heatmap", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByLabel("Show robust SE in parentheses"),
  ).toBeChecked();
  const structureValue = await dialog
    .getByRole("table", { name: "structure heatmap", exact: true })
    .locator("tbody tr")
    .first()
    .locator("td")
    .first()
    .innerText();
  if (!/\(-?[0-9.]+\)/.test(patternValue))
    throw new Error("Expected robust SEs beside loadings");
  if (patternValue === structureValue)
    throw new Error(
      "Expected distinct oblique pattern and structure values in this fixture.",
    );
  await dialog.getByRole("button", { name: "Pattern", exact: true }).click();
  const csvDownload = page.waitForEvent("download");
  await dialog
    .getByRole("button", { name: "Export loadings CSV", exact: true })
    .click();
  const csvFile = await csvDownload;
  const csvText = await readFile(await csvFile.path(), "utf8");
  if (!csvText.includes("pattern_SE_F1") || !csvText.includes(",wlsmv,"))
    throw new Error("Weighted CSV metadata missing");
  await dialog.getByLabel("Saved run", { exact: true }).focus();
  await expect(dialog.getByLabel("Saved run", { exact: true })).toBeFocused();
  await mkdir("scripts/efa-reference/screenshots", { recursive: true });
  await page.screenshot({
    path: "scripts/efa-reference/screenshots/efa-weighted-loadings.png",
  });
  await page
    .getByRole("button", { name: "Compare promax", exact: true })
    .click();
  await expect(dialog.getByText(/Aligned comparison/)).toBeVisible({
    timeout: 30000,
  });
  await expect(dialog.getByLabel("Loading color legend")).toBeVisible();
  if ((await dialog.locator('[aria-label^="Comparison F1:"]').count()) !== 8)
    throw new Error("Expected separately colored comparison loading cells.");
  await page
    .getByLabel("Note item1", { exact: true })
    .fill("Keep content coverage under review.");
  await page
    .getByLabel("Review item1", { exact: true })
    .selectOption("exclude");
  await page
    .getByRole("button", { name: "Refit selection", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      window.__scatterlabBridge.current.snapshot().datasets[0].efa.runs
        .length === 3,
  );
  const baseline = await page.evaluate(
    () => window.__scatterlabBridge.current.snapshot().datasets[0].efa.runs[0],
  );
  await page
    .getByRole("button", { name: "Add scores to dataset", exact: true })
    .click();
  await page.waitForFunction(() =>
    window.__scatterlabBridge.current
      .snapshot()
      .datasets[0].table.columns.some((c) => c.startsWith("FA1_")),
  );
  await page
    .getByRole("button", { name: "Pair sample sizes", exact: true })
    .click();
  await dialog.getByLabel("First row").first().fill("7");
  await page
    .getByRole("button", { name: "Factor correlations", exact: true })
    .click();
  await expect(dialog.getByLabel("First row").first()).toHaveValue("1");
  await mkdir("scripts/efa-reference/screenshots", { recursive: true });
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
      path: `scripts/efa-reference/screenshots/efa-weighted-${theme}.png`,
    });
  }
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await page
    .getByText("Create or choose a development / holdout split", {
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "Save split membership" }).click();
  await page
    .getByRole("button", { name: "Preview sample", exact: true })
    .click();
  await page.getByRole("button", { name: "Run EFA", exact: true }).click();
  await expect(dialog).toBeVisible({ timeout: 30000 });
  await page
    .getByRole("button", { name: "Compare on holdout", exact: true })
    .click();
  await expect(dialog.getByText(/Structure replication ·/)).toBeVisible({
    timeout: 30000,
  });
  const snapshot = await page.evaluate(() =>
    window.__scatterlabBridge.current.snapshot(),
  );
  if (
    snapshot.datasets[0].efa.runs.some(
      (r) => r.spec.extraction !== "wlsmv" || !r.result.weighted?.robust,
    )
  )
    throw new Error("Weighted fit metadata was lost in a derived run");
  if (snapshot.datasets[0].efa.runs.length !== 5)
    throw new Error(
      "Expected baseline, rotation, item refit, development and holdout runs.",
    );
  if (!snapshot.datasets[0].efa.splits[0].holdoutOpenedAt)
    throw new Error("Holdout view history was not recorded.");
  await page.evaluate(async () =>
    window.__scatterlabBridge.current.saveWorkspaceAs(
      "Weighted EFA browser qualification",
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
              .get("Weighted EFA browser qualification");
          request.onsuccess = () => {
            resolve(request.result.payload);
            db.close();
          };
        };
      }),
  );
  await writeFile(
    "/tmp/scatter-efa-weighted-workspace.json",
    JSON.stringify(saved),
  );
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            new Promise((resolve) => {
              const open = indexedDB.open("scatter-lab");
              open.onsuccess = () => {
                const db = open.result,
                  request = db
                    .transaction("session")
                    .objectStore("session")
                    .get("current");
                request.onsuccess = () => {
                  resolve(
                    request.result?.payload?.datasets?.[0]?.efa?.runs?.length ??
                      0,
                  );
                  db.close();
                };
              };
            }),
        ),
      { timeout: 10000 },
    )
    .toBe(5);
  await page.reload();
  await page.waitForFunction(
    () => window.__scatterlabBridge?.current,
    {},
    { timeout: 30000 },
  );
  await page.waitForFunction(
    () =>
      window.__scatterlabBridge?.current?.snapshot().datasets[0]?.efa?.runs
        .length === 5,
    {},
    { timeout: 10000 },
  );
  // Named workspace loading also exercises the explicit import/validation path.
  await page
    .getByText("Weighted EFA browser qualification", { exact: true })
    .click();
  await page.waitForFunction(
    () =>
      window.__scatterlabBridge?.current?.snapshot().datasets[0]?.efa?.runs
        .length === 5,
    {},
    { timeout: 30000 },
  );
  await writeFile(
    "scripts/efa-reference/weighted-ui-verification.json",
    JSON.stringify(
      {
        status: failures.length ? "failed" : "passed",
        recordedAt: new Date().toISOString(),
        estimator: "wlsmv",
        runs: 5,
        baselineItems: baseline.spec.items.length,
        themes: ["primary", "terminal"],
        checks: [
          "pattern and structure heatmaps with distinct values",
          "separate comparison heatmap cells and shared scale",
          "WLSMV preflight allocation/work estimate",
          "robust SE cells and CSV metadata",
          "weighted raw/corrected tests and provenance",
          "preview",
          "fit",
          "rotation comparison",
          "item reviews/refit",
          "scores",
          "holdout replication/history",
          "workspace reload",
          "Escape dismissal",
          "long item identifiers",
          "keyboard focus",
          "matrix pagination resets across views",
        ],
        pageErrors: failures,
      },
      null,
      2,
    ) + "\n",
  );
  if (failures.length) throw new Error(failures.join("\n"));
  console.log("Weighted EFA browser workflow passed.");
} catch (error) {
  if (page) {
    console.log(
      JSON.stringify({
        pageErrors: failures,
        body: (await page.locator("body").innerText()).slice(0, 2400),
        guard: await page.evaluate(() =>
          localStorage.getItem("scatterlab.session.restoreGuard"),
        ),
      }),
    );
    await page.screenshot({ path: "/tmp/scatter-efa-weighted-ui-failure.png" });
  }
  throw error;
} finally {
  await browser.close();
}
