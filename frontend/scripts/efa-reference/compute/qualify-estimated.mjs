// Production worker/service, synthetic R-reference inputs, no provider calls.
import { build } from 'esbuild';
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { chromium } from '@playwright/test';
const out = 'public/efa-qualification/estimated';
await mkdir(out, { recursive: true });
await build({ entryPoints: ['src/lib/efa/efa.worker.ts'], bundle: true, format: 'esm', outfile: `${out}/efa.worker.js` });
await build({ stdin: { resolveDir: process.cwd(), contents: `
import { EfaService } from './src/lib/efa/service.ts';
import { validateEfaState } from './src/lib/efa/persistence.ts';
import { serializeEfaCsv } from './src/lib/efa/state.ts';
window.run = async () => {
 const service = new EfaService(() => new Worker('./efa.worker.js', { type: 'module' }), 4), results = [];
 for (const name of ['normal','pairwise','complete','skew','heavy-tail']) {
  const input = await (await fetch('./reference/'+name+'.input.json')).json();
  const spec = { items: input.columns.map((column,i) => ({column,categories:input.categories[i],reverse:input.reverse.includes(i)})), nFactors: input.nFactors, extraction:'wlsmv', rotation:'oblimin', missing:input.missing, label:name, seed:73021, sample:{partition:'all'} };
  let origin;
  for (const compute of [{backend:'cpu'}, {backend:'webgpu',correction:'estimated',probes:128,probeSeed:61001}, {backend:'webgpu',correction:'estimated',probes:128,probeSeed:61001}, {backend:'webgpu',correction:'estimated',probes:64,probeSeed:61001}, {backend:'webgpu',correction:'estimated',probes:128,probeSeed:61002}, {backend:'webgpu'}]) {
   const index=results.filter(r=>r.name===name).length, rotation=index===2?'promax':'oblimin';
   const job=service.fit(input,{...spec,compute,rotation},Array.from({length:input.nRows},(_,i)=>i)), result=await job.promise, report=service.report(job.id);
   if(index===1)origin=job.id;
   if(index===2 && result.provenance.execution.reusedFromJobId!==origin)throw Error('Estimated rotation cache not reused');
   if(index!==2 && result.provenance.execution.reusedFromJobId)throw Error('Different correction settings reused stale inference');
   const run={id:job.id,revision:1,createdAt:new Date().toISOString(),datasetRevision:'synthetic',spec:{...spec,compute,rotation},result,eligibleRows:Array.from({length:input.nRows},(_,i)=>i),kind:'fit',reviews:{},reasons:'qualification',revisedAfterHoldout:false,scoreColumns:[]};
   const saved={runs:[run],splits:[]};validateEfaState(JSON.parse(JSON.stringify(saved)),input.nRows);
   if(index===1) {
    const csv=serializeEfaCsv(run);if(!csv.includes('mv_correction')||!csv.includes(',estimated,128,61001,'))throw Error('CSV lost approximation metadata');
    for(const mutate of [r=>delete r.result.weighted.robust.test.traceEstimation,r=>r.spec.compute.probeSeed++,r=>r.result.weighted.robust.test.traceEstimation.probes--,r=>r.result.weighted.robust.test.traceEstimation.normalInterval95[0]--,r=>r.spec.compute.correction='exact']) {
     const bad=structuredClone(saved);mutate(bad.runs[0]);let rejected=false;try{validateEfaState(bad,input.nRows);}catch{rejected=true;}if(!rejected)throw Error('Malformed estimate imported');
    }
   }
   results.push({name,index,compute,rotation,result,report});
  }
 }
 return results;
};` }, bundle: true, format: 'esm', outfile: `${out}/client.js` });
await cp('src/lib/__tests__/fixtures/efa-weighted', `${out}/reference`, { recursive: true });
await writeFile(`${out}/index.html`, '<!doctype html><html lang="en"><title>Estimated MV qualification</title><script type="module" src="./client.js"></script></html>');
const browser=await chromium.launch({channel:'chrome',headless:true});
const output=process.argv[2]??'scripts/efa-reference/compute/estimated-workflow-v6.json';
try {
 const page=await browser.newPage(), worker=await readFile(`${out}/efa.worker.js`);
 await page.route('**/efa.worker.js',route=>route.fulfill({body:worker,contentType:'text/javascript'}));
 await page.goto('http://localhost:3000/efa-qualification/estimated/index.html');await page.waitForFunction(()=>window.run);
 const results=await page.evaluate(()=>window.run()), comparisons=[];
 const error=(a,b)=>Array.isArray(a)?Math.max(0,...a.map((v,i)=>error(v,b[i]))):Math.abs(a-b);
 const pilot=JSON.parse(await readFile('scripts/efa-reference/compute/trace-estimation-pilot-release-v5.json','utf8'));
 for(const r of results) {
  if(r.index===0||r.rotation!=='oblimin')continue;
  const base=results.find(v=>v.name===r.name&&v.index===0).result;
  const c={fixture:r.name,index:r.index,loadings:error(base.rotation.pattern,r.result.rotation.pattern),standardErrors:error(base.weighted.robust.standardErrors.pattern,r.result.weighted.robust.standardErrors.pattern),trace:error(base.weighted.robust.test.trace,r.result.weighted.robust.test.trace),selfCheck:r.result.provenance.execution.selfCheck};
  if(r.compute.correction==='estimated') {
   const ref=pilot.results.find(v=>v.fixture===r.name).estimates.find(v=>v.seed===r.compute.probeSeed&&v.probes===r.compute.probes);
   c.traceEstimateDelta=Math.abs(ref.traceSquared-r.result.weighted.robust.test.traceSquared);
   if(c.traceEstimateDelta>1e-9)throw Error('Probe stream or operator differs from qualified reference');
   if(!r.report.traceEstimation||r.report.traceEstimation.probes!==r.compute.probes)throw Error('Inspector lost estimate');
  }
  if(c.loadings>1e-3||c.standardErrors>1e-4||c.trace>1e-4||!c.selfCheck.passed||c.selfCheck.maxScaledError>1e-10)throw Error('Numerical comparison failed');
  comparisons.push(c);
 }
 const sha=createHash('sha256').update(worker).digest('hex'),archive=`scripts/efa-reference/compute/archives/${sha}.js.gz`;
 await writeFile(archive,gzipSync(worker),{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});
 const flags=(await(await browser.newBrowserCDPSession()).send('Browser.getBrowserCommandLine')).arguments.filter(x=>/webgpu|dawn/i.test(x));if(flags.length)throw Error('Developer flags');
 await writeFile(output,JSON.stringify({status:'passed',recordedAt:new Date().toISOString(),browser:browser.version(),flags,workerSha256:sha,workerArchive:archive,comparisons,results},null,2)+'\n');
 console.log(JSON.stringify({status:'passed',fits:results.length,comparisons:comparisons.length}));
} catch(error){await writeFile(output,JSON.stringify({status:'failed',error:String(error)},null,2));throw error;}finally{await browser.close();}
