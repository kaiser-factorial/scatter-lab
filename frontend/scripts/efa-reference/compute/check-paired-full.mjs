// Cold paired production-service fits; synthetic data only, no full CPU fit.
import { build } from 'esbuild';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { chromium } from '@playwright/test';
const mode=process.argv[2]??'pilot',output=process.argv[3]??`scripts/efa-reference/compute/paired-full-${mode}-v7.json`;
if(!['pilot','large'].includes(mode))throw Error('Choose pilot or large');
if(!output.endsWith('.json'))throw Error('Choose a .json report path');
for(const path of [output, `${output}.gz`]){try{await access(path);throw Error(`Preserve existing evidence: ${path}`);}catch(e){if(e.code!=='ENOENT')throw e;}}
const out='public/efa-qualification/paired-full';await mkdir(out,{recursive:true});
await build({entryPoints:['src/lib/efa/efa.worker.ts'],bundle:true,format:'esm',outfile:`${out}/efa.worker.js`});
await build({stdin:{resolveDir:process.cwd(),loader:'ts',contents:`
import { EfaService } from './src/lib/efa/service.ts';
import { benchmarkData } from './scripts/efa-reference/benchmark-data.ts';
window.run=async(options)=>{
 const t=performance.now(),{table,spec:base}=benchmarkData(options.n,options.p),rows=Array.from({length:table.nRows},(_,i)=>i),dataGenerationMs=performance.now()-t;
 const service=new EfaService(()=>new Worker('./efa.worker.js',{type:'module'}),4),results=[],start=performance.now();let current,firstJob,correlation,inputSha256,scores;
 window.progress={stage:'Starting',completed:0,total:1};
 service.subscribe(()=>{if(current)window.progress={...current.progress,jobStatus:current.status,rotation:window.activeRotation,elapsedMs:performance.now()-start};});
 for(const rotation of ['oblimin','promax','varimax']){
  window.activeRotation=rotation;
  const spec={...base,extraction:'wlsmv',rotation,compute:{backend:'webgpu',correction:options.correction,blockSize:128,memoryMiB:1536,...(options.correction==='estimated'?{probes:128,probeSeed:61001}:{})}};
  const before=performance.now();current=service.fit(table,spec,rows);const result=await current.promise,elapsedMs=performance.now()-before,report=service.report(current.id);
  if(rotation==='oblimin'){firstJob=current.id;inputSha256=result.provenance.inputSha256;correlation=result.correlation.matrix;if(result.provenance.execution.reusedFromJobId)throw Error('Initial fit reused inference');}
  else if(result.provenance.execution.reusedFromJobId!==firstJob)throw Error('Rotation invariant cache not reused');
  if(report.status!=='completed'||!result.provenance.execution.selfCheck?.passed)throw Error('Incomplete or unchecked fit');
  results.push({rotation,elapsedMs,report,extraction:result.extraction,pattern:result.rotation.pattern,phi:result.rotation.phi,communalities:result.communalities,rotationConvergence:result.rotation.convergence,weighted:result.weighted,provenance:result.provenance});
  if(rotation==='oblimin'){
   const run={id:current.id,revision:1,createdAt:new Date().toISOString(),datasetRevision:'synthetic',spec,result,eligibleRows:rows,kind:'fit',reviews:{},reasons:'paired benchmark',revisedAfterHoldout:false,scoreColumns:[]};
   const before=performance.now();current=service.scores(table,run);const values=await current.promise;scores={elapsedMs:performance.now()-before,report:service.report(current.id),values};
  }
 }
 return{status:'completed',dimensions:{rows:options.n,items:options.p,factors:base.nFactors},correction:options.correction,inputSha256,dataGenerationMs,totalMs:performance.now()-start,results,correlation,scores,scope:'Cold production-service oblimin fit including preparation, correlations, extraction, numerical self-checks, inference and rotated SEs; then scores and cached promax/varimax. Browser launch and synthetic data generation excluded.'};
};`},bundle:true,format:'esm',outfile:`${out}/client.js`});
await writeFile(`${out}/index.html`,'<!doctype html><html lang="en"><title>Paired full EFA benchmark</title><p id="heartbeat">0</p><script>window.heartbeat={count:0,maxGapMs:0};let last=performance.now();setInterval(()=>{let now=performance.now();window.heartbeat.maxGapMs=Math.max(window.heartbeat.maxGapMs,now-last);last=now;document.querySelector("#heartbeat").textContent=++window.heartbeat.count},50)</script><script type="module" src="./client.js"></script></html>');
const snapshots={};for(const name of ['efa.worker','client']){const bytes=await readFile(`${out}/${name}.js`),sha256=createHash('sha256').update(bytes).digest('hex'),archive=`scripts/efa-reference/compute/archives/${sha256}.js.gz`;await writeFile(archive,gzipSync(bytes),{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});snapshots[name]={bytes,sha256,archive};}
const report={status:'running',startedAt:new Date().toISOString(),hardware:{cpu:os.cpus()[0].model,architecture:os.arch(),memoryBytes:os.totalmem()},order:['exact','estimated'],options:{n:mode==='large'?20000:1000,p:mode==='large'?500:20,probes:128,seed:61001},snapshots:Object.fromEntries(Object.entries(snapshots).map(([k,{sha256,archive}])=>[k,{sha256,archive}])),arms:[],qualification:'One sequential pair on one machine; fresh browser and service for each arm. Other user applications may remain active; not a controlled idle-machine repetition study.'};
const save=()=>writeFile(output,JSON.stringify(report,null,2)+'\n');await save();const exec=promisify(execFile);
try{for(const correction of report.order){
 const browser=await chromium.launch({channel:'chrome',headless:true});let timer,memoryTimer,peakRss=0,samples=0,samplingErrors=0,served=0;
 try{
  const cdp=await browser.newBrowserCDPSession(),args=(await cdp.send('Browser.getBrowserCommandLine')).arguments,flags=args.filter(x=>/webgpu|dawn/i.test(x));if(flags.length)throw Error('Unexpected GPU developer flags');
  const page=await browser.newPage();await page.route('**/efa.worker.js',route=>{served++;return route.fulfill({body:snapshots['efa.worker'].bytes,contentType:'text/javascript'});});await page.route('**/client.js',route=>route.fulfill({body:snapshots.client.bytes,contentType:'text/javascript'}));
  await page.goto('http://localhost:3000/efa-qualification/paired-full/index.html');await page.waitForFunction(()=>window.run);
  const arm={correction,status:'running',startedAt:new Date().toISOString(),browser:browser.version(),webgpuRuntimeFlags:flags};report.arms.push(arm);await save();
  timer=setInterval(async()=>{try{const progress=await page.evaluate(()=>window.progress);await writeFile(output.replace('.json','.progress.json'),JSON.stringify({correction,recordedAt:new Date().toISOString(),progress,peakRss},null,2));console.log(JSON.stringify({correction,progress}));}catch(e){console.error(String(e));}},30000);
  memoryTimer=setInterval(async()=>{try{const{processInfo}=await cdp.send('SystemInfo.getProcessInfo');const{stdout}=await exec('ps',['-o','rss=','-p',processInfo.map(p=>p.id).join(',')]);peakRss=Math.max(peakRss,stdout.trim().split(/\s+/).reduce((s,v)=>s+Number(v),0)*1024);samples++;}catch{samplingErrors++;}},2000);
  const result=await page.evaluate(options=>window.run(options),{...report.options,correction});Object.assign(arm,{status:'completed',completedAt:new Date().toISOString(),result,workerSnapshotsServed:served,heartbeat:await page.evaluate(()=>window.heartbeat),memory:{peakBrowserProcessRssBytes:peakRss,samples,samplingErrors,method:'2-second RSS sum across benchmark Chrome processes; shared pages can be counted more than once'}});await save();console.log(JSON.stringify({correction,status:arm.status,totalMs:result.totalMs,firstFitMs:result.results[0].elapsedMs}));
 }finally{clearInterval(timer);clearInterval(memoryTimer);await browser.close();}
}
 const[a,b]=report.arms.map(x=>x.result);if(a.inputSha256!==b.inputSha256)throw Error('Paired input hashes differ');
 const difference=(a,b)=>{if(Array.isArray(a)&&Array.isArray(b)&&a.length===b.length){let e=0;for(let i=0;i<a.length;i++)e=Math.max(e,difference(a[i],b[i]));return e;}if(a===null&&b===null)return 0;if(typeof a==='number'&&typeof b==='number'&&Number.isFinite(a)&&Number.isFinite(b))return Math.abs(a-b);throw Error('Invalid comparison shape or nonfinite value');};
 const parity={correlation:difference(a.correlation,b.correlation),scores:difference(a.scores.values,b.scores.values),rotations:[]};for(let i=0;i<3;i++){const x=a.results[i],y=b.results[i],se=Object.fromEntries(['pattern','structure','phi','communalities'].map(k=>[k,difference(x.weighted.robust.standardErrors[k],y.weighted.robust.standardErrors[k])]));parity.rotations.push({rotation:x.rotation,loadings:difference(x.pattern,y.pattern),phi:difference(x.phi,y.phi),communalities:difference(x.communalities,y.communalities),standardErrors:se,trace:Math.abs(x.weighted.robust.test.trace-y.weighted.robust.test.trace)});}
 const values=[parity.correlation,parity.scores,...parity.rotations.flatMap(r=>[r.loadings,r.phi,r.communalities,r.trace,...Object.values(r.standardErrors)])];if(values.some(v=>v>1e-10))throw Error('Unchanged-output parity failed');
 const x=a.results[0].weighted.robust.test,y=b.results[0].weighted.robust.test;report.comparison={parity,tolerance:1e-10,totalSpeedup:a.totalMs/b.totalMs,firstFitSpeedup:a.results[0].elapsedMs/b.results[0].elapsedMs,traceSquaredRelativeError:(y.traceSquared-x.traceSquared)/x.traceSquared,correctionDelta:Object.fromEntries(['traceSquared','scalingFactor','shift','statistic','pValue'].map(k=>[k,y[k]-x[k]])),exactTraceInEstimatedInterval:y.traceEstimation.normalInterval95[0]<=x.traceSquared&&x.traceSquared<=y.traceEstimation.normalInterval95[1]};report.status='passed';report.completedAt=new Date().toISOString();await save();console.log(JSON.stringify({status:report.status,comparison:report.comparison}));
}catch(error){report.status='failed';report.error=String(error);await save();throw error;}
