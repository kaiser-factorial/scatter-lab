// Each input double is represented by two f32 values. Small dot-product
// chunks return separate high/low A and Z sums for host Float64 reduction.
// This is still a candidate precision strategy, not a claim of IEEE f64 GPU.
export const splitShader = `
struct Shape { rows: u32, cols: u32, pairs: u32, parameters: u32 }
@group(0) @binding(0) var<storage, read> a: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read> b: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> za: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read> zb: array<vec2<f32>>;
@group(0) @binding(4) var<storage, read_write> out: array<vec4<f32>>;
@group(0) @binding(5) var<uniform> shape: Shape;
var<workgroup> tileA: array<vec2<f32>, 256>;
var<workgroup> tileB: array<vec2<f32>, 256>;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) group: vec3<u32>) {
  let row = gid.y; let col = gid.x; let t = lid.y * 16u + lid.x;
  let begin = group.z * 256u;
  var hi = 0.0; var lo = 0.0;
  for (var offset = begin; offset < min(begin + 256u, shape.pairs); offset += 16u) {
    tileA[t] = vec2<f32>(0.0); tileB[t] = vec2<f32>(0.0);
    if (row < shape.rows && offset + lid.x < shape.pairs) { tileA[t] = a[row * shape.pairs + offset + lid.x]; }
    let bRow = group.x * 16u + lid.y;
    if (bRow < shape.cols && offset + lid.x < shape.pairs) { tileB[t] = b[bRow * shape.pairs + offset + lid.x]; }
    workgroupBarrier();
    for (var k = 0u; k < 16u; k++) {
      let av = tileA[lid.y * 16u + k]; let bv = tileB[lid.x * 16u + k];
      let product = av.x * bv.x;
      let residual = fma(av.x, bv.x, -product) + av.x * bv.y + av.y * bv.x + av.y * bv.y;
      hi += product; lo += residual;
    }
    workgroupBarrier();
  }
  let aHi = hi; let aLo = lo; hi = 0.0; lo = 0.0;
  for (var offset = begin; offset < min(begin + 256u, shape.parameters); offset += 16u) {
    tileA[t] = vec2<f32>(0.0); tileB[t] = vec2<f32>(0.0);
    if (row < shape.rows && offset + lid.x < shape.parameters) { tileA[t] = za[row * shape.parameters + offset + lid.x]; }
    let bRow = group.x * 16u + lid.y;
    if (bRow < shape.cols && offset + lid.x < shape.parameters) { tileB[t] = zb[bRow * shape.parameters + offset + lid.x]; }
    workgroupBarrier();
    for (var k = 0u; k < 16u; k++) {
      let av = tileA[lid.y * 16u + k]; let bv = tileB[lid.x * 16u + k];
      let product = av.x * bv.x;
      let residual = fma(av.x, bv.x, -product) + av.x * bv.y + av.y * bv.x + av.y * bv.y;
      hi += product; lo += residual;
    }
    workgroupBarrier();
  }
  let chunks = (max(shape.pairs, shape.parameters) + 255u) / 256u;
  if (row < shape.rows && col < shape.cols) { out[(row * shape.cols + col) * chunks + group.z] = vec4<f32>(aHi, aLo, hi, lo); }
}`;

// Same arithmetic as the expanded-input shader, with ordinal values looked up
// from resident data. Fail fast if the base shader changes under this adapter.
const replacements = [
  ['parameters: u32 }', 'parameters: u32, leftStart: u32, rightStart: u32 }'],
  ['var<storage, read> a: array<vec2<f32>>;', 'var<storage, read> codes: array<u32>;'],
  ['var<storage, read> b: array<vec2<f32>>;', 'var<storage, read> pairs: array<vec4<u32>>;'],
  ['var<storage, read> za: array<vec2<f32>>;', 'var<storage, read> lookup: array<vec2<f32>>;'],
  ['var<storage, read> zb: array<vec2<f32>>;', 'var<storage, read> projection: array<vec2<f32>>;'],
  ['a[row * shape.pairs + offset + lid.x]', 'ordinal(shape.leftStart + row, offset + lid.x)'],
  ['b[bRow * shape.pairs + offset + lid.x]', 'ordinal(shape.rightStart + bRow, offset + lid.x)'],
  ['za[row * shape.parameters + offset + lid.x]', 'projection[(shape.leftStart + row) * shape.parameters + offset + lid.x]'],
  ['zb[bRow * shape.parameters + offset + lid.x]', 'projection[(shape.rightStart + bRow) * shape.parameters + offset + lid.x]'],
];
export const residentShader = replacements.reduce((source, [before, after]) => {
  if (!source.includes(before)) throw new Error(`Resident shader template mismatch: ${before}`);
  return source.replace(before, after);
}, splitShader) + `
fn rank(index: u32) -> u32 { return (codes[index / 2u] >> ((index % 2u) * 16u)) & 65535u; }
fn ordinal(row: u32, pair: u32) -> vec2<f32> {
  let pairInfo = pairs[pair]; let x = rank(pairInfo.x + row); let y = rank(pairInfo.y + row);
  if (x == 65535u || y == 65535u) { return vec2<f32>(0.0); }
  return lookup[pairInfo.w + x * pairInfo.z + y];
}`;
