import { chromium } from "@playwright/test";
import { writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

const url =
    process.argv[2] ??
    "http://localhost:3000/efa-qualification/large-mice/large-imputation.html",
  output =
    process.argv[3] ?? "scripts/efa-reference/large-imputation-benchmark.json",
  bundle = process.argv[4] ?? "public/efa-qualification/large-mice/worker.js";
const workerSha256 = createHash("sha256")
    .update(await readFile(bundle))
    .digest("hex"),
  browser = await chromium.launch({ headless: true, channel: "chrome" }),
  errors = [];
let timer,
  memoryTimer,
  peakRssBytes = 0,
  cancelMs;
const hardware = {
  cpu: os.cpus()[0].model,
  architecture: os.arch(),
  systemMemoryBytes: os.totalmem(),
};
try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.getByRole("button", { name: "Run large imputation" }).click();
  await page.waitForFunction(
    () => document.querySelector("#stage")?.textContent?.includes("MICE"),
    {},
    { timeout: 300000 },
  );
  const ticks = Number(await page.locator("#heartbeat").textContent());
  await page.waitForFunction(
    (n) => Number(document.querySelector("#heartbeat")?.textContent) > n + 3,
    ticks,
    { timeout: 2000 },
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector("#output")?.textContent?.startsWith("{"),
  );
  cancelMs = Number(await page.locator("#cancelTime").textContent());
  const cancelled = JSON.parse(await page.locator("#output").textContent());
  if (cancelMs >= 1000 || cancelled.status !== "cancelled")
    throw new Error(
      `Cancellation check failed: ${cancelMs} ms, ${JSON.stringify(cancelled)}`,
    );
  await page.getByRole("button", { name: "Run large imputation" }).click();
  const cdp = await browser.newBrowserCDPSession(),
    exec = promisify(execFile);
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
          .reduce((n, v) => n + Number(v), 0) * 1024,
      );
    } catch {}
  }, 5000);
  timer = setInterval(async () => {
    try {
      const stage = JSON.parse(await page.locator("#stage").textContent());
      console.log(JSON.stringify(stage));
      await writeFile(
        output.replace(/\.json$/, ".progress.json"),
        JSON.stringify(
          {
            recordedAt: new Date().toISOString(),
            stage,
            workerSha256,
            peakRssBytes,
            cancelMs,
          },
          null,
          2,
        ) + "\n",
      );
    } catch {}
  }, 30000);
  await page.waitForFunction(
    () => document.querySelector("#output")?.textContent?.startsWith("{"),
    {},
    { timeout: 28800000 },
  );
  const report = {
    ...JSON.parse(await page.locator("#output").textContent()),
    cancelMs,
    pageErrors: errors,
    workerSha256,
    memory: {
      peakBrowserProcessRssBytes: peakRssBytes,
      method:
        "5-second summed RSS samples for this isolated browser tree; shared pages may be counted repeatedly",
    },
    hardware,
    environment:
      "Executed alongside the separate four-worker 500-item parallel-analysis qualification batch; wall times include that resource contention.",
  };
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      status: report.status,
      completed: report.completed,
      error: report.error,
      elapsedMs: report.elapsedMs,
      cancelMs,
      peakRssBytes,
    }),
  );
  if (report.status !== "passed" || errors.length) process.exitCode = 1;
} catch (error) {
  const report = {
    status: "runner-failed",
    recordedAt: new Date().toISOString(),
    error: String(error),
    workerSha256,
    peakRssBytes,
    cancelMs,
    pageErrors: errors,
    hardware,
  };
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.error(JSON.stringify(report));
  process.exitCode = 1;
} finally {
  clearInterval(timer);
  clearInterval(memoryTimer);
  await browser.close();
}
