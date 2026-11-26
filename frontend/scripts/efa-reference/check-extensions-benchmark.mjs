import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import os from "node:os";
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  const page = await browser.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(
    process.argv[2]?.endsWith(".html")
      ? process.argv[2]
      : `${process.argv[2] ?? "http://localhost:3000"}/efa-qualification/extensions.html`,
  );
  await page.getByRole("button", { name: "Run extensions" }).click();
  await page.waitForFunction(
    () => document.querySelector("#output")?.textContent?.startsWith("{"),
    {},
    { timeout: 300000 },
  );
  const report = {
    ...JSON.parse(await page.locator("#output").textContent()),
    pageErrors: errors,
    hardware: {
      cpu: os.cpus()[0].model,
      architecture: os.arch(),
      systemMemoryBytes: os.totalmem(),
    },
  };
  await writeFile(
    process.argv[3] ??
      "scripts/efa-reference/extensions-browser-benchmark.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
  if (report.status !== "passed" || errors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
