import { chromium } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
const url =
    process.argv[2] ??
    "http://localhost:3000/efa-qualification/weighted/index.html",
  path =
    process.argv[3] ?? "scripts/efa-reference/weighted-browser-benchmark.json",
  exec = promisify(execFile),
  browser = await chromium.launch({ headless: true, channel: "chrome" });
let monitor,
  memoryTimer,
  peakRssBytes = 0;
try {
  const page = await browser.newPage(),
    cdp = await browser.newBrowserCDPSession();
  await page.goto(url);
  await page.getByRole("button", { name: "Run weighted benchmark" }).click();
  memoryTimer = setInterval(async () => {
    try {
      const { processInfo } = await cdp.send("SystemInfo.getProcessInfo"),
        { stdout } = await exec("ps", [
          "-o",
          "rss=",
          "-p",
          processInfo.map((p) => p.id).join(","),
        ]);
      peakRssBytes = Math.max(
        peakRssBytes,
        stdout
          .trim()
          .split(/\s+/)
          .reduce((sum, v) => sum + Number(v), 0) * 1024,
      );
    } catch {}
  }, 1000);
  const cancellationStage =
    new URL(url).searchParams.get("cancelStage") ?? "Correlations";
  await page.waitForFunction(
    (stage) => document.querySelector("#stage")?.textContent?.includes(stage),
    cancellationStage,
    { timeout: 120000 },
  );
  const before = Number(await page.locator("#heartbeat").textContent());
  await page.waitForFunction(
    (n) => Number(document.querySelector("#heartbeat")?.textContent) > n + 5,
    before,
    { timeout: 3000 },
  );
  const progressAtCancellation = await page.locator("#stage").textContent();
  const outputAtCancellation = await page.locator("#output").textContent();
  if (outputAtCancellation !== "running")
    throw new Error(
      "Benchmark completed before the requested cancellation check; this is not an active-job cancellation measurement.",
    );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const cancelMs = Number(await page.locator("#cancelTime").textContent());
  if (cancelMs >= 1000) throw new Error(`Cancellation took ${cancelMs}ms`);
  if (new URL(url).searchParams.get("cancelOnly") === "true") {
    await writeFile(
      path,
      JSON.stringify(
        {
          status: "cancelled-as-requested",
          scope:
            "Large exact-inference allocation, continued browser interaction, and worker termination only; no completed robust statistic or SE claim",
          recordedAt: new Date().toISOString(),
          cancelMs,
          cancellationStage,
          progressAtCancellation,
          heartbeats: Number(await page.locator("#heartbeat").textContent()),
          browser: await page.evaluate(() => navigator.userAgent),
          hardware: {
            cpu: os.cpus()[0].model,
            architecture: os.arch(),
            systemMemoryBytes: os.totalmem(),
          },
          memory: {
            peakBrowserProcessRssBytes: peakRssBytes,
            method:
              "1-second summed RSS samples; shared pages may be counted more than once",
          },
          workerSha256: createHash("sha256")
            .update(
              await readFile(
                "public/efa-qualification/weighted/weighted-worker.js",
              ),
            )
            .digest("hex"),
          url,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(
      `Large inference cancellation measured: ${cancelMs}ms during ${progressAtCancellation}`,
    );
  } else {
    await page.getByRole("button", { name: "Run weighted benchmark" }).click();
    monitor = setInterval(async () => {
      try {
        const progress = {
          stage: await page.locator("#stage").textContent(),
          recordedAt: new Date().toISOString(),
          peakRssBytes,
        };
        console.log(JSON.stringify(progress));
        await writeFile(
          path.replace(/\.json$/, ".progress.json"),
          JSON.stringify(progress, null, 2) + "\n",
        );
      } catch {}
    }, 30000);
    await page.waitForFunction(
      () => document.querySelector("#output")?.textContent?.startsWith("{"),
      {},
      { timeout: 8 * 60 * 60 * 1000 },
    );
    const report = {
      ...JSON.parse(await page.locator("#output").textContent()),
      cancelMs,
      cancellationStage,
      progressAtCancellation,
      hardware: {
        cpu: os.cpus()[0].model,
        architecture: os.arch(),
        systemMemoryBytes: os.totalmem(),
      },
      memory: {
        peakBrowserProcessRssBytes: peakRssBytes,
        method:
          "1-second samples of summed RSS for this isolated browser process tree; shared pages may be counted more than once",
      },
      workerSha256: createHash("sha256")
        .update(
          await readFile(
            "public/efa-qualification/weighted/weighted-worker.js",
          ),
        )
        .digest("hex"),
      url,
    };
    await writeFile(path, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report));
    if (report.status !== "passed") process.exitCode = 1;
  }
} finally {
  clearInterval(monitor);
  clearInterval(memoryTimer);
  await browser.close();
}
