// Matrix-free H V for explicitly selected estimated MV correction.
// Uses the same explicit-rounding arithmetic as the qualified trace kernel.
import { portableArithmetic } from './portable-shader.mjs';
const shape = `struct Shape { rows:u32, cols:u32, inner:u32, start:u32, sourceRows:u32, sourceCols:u32, transpose:u32, sourceKind:u32, roundingMask:u32, chunks:u32, pad0:u32, pad1:u32 }`;
const dot = shape + `
@group(0) @binding(0) var<storage,read> codes:array<u32>;
@group(0) @binding(1) var<storage,read> pairs:array<vec4<u32>>;
@group(0) @binding(2) var<storage,read> lookup:array<vec2<f32>>;
@group(0) @binding(3) var<storage,read> projection:array<vec2<f32>>;
@group(0) @binding(4) var<storage,read> input:array<vec2<f32>>;
@group(0) @binding(5) var<storage,read_write> output:array<vec2<f32>>;
@group(0) @binding(6) var<uniform> shape:Shape;
var<workgroup> tileA:array<vec2<f32>,256>;
var<workgroup> tileB:array<vec2<f32>,256>;
fn rank(i:u32)->u32 { return (codes[i/2u] >> ((i%2u)*16u)) & 65535u; }
fn source(row:u32,col:u32)->vec2<f32> {
  if (shape.sourceKind == 1u) { return projection[row * shape.sourceCols + col]; }
  let p=pairs[col]; let a=rank(p.x+row); let b=rank(p.y+row);
  if(a==65535u || b==65535u){ return vec2<f32>(0.0); }
  return lookup[p.w+a*p.z+b];
}
@compute @workgroup_size(16,16)
fn main(@builtin(global_invocation_id) gid:vec3<u32>, @builtin(local_invocation_id) lid:vec3<u32>, @builtin(workgroup_id) group:vec3<u32>) {
  let row=gid.y; let col=gid.x; let t=lid.y*16u+lid.x; let begin=group.z*1024u;
  var hi=0.0; var lo=0.0;
  for(var offset=begin;offset<min(begin+1024u,shape.inner);offset+=16u){
    tileA[t]=vec2<f32>(0.0); tileB[t]=vec2<f32>(0.0);
    if(row<shape.rows && offset+lid.x<shape.inner){
      if(shape.transpose==0u){ tileA[t]=source(shape.start+row,offset+lid.x); }
      else { tileA[t]=source(offset+lid.x,shape.start+row); }
    }
    let bCol=group.x*16u+lid.x;
    if(bCol<shape.cols && offset+lid.y<shape.inner){ tileB[t]=input[(offset+lid.y)*shape.cols+bCol]; }
    workgroupBarrier();
    for(var k=0u;k<16u;k++){
      let av=tileA[lid.y*16u+k]; let bv=tileB[k*16u+lid.x];
      let product=fpMul(av.x,bv.x);
      let residual=fpAdd(fpAdd(fpAdd(productError(av.x,bv.x,product),fpMul(av.x,bv.y)),fpMul(av.y,bv.x)),fpMul(av.y,bv.y));
      let next=fpAdd(hi,product);
      if(abs(hi)>=abs(product)){ lo=fpAdd(lo,fpAdd(fpSub(hi,next),product)); }
      else {lo=fpAdd(lo,fpAdd(fpSub(product,next),hi));}
      lo=fpAdd(lo,residual); hi=next;
    }
    workgroupBarrier();
  }
  if(row<shape.rows && col<shape.cols){output[(row*shape.cols+col)*shape.chunks+group.z]=vec2<f32>(hi,lo);}
}` + portableArithmetic;
const reduce = shape + `
@group(0) @binding(0) var<storage,read> partials:array<vec2<f32>>;
@group(0) @binding(1) var<storage,read_write> output:array<vec2<f32>>;
@group(0) @binding(2) var<uniform> shape:Shape;
var<workgroup> sums:array<vec2<f32>,256>;
fn pairAdd(a:vec2<f32>,b:vec2<f32>)->vec2<f32>{
 let sum=fpAdd(a.x,b.x); let delta=fpSub(sum,a.x);
 let error=fpAdd(fpAdd(fpAdd(fpSub(a.x,fpSub(sum,delta)),fpSub(b.x,delta)),a.y),b.y);
 let hi=fpAdd(sum,error); return vec2<f32>(hi,fpSub(error,fpSub(hi,sum)));
}
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) local:vec3<u32>,@builtin(workgroup_id) group:vec3<u32>){
 let index=group.y*256u+group.x; if(index>=shape.rows*shape.cols){return;}
 var value=vec2<f32>(0.0);
 for(var c=local.x;c<shape.chunks;c+=256u){value=pairAdd(value,partials[index*shape.chunks+c]);}
 sums[local.x]=value; workgroupBarrier();
 for(var stride=128u;stride>0u;stride/=2u){if(local.x<stride){sums[local.x]=pairAdd(sums[local.x],sums[local.x+stride]);}workgroupBarrier();}
 if(local.x==0u){output[shape.start*shape.cols+index]=sums[0];}
}` + portableArithmetic;
const pack = values => {
 const out=new Float32Array(values.length*2);
 for(let i=0;i<values.length;i++){const hi=Math.fround(values[i]);out[2*i]=hi;out[2*i+1]=values[i]-hi;}return out;
};
export async function createTraceOperator(source, progress=()=>{}) {
 const adapter=await navigator.gpu?.requestAdapter({powerPreference:'high-performance'});
 if(!adapter||adapter.info.isFallbackAdapter)throw new Error('Hardware WebGPU required');
 const limit=Math.min(512*1024**2,adapter.limits.maxStorageBufferBindingSize,adapter.limits.maxBufferSize);
 const device=await adapter.requestDevice({requiredLimits:{maxStorageBufferBindingSize:limit,maxBufferSize:limit}});
 let lost;void device.lost.then(info=>{lost=info.message||'GPU device lost';});
 const owned=new Set();let allocated=0,peak=0;
 const buffer=(size,usage)=>{if(size>limit||allocated+size>1024**3)throw new Error('Experimental operator exceeds GPU memory budget');const b=device.createBuffer({size,usage});owned.add(b);allocated+=size;peak=Math.max(peak,allocated);return b;};
 const drop=b=>{if(owned.delete(b)){allocated-=b.size;b.destroy();}};
 const upload=values=>{const b=buffer(values.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC);device.queue.writeBuffer(b,0,values);return b;};
 const compileModule=async code=>{const m=device.createShaderModule({code});const info=await m.getCompilationInfo();if(info.messages.some(x=>x.type==='error'))throw new Error(info.messages.map(x=>x.message).join('\n'));return m;};
 try {
 const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:await compileModule(dot),entryPoint:'main'}});
 const reduction=await device.createComputePipelineAsync({layout:'auto',compute:{module:await compileModule(reduce),entryPoint:'main'}});
 const n=source.nRows,m=source.pairs.length,q=source.projection[0].length;
 const codes=new Uint32Array(Math.ceil(source.codes.length/2));
 for(let i=0;i<source.codes.length;i++)codes[i>>>1]|=(source.observed[i]?source.codes[i]:65535)<<((i&1)*16);
 const meta=new Uint32Array(m*4),lookup=new Float32Array(source.pairs.reduce((s,p)=>s+p.values.length,0)*2);let at=0;
 source.pairs.forEach((p,i)=>{meta.set([p.i*n,p.j*n,p.columns,at/2],i*4);for(const value of p.values){const v=value*source.rootWeights[i],hi=Math.fround(v);lookup[at++]=hi;lookup[at++]=v-hi;}});
 const z=new Float32Array(n*q*2);
 for(let r=0;r<n;r++)for(let c=0;c<q;c++){const v=source.projection[r][c],hi=Math.fround(v),i=(r*q+c)*2;z[i]=hi;z[i+1]=v-hi;}
 const resident=[upload(codes),upload(meta),upload(lookup),upload(z)];
 const uniform=buffer(48,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
 const stages=[];
 const multiply=async(input,cols,kind,transpose)=>{
  const sourceCols=kind?q:m,rows=transpose?sourceCols:n,inner=transpose?n:sourceCols,chunks=Math.ceil(inner/1024),tile=256;
  const out=buffer(rows*cols*8,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);
  const partial=buffer(Math.min(tile,rows)*cols*chunks*8,GPUBufferUsage.STORAGE);
  const binds=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[...resident,input,partial,uniform].map((b,binding)=>({binding,resource:{buffer:b}}))});
  const redBinds=device.createBindGroup({layout:reduction.getBindGroupLayout(0),entries:[partial,out,uniform].map((b,binding)=>({binding,resource:{buffer:b}}))});
  const started=performance.now(),stage=`${kind?'Z':'A'}${transpose?' transpose':''} × probes`;
  device.pushErrorScope('validation');
  for(let start=0;start<rows;start+=tile){
   if(lost)throw new Error(lost);
   const size=Math.min(tile,rows-start);
   device.queue.writeBuffer(uniform,0,new Uint32Array([size,cols,inner,start,n,sourceCols,transpose?1:0,kind,0,chunks,0,0]));
   const enc=device.createCommandEncoder(),pass=enc.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,binds);pass.dispatchWorkgroups(Math.ceil(cols/16),Math.ceil(size/16),chunks);pass.end();
   const red=enc.beginComputePass();red.setPipeline(reduction);red.setBindGroup(0,redBinds);red.dispatchWorkgroups(Math.min(256,size*cols),Math.ceil(size*cols/256));red.end();device.queue.submit([enc.finish()]);
   if((start/tile+1)%8===0||start+tile>=rows){await device.queue.onSubmittedWorkDone();progress({stage,completed:Math.min(rows,start+tile),total:rows});}
  }
  const error=await device.popErrorScope();if(error)throw new Error(error.message);drop(partial);
  stages.push({stage,elapsedMs:performance.now()-started,rows,cols,inner});return out;
 };
 return {
  metadata:{precision:'explicit-rounding-dekker-split-f32 / host-f64',shader:dot,reductionShader:reduce,adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture}},
  async apply(probes,count){
   if(!Number.isSafeInteger(count)||count<1||count>128||probes.length!==n*count||probes.some(v=>!Number.isFinite(v)))throw new Error('Invalid operator probes');
   const keep=new Set(owned);stages.length=0;const started=performance.now();
   try{
    const v=upload(pack(probes)),u=await multiply(v,count,0,true),c=await multiply(v,count,1,true);drop(v);
    const y=await multiply(u,count,0,false);drop(u);const w=await multiply(c,count,1,false);drop(c);
    const size=n*count*8,read=buffer(2*size,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST),enc=device.createCommandEncoder();
    enc.copyBufferToBuffer(y,0,read,0,size);enc.copyBufferToBuffer(w,0,read,size,size);device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);
    const values=new Float32Array(read.getMappedRange()),out=new Float64Array(n*count),offset=size/4;
    for(let i=0;i<out.length;i++)out[i]=(values[2*i]+values[2*i+1])-(values[offset+2*i]+values[offset+2*i+1]);
    read.unmap();return {products:out,elapsedMs:performance.now()-started,stages:stages.slice(),peakOwnedGpuBufferBytes:peak};
   } finally {for(const b of [...owned])if(!keep.has(b))drop(b);}
  },
  destroy(){for(const b of owned)b.destroy();device.destroy();}
 };
 } catch(error){for(const b of owned)b.destroy();device.destroy();throw error;}
}
