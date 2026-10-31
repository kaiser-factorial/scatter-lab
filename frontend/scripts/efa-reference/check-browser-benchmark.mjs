import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  const page = await browser.newPage();
  await page.goto(
    `${process.argv[2] ?? "http://localhost:3000"}/efa-qualification/index.html`,
  );
  await page.getByRole("button", { name: "Run 500" }).click();
  const cdp = await browser.newBrowserCDPSession(),
    exec = promisify(execFile);
  let peakRssBytes = 0;
  const memoryTimer = setInterval(async () => {
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
  }, 1000);
  await page.waitForFunction(
    () =>
      document.querySelector("#stage")?.textContent?.includes("Correlations"),
    {},
    { timeout: 60000 },
  );
  const before = Number(await page.locator("#heartbeat").textContent());
  await page.waitForFunction(
    (n) => Number(document.querySelector("#heartbeat")?.textContent) > n + 5,
    before,
    { timeout: 2000 },
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const cancelMs = Number(await page.locator("#cancelTime").textContent());
  if (cancelMs >= 1000) throw new Error(`Cancellation took ${cancelMs}ms`);
  await page.waitForFunction(() =>
    document.querySelector("#stage")?.textContent?.includes("cancelled"),
  );
  console.log(
    `Cancellation passed: ${cancelMs}ms; UI heartbeat advanced during correlation estimation.`,
  );
  await page.getByRole("button", { name: "Run 500" }).click();
  const monitor = setInterval(async () => {
    try {
      console.log(await page.locator("#stage").textContent());
    } catch {}
  }, 30000);
  try {
    await page.waitForFunction(
      () => document.querySelector("#output")?.textContent?.startsWith("{"),
      {},
      { timeout: 1800000 },
    );
  } finally {
    clearInterval(monitor);
    clearInterval(memoryTimer);
  }
  const report = {
    ...JSON.parse(await page.locator("#output").textContent()),
    cancelMs,
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
  };
  if (report.status === "passed")
    await writeFile(
      "/tmp/scatter-efa-large-fixture.json",
      await page.evaluate(() => JSON.stringify(window.efaLargeFixture)),
    );
  await writeFile(
    "scripts/efa-reference/browser-benchmark.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
  if (report.status !== "passed") process.exitCode = 1;
} finally {
  await browser.close();
}
