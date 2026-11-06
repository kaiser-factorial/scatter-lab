import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const output = process.argv[2] ?? fileURLToPath(new URL('../../../packages/statistics/test/fixtures/public.input.json', import.meta.url));
const range = (n, f = i => i + 1) => Array.from({ length: n }, (_, i) => f(i));
const pairs = [
  { name: 'unequal-groups', a: range(10), b: range(14, i => i + 7) },
  { name: 'outlier', a: range(10), b: [...range(14, i => i + 7), 200] },
  { name: 'tied-ordinal', a: [1, 2, 2, 3, 4, 4, 4, 5], b: [2, 2, 3, 3, 3, 5, 5, 6, 6] },
  { name: 'symmetric-null', a: [-3, -2, -1, 0, 1, 2, 3], b: [-3, -2, -1, 0, 1, 2, 3] },
  { name: 'skewed', a: range(30, i => Math.exp(i / 10)), b: range(25, i => Math.exp(i / 8) + .75) },
  { name: 'heavy-tail', a: [-20, -4, -2, -1, -.2, .1, .4, 1, 2, 7, 35], b: [-16, -5, -1, 0, .5, 2, 4, 9, 10] },
  { name: 'near-null-ecdf', a: range(30), b: range(30, i => i + 1.01) },
  { name: 'tiny-unequal', a: [1, 2], b: [2, 5, 8] },
];
const correlations = [
  { name: 'linear', a: range(10), b: range(10, i => 3 * i + 2) },
  { name: 'negative', a: range(10), b: range(10, i => 13 - 2 * i) },
  { name: 'nonlinear', a: [-3,-2,-1,0,1,2,3], b: [9,4,1,0,1,4,9] },
  { name: 'ties', a: [1,1,2,2,3,3], b: [4,2,2,1,3,3], xi: true },
  { name: 'no-ties-small', a: [3,1,5,2,4], b: [2,5,1,4,3], xi: true },
  { name: 'numeric-strings-missing', a: [1,'2',null,'4','bad',6,7], b: [2,'3',8,1,4,null,9] },
  { name: 'constant', a: [3,3,3,3], b: [1,2,4,5], xi: true },
  { name: 'two-observations', a: [1,2], b: [2,4] },
  { name: 'offset', a: range(20, i => 1e6 + i / 10), b: range(20, i => -1e6 + Math.sin(i) + i / 10) },
];
const descriptions = [
  { name: 'continuous', values: [-4, -1.5, .25, 3, 8, 11] },
  { name: 'coercion', values: [null, '', ' ', '3', 5, 'bad', '2.5'] },
  { name: 'singleton', values: [null, 3] },
  { name: 'empty', values: [null, '', 'bad'] },
  { name: 'constant', values: [4,4,4,4] },
];
const groups = [
  { name: 'three-separated', groups: [[1,2,3],[4,5,6],[7,8,9]] },
  { name: 'tied', groups: [[1,1,2,3,4],[2,2,3,3,4],[1,2,4,4,5]] },
  { name: 'unbalanced', groups: [[-2,.5,1],[1,2,3,4,5,6,7],[2,9]] },
  { name: 'overlapping', groups: [[-3,-1,0,1,2],[0,1,3,4,5],[1,2,3,4,7]] },
];
const contingencies = [
  { name: 'two-by-two', counts: [[10,20],[30,40]] },
  { name: 'sparse', counts: [[1,2],[3,4]] },
  { name: 'three-by-three', counts: [[15,10,8],[4,22,12],[11,7,19]] },
  { name: 'independent', counts: [[10,20,30],[20,40,60]] },
];
function mulberry32(seed) { return () => { let t = seed += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function initialCenters(X, k) {
  const dist = (a,b) => a.reduce((s,v,j) => s + (v-b[j])**2,0);
  return range(10, init => { const rand = mulberry32(42+init), centers=[X[Math.floor(rand()*X.length)].slice()], minD=X.map(()=>Infinity);
    while(centers.length<k){ let total=0;for(let i=0;i<X.length;i++){minD[i]=Math.min(minD[i],dist(X[i],centers.at(-1)));total+=minD[i];}
      let target=rand()*total,pick=X.length-1;for(let i=0;i<X.length;i++){target-=minD[i];if(target<=0){pick=i;break;}}centers.push(X[pick].slice()); }
    return centers; });
}
const clusters = [
  { name: 'three-clouds', k: 3, rows: range(36, i => { const g=Math.floor(i/12),t=i%12;return [g*7+Math.sin(t)*.7,g%2*6+Math.cos(t*1.7)*.8]; }) },
  { name: 'unequal-clouds', k: 3, rows: range(45, i => {const g=i<25?0:i<38?1:2;return [g*4+Math.sin(i*1.1),g*2+Math.cos(i*.8)];}) },
  { name: 'overlapping-clouds', k: 2, rows: range(30, i => [Math.sin(i*1.7)*2+(i<15?0:2),Math.cos(i*.7)*1.5]) },
];
for (const fixture of clusters) fixture.initialCenters = initialCenters(fixture.rows, fixture.k);
const pca = [
  { name: 'small-continuous', columns: ['a','b','c','d'], train: range(24,i=>[Math.sin(i*.6)+i*.2,Math.cos(i*.8)+i*.4,Math.sin(i*.3)*2-i*.1,(i%5)*.8+Math.cos(i)]), holdout: [[2,4,1,.5],[.1,-2,.2,4],[3,7,-1,2]] },
];
const iris = readFileSync(new URL('../../public/demo/iris.csv', import.meta.url), 'utf8').trim().split(/\r?\n/).slice(1).map(line => line.split(',').slice(1,5).map(Number));
pca.push({ name: 'iris', columns: ['sepalLength','sepalWidth','petalLength','petalWidth'], train: iris.filter((_,i)=>i%5!==0), holdout: iris.filter((_,i)=>i%5===0) });
const hs = JSON.parse(readFileSync(new URL('../../src/lib/__tests__/fixtures/efa-congruence/holzinger-complete.input.json', import.meta.url),'utf8'));
const hsRows = range(hs.nRows,i=>hs.columns.map(column=>hs.data[column][i]));
pca.push({ name: 'holzinger', columns: hs.columns, train: hsRows.filter((_,i)=>i%6!==0), holdout: hsRows.filter((_,i)=>i%6===0) });
for (const covarianceScale of [1e-10, 1e100]) pca.push({
  name: `covariance-scale-${covarianceScale}`, columns: ['x', 'y'], covarianceScale,
  contracts: [{ missing: 'complete', standardize: false }],
  train: [[1, 2], [2, 1], [3, 5], [4, 3], [5, 7], [6, 5], [7, 9], [8, 8]].map(row => row.map(x => x * covarianceScale)),
  holdout: [[2, 4], [9, 7]].map(row => row.map(x => x * covarianceScale)),
});
for (const c of pca) {
  c.trainMissing=c.train.map((row,i)=>row.map((v,j)=>(i*7+j*11)%31===0?null:v));
  c.holdoutMissing=c.holdout.map((row,i)=>row.map((v,j)=>(i+j)%7===0?null:v));
}
const value = { schema: 1, conventions: { correlation: 'pairwise finite numeric coercion, minimum3; Pearson and Spearman midranks', mannWhitney: 'two-sided exact=FALSE correct=FALSE', ks: 'D from stats::ks.test; Stephens-adjusted p separately, R default p measured as compatibility boundary', kmeans: 'ten explicitly recorded kmeans++ center matrices from existing Mulberry32(42+start), compare stats::kmeans Lloyd300 and choose minimumSSE; no shared-seed claim', pca: 'centered, population-SD scaling when enabled; prcomp sample eigenvalues multiplied(n-1)/n for population eigenvalues; signed-axis alignment' }, pairs, correlations, descriptions, groups, contingencies, clusters, pca };
writeFileSync(output,JSON.stringify(value,null,2)+'\n');
console.log(output);
