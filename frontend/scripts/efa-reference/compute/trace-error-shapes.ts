// Synthetic operator study, not participant data and not an EFA timing benchmark.
import { writeFileSync } from 'node:fs';
import { rademacherProbes, summarizeTraceProbes } from '../../../src/lib/efa/trace-estimation';

// Walsh columns are orthonormal; skip the constant column so dense cases are centered.
function walsh(row: number, column: number) { let v = row & column, parity = 0; while (v) { parity ^= 1; v &= v - 1; } return parity ? -1 : 1; }
function norms(n: number, rank: number, probes: Float64Array, count: number, diagonal = false, scale = 1) {
  const values: number[] = Array(count).fill(0);
  for (let f = 0; f < rank; f++) for (let j = 0; j < count; j++) {
    let dot = 0;
    if (diagonal) dot = probes[f * count + j];
    else for (let i = 0; i < n; i++) dot += walsh(i, f + 1) * probes[i * count + j] / Math.sqrt(n);
    values[j] += scale * scale * dot * dot / rank;
  }
  return values;
}
const enumerated = [];
for (const rank of [1, 2, 4, 7]) {
  const n = 8, count = 1 << n, probes = new Float64Array(n * count);
  for (let i = 0; i < n; i++) for (let j = 0; j < count; j++) probes[i * count + j] = j & (1 << i) ? 1 : -1;
  const values = norms(n, rank, probes, count), mean = values.reduce((s,v)=>s+v,0)/count;
  const variance = values.reduce((s,v)=>s+(v-mean)**2,0)/count, theory = 2 * (1/rank - 1/n);
  if (Math.abs(mean-1)>1e-12 || Math.abs(variance-theory)>1e-12) throw Error('Independent exhaustive variance check failed');
  enumerated.push({ rows:n, rank, mean, variance, theoreticalVariance:theory });
}
interface Draw { seed: number; relativeError: number; relativeMonteCarloSE: number; intervalContainsExact: boolean }
interface ShapeResult {
  name: string; n: number; rank: number; scale: number; diagonal: boolean;
  exact: number; count: number; theoreticalRelativeSE: number;
  observedRmsRelativeError: number; medianAbsRelativeError: number;
  maxAbsRelativeError: number | undefined; normalIntervalCoverage: number; draws: Draw[];
}
const seeds = Array.from({length:256},(_,i)=>71001+i), count=128, results: ShapeResult[]=[];
for (const config of [
  {name:'dense rank 1',n:256,rank:1,scale:1,diagonal:false},
  {name:'dense rank 4',n:256,rank:4,scale:1,diagonal:false},
  {name:'dense rank 16',n:256,rank:16,scale:1,diagonal:false},
  {name:'diagonal rank 1',n:256,rank:1,scale:1,diagonal:true},
  {name:'scaled dense rank 1',n:256,rank:1,scale:1e6,diagonal:false},
  {name:'larger dense rank 1',n:4096,rank:1,scale:1,diagonal:false},
]) {
  const exact = config.scale**2, draws: Draw[]=[];
  for(const seed of seeds){
    const values=norms(config.n,config.rank,rademacherProbes(config.n,count,seed),count,config.diagonal,config.scale),summary=summarizeTraceProbes(values);
    draws.push({seed,relativeError:(summary.traceSquared-exact)/exact,relativeMonteCarloSE:summary.monteCarloSE/exact,intervalContainsExact:summary.normalInterval95[0]<=exact&&exact<=summary.normalInterval95[1]});
  }
  const theoreticalRelativeSE=config.diagonal?0:Math.sqrt(2/count*(1/config.rank-1/config.n));
  const abs=draws.map(d=>Math.abs(d.relativeError)).sort((a,b)=>a-b);
  results.push({...config,exact,count,theoreticalRelativeSE,observedRmsRelativeError:Math.sqrt(draws.reduce((s,d)=>s+d.relativeError**2,0)/draws.length),medianAbsRelativeError:(abs[127]+abs[128])/2,maxAbsRelativeError:abs.at(-1),normalIntervalCoverage:draws.filter(d=>d.intervalContainsExact).length/draws.length,draws});
}
const scaleDelta=Math.max(...results[0].draws.map((d,i)=>Math.abs(d.relativeError-results[4].draws[i].relativeError)));
if(scaleDelta>1e-12)throw Error('Relative error changed under scalar multiplication');
const report={status:'passed',recordedAt:new Date().toISOString(),scope:'Synthetic PSD operators H with trace(H squared) normalized except an explicit scale control; not data-derived EFA fits, not timing evidence.',method:'Production seeded Rademacher probes and uncertainty summary; independent orthogonal-factor application; exhaustive all-sign check at N=8.',probes:count,seeds,enumerated,scaleDelta,results,worstCase:{relativeRmsBound:'sqrt(2 / probes * (1 - 1 / rows))',attainedBy:'rank-one H squared with equal diagonal entries; a dense equal-magnitude eigenvector (balanced signs can preserve centering)',qualification:'A bound on RMS Monte Carlo error over independent random probes, not a bound on one run or a rigorous confidence interval.'}};
writeFileSync(process.argv[2]??'scripts/efa-reference/compute/trace-error-shapes-v7.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,scaleDelta,results:results.map(r=>({...r,draws:undefined}))}));
