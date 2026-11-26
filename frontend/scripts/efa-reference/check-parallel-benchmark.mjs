import { chromium } from "@playwright/test";
import { writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const output =
  process.argv[3] ?? "scripts/efa-reference/parallel-benchmark.json";
let timer,
  memoryTimer,
  peakRssBytes = 0;
const workerSha256 = createHash("sha256")
  .update(await readFile("public/efa-qualification/worker.js"))
  .digest("hex");
try {
  const page = await browser.newPage();
  await page.goto(
    process.argv[2] ?? "http://localhost:3000/efa-qualification/parallel.html",
  );
  await page.getByRole("button", { name: "Run batch" }).click();
  await page.waitForFunction(
    () => document.querySelector("#stage")?.textContent?.includes("MINRES"),
    {},
    { timeout: 120000 },
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
  const cancelMs = Number(await page.locator("#cancelTime").textContent());
  if (cancelMs >= 1000)
    throw new Error(`Parallel cancellation exceeded one second: ${cancelMs}`);
  await page.getByRole("button", { name: "Run batch" }).click();
  const cdp = await browser.newBrowserCDPSession(),
    exec = promisify(execFile);
  memoryTimer = setInterval(async () => {
    try {
      const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
      const { stdout } = await exec("ps", [
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
      const stage = await page.locator("#stage").textContent();
      console.log(stage);
      await writeFile(
        output.replace(/\.json$/, ".progress.json"),
        JSON.stringify(
          {
            recordedAt: new Date().toISOString(),
            stage: JSON.parse(stage),
            heartbeat: await page.locator("#heartbeat").textContent(),
            cancelMs,
            workerSha256,
            peakRssBytes,
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
    workerSha256,
    memory: {
      peakBrowserProcessRssBytes: peakRssBytes,
      method:
        "5-second summed RSS samples for the isolated browser process tree; shared pages may be counted repeatedly",
    },
    hardware: {
      cpu: os.cpus()[0].model,
      architecture: os.arch(),
      systemMemoryBytes: os.totalmem(),
    },
  };
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      status: report.status,
      elapsedMs: report.elapsedMs,
      completed: report.result?.completed,
      failures: report.result?.failures,
      suggested: report.result?.suggested,
    }),
  );
  if (report.status !== "passed") process.exitCode = 1;
} finally {
  clearInterval(timer);
  clearInterval(memoryTimer);
  await browser.close();
}
