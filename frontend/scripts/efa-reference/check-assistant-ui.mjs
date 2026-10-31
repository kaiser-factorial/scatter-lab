import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
await build({
  entryPoints: ["scripts/efa-reference/assistant-replay.ts"],
  bundle: true,
  format: "iife",
  outfile: "/tmp/scatter-efa-assistant-replay.js",
});
const input = JSON.parse(
  await readFile("src/lib/__tests__/fixtures/efa/mixed.input.json", "utf8"),
);
const spec = {
  items: input.columns.map((column, i) => ({
    column,
    categories: input.categories[i],
    reverse: false,
  })),
  extraction: "wlsmv",
  nFactors: 2,
  rotation: "oblimin",
  missing: "pairwise",
  seed: 73021,
  label: "Assistant baseline",
  sample: { partition: "all" },
};
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const errors = [],
  requests = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
      requests.push(url.origin);
      return route.abort();
    }
    return route.continue();
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
          name: "Synthetic assistant qualification",
          dataMode: "private",
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
  await page.addScriptTag({ path: "/tmp/scatter-efa-assistant-replay.js" });
  const action = (name, args = {}) =>
    page.evaluate(({ name, args }) => window.efaReplayAction(name, args), {
      name,
      args,
    });
  const fit = await action("run_efa", { spec });
  if (!fit.jobId) throw new Error(JSON.stringify(fit));
  let completion;
  await expect
    .poll(
      async () => {
        completion = await action("efa_job", { jobId: fit.jobId });
        return completion.status;
      },
      { timeout: 30000 },
    )
    .toBe("completed");
  const baseline = completion.runId;
  await page.getByRole("button", { name: /Open EFA results/ }).click();
  const dialog = page.getByRole("dialog", { name: /EFA · Assistant baseline/ });
  await expect(dialog).toBeVisible();
  const item = await action("get_efa_items", { runId: baseline, limit: 2 });
  if (
    item.items.length !== 2 ||
    !item.items[0].standardErrors ||
    item.nextOffset !== 2
  )
    throw new Error("Missing bounded weighted item output");
  const before = await page.evaluate(() =>
    window.__scatterlabBridge.current.snapshot(),
  );
  const edited = await action("update_efa_items", {
    runId: baseline,
    expectedReviewRevision: item.reviewRevision,
    changes: [
      {
        column: "item8",
        status: "exclude",
        note: "Review redundant content before interpreting the candidate.",
      },
    ],
  });
  if (edited.reviewRevision !== 1)
    throw new Error("Review revision not advanced");
  await expect(dialog.getByLabel("Review item8", { exact: true })).toHaveValue(
    "exclude",
  );
  await expect(dialog.getByLabel("Note item8", { exact: true })).toHaveValue(
    "Review redundant content before interpreting the candidate.",
  );
  const privateItems = await action("get_efa_items", { runId: baseline });
  if (JSON.stringify(privateItems).includes("Review redundant content"))
    throw new Error("Private note disclosed");
  await dialog
    .getByLabel("Review item1", { exact: true })
    .selectOption("investigate");
  const rejected = await action("update_efa_items", {
    runId: baseline,
    expectedReviewRevision: 1,
    changes: [{ column: "item1", status: "exclude", note: "Stale request" }],
  });
  if (!String(rejected).includes("review-conflict"))
    throw new Error("Stale assistant edit was accepted");
  await expect(dialog.getByLabel("Review item1", { exact: true })).toHaveValue(
    "investigate",
  );
  const refreshed = await action("get_efa_items", {
    runId: baseline,
    limit: 1,
  });
  const refit = await action("refit_efa_selection", {
    runId: baseline,
    expectedReviewRevision: refreshed.reviewRevision,
    label: "Assistant seven-item candidate",
    reasons: "Check redundancy while retaining content coverage",
    keepRows: true,
  });
  await expect
    .poll(
      async () => {
        completion = await action("efa_job", { jobId: refit.jobId });
        return completion.status;
      },
      { timeout: 30000 },
    )
    .toBe("completed");
  const child = completion.runId;
  const comparison = await action("compare_efa", {
    runId: baseline,
    otherRunId: child,
  });
  if (
    comparison.sharedItemCount !== 7 ||
    !comparison.sameRows ||
    comparison.comparison.parentReviewRevision !== 2
  )
    throw new Error("Incorrect immutable refit lineage");
  await dialog.getByLabel("Saved run", { exact: true }).selectOption(child);
  await expect(
    page.getByRole("dialog", { name: /Assistant seven-item candidate/ }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("table", { name: "pattern heatmap", exact: true })
      .locator("tbody tr"),
  ).toHaveCount(7);
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
    }, theme);
    await page.screenshot({
      path: `scripts/efa-reference/screenshots/efa-assistant-${theme}.png`,
    });
  }
  const saved = await page.evaluate(() =>
    window.__scatterlabBridge.current.snapshot(),
  );
  await page.evaluate(
    (s) => window.__scatterlabBridge.current.restore(s),
    before,
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__scatterlabBridge.current.snapshot().datasets[0].efa.runs
            .length,
      ),
    )
    .toBe(1);
  const undone = await action("get_efa_items", {
    runId: baseline,
    columns: ["item8"],
  });
  if (undone.reviewRevision !== 0 || undone.items[0].status !== "retain")
    throw new Error("Undo failed to restore review state");
  await page.evaluate(
    (s) => window.__scatterlabBridge.current.restore(s),
    saved,
  );
  await page.evaluate(() =>
    window.__scatterlabBridge.current.saveWorkspaceAs(
      "Assistant EFA qualification",
    ),
  );
  // Wait for the debounced session record, not merely the React state or named workspace.
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
      { timeout: 15000 },
    )
    .toBe(2);
  await page.reload();
  await page.waitForFunction(
    () =>
      window.__scatterlabBridge?.current?.snapshot().datasets[0]?.efa?.runs
        .length === 2,
    {},
    { timeout: 15000 },
  );
  await page.addScriptTag({ path: "/tmp/scatter-efa-assistant-replay.js" });
  const restored = await action("get_efa_items", {
    runId: baseline,
    columns: ["item8"],
  });
  if (restored.reviewRevision !== 2 || restored.items[0].status !== "exclude")
    throw new Error("Review revisions failed session persistence");
  if (errors.length) throw new Error(errors.join("\n"));
  await writeFile(
    "scripts/efa-reference/assistant-ui-verification.json",
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        status: "passed",
        browser: await browser.version(),
        checks: [
          "Real runAssistantTurn with offline replayTransport and live app bridge",
          "WLSMV worker fit and bounded item/SE reads",
          "Assistant changes visible in review table",
          "User edit causes optimistic revision conflict",
          "Immutable seven-item refit and matched comparison",
          "Private notes withheld",
          "Undo and session reload preserve review semantics",
          "Both themes and pattern heatmap",
        ],
        baseline,
        child,
        externalRequestsBlocked: requests,
        providerCalls: 0,
        pageErrors: errors,
        replayBundleSha256: createHash("sha256")
          .update(await readFile("/tmp/scatter-efa-assistant-replay.js"))
          .digest("hex"),
      },
      null,
      2,
    ) + "\n",
  );
  console.log("Assistant EFA browser workflow passed.");
} finally {
  await browser.close();
}
