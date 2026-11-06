// Preserve the executed supervisor's raw receipt; annotate unavailable memory
// sampling and independently reconstruct the deterministic missing masks.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const folder = 'scripts/efa-reference/congruence';
const receipt = JSON.parse(await readFile(`${folder}/attempts/large-benchmark-receipt.raw.json`, 'utf8'));
receipt.driverSha256 = createHash('sha256').update(await readFile(`${folder}/attempts/large-driver-executed.mjs`)).digest('hex');
receipt.rawReceiptSha256 = createHash('sha256').update(await readFile(`${folder}/attempts/large-benchmark-receipt.raw.json`)).digest('hex');
receipt.scope = 'One sequential Node CPU execution per configuration on a shared workstation with a dev server and some short UI/lint checks during early runs. Not an idle controlled experiment, browser response measurement, R speed comparison, or speedup claim.';
for (const result of receipt.results) {
  const native = JSON.parse(await readFile(result.report, 'utf8'));
  if (result.sampledPeakRssKiB === 0) {
    result.sampledPeakRssKiB = null;
    result.measurementFailure = 'External ps process sampling was unavailable in the workspace sandbox (operation not permitted); zero in the raw supervisor receipt was an unfilled accumulator, not measured memory.';
  }
  result.childReportedRssKiB = native.peakRssKiB;
  result.rssQualification = native.status === 'passed' ? 'process.resourceUsage maxRSS over the completed child run' : 'Last reported process.resourceUsage maxRSS; lower bound on full-run peak at forced timeout';
  result.memoryCapQualification = '4GiB V8 heap limit; optional3GiB external RSS stop was unavailable because ps was denied. Observed child reports stayed below0.5GiB; no stronger transient RSS bound is claimed.';
}
function randomGenerator(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
receipt.missingMasks = [];
for (const method of ['fiml-block','fiml-fragmented']) {
  const mask = new Uint8Array(20000 * 500), random = randomGenerator(73291);
  let count = 0;
  for (let j=0;j<500;j++) for (let i=0;i<20000;i++) if (method === 'fiml-block' ? (i%3===1&&j<50)||(i%3===2&&j>=450) : random()<.05) { mask[j*20000+i]=1;count++; }
  const native = JSON.parse(await readFile(`${folder}/large-${method}-report.json`,'utf8'));
  if(count!==native.missingCells) throw new Error(`Mask count mismatch ${method}`);
  receipt.missingMasks.push({ method, missingCells:count, fraction:count/mask.length, encoding:'10,000,000 column-major bytes,1missing0observed', sha256:createHash('sha256').update(mask).digest('hex'), generator:method==='fiml-block'?'i mod3; first50/last50missing':'mulberry32 seed73291; j outer/i inner; draw<.05' });
}
await writeFile(`${folder}/large-benchmark-receipt.json`,JSON.stringify(receipt,null,2)+'\n');
