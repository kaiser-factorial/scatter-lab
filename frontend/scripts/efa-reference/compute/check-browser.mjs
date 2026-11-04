import { chromium } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const workerSha256 = createHash('sha256').update(await readFile('public/efa-qualification/compute/worker.js')).digest('hex');
try {
  const page = await browser.newPage();
  await page.goto("http://localhost:3000/efa-qualification/compute/index.html");
  await page.getByRole("button", { name: "Run kernels" }).click();
  await page.waitForFunction(() => document.querySelector('#stage').textContent.includes('gpu'), {}, { timeout: 180000 });
  const heartbeat = Number(await page.locator('#heartbeat').textContent());
  await page.waitForFunction(n => Number(document.querySelector('#heartbeat').textContent) >= n + 5, heartbeat);
  if (await page.locator('#output').textContent() !== "running") throw new Error("Job ended before active cancellation could be measured");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const cancelMs = Number(await page.locator('#cancel-time').textContent());
  if (cancelMs >= 1000) throw new Error("Cancellation exceeded one second");
  await page.waitForTimeout(200);
  if (await page.locator('#output').textContent() !== "cancelled") throw new Error("Cancelled worker published a late result");
  await page.getByRole("button", { name: "Run kernels" }).click();
  await page.waitForFunction(() => document.querySelector('#output').textContent.startsWith('{'), {}, { timeout: 600000 });
  const report = JSON.parse(await page.locator('#output').textContent());
  Object.assign(report, { recordedAt: new Date().toISOString(), workerSha256, cancelMs, cancellationScope: "Worker termination acknowledgement, not measurement of GPU command retirement", browserVersion: await browser.version(), hardware: { cpu: os.cpus()[0].model, architecture: os.arch(), memoryBytes: os.totalmem() } });
  await writeFile("scripts/efa-reference/compute/browser-kernels.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, cases: report.results.length, failed: report.results.filter(r => !r.errors.passed).map(r => ({ fixture: r.fixture, backend: r.backend, errors: r.errors })), cancelMs }));
  if (report.status !== "passed") process.exitCode = 1;
} finally { await browser.close(); }
