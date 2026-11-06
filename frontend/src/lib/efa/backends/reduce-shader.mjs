// Experimental on-device reduction of the split dot-product chunks. Both the
// default compiler and the explicitly labeled developer strictMath mode must
// be tested: WGSL does not guarantee these error-recovery expressions survive
// reassociation. This is never an automatic production precision substitute.
export const reduceShader = `
struct Shape { outputs: u32, chunks: u32, unused0: u32, dispatchWidth: u32, cols: u32, lowerOnly: u32 }
@group(0) @binding(0) var<storage, read> partials: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> result: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> shape: Shape;
var<workgroup> sums: array<vec4<f32>, 256>;
fn pairAdd(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  let sum = a.x + b.x;
  let delta = sum - a.x;
  let error = (a.x - (sum - delta)) + (b.x - delta) + a.y + b.y;
  let hi = sum + error;
  return vec2<f32>(hi, error - (hi - sum));
}
fn add(a: vec4<f32>, b: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(pairAdd(a.xy, b.xy), pairAdd(a.zw, b.zw));
}
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) local: vec3<u32>, @builtin(workgroup_id) group: vec3<u32>) {
  let output = group.y * shape.dispatchWidth + group.x;
  if (output >= shape.outputs) { return; }
  let row = output / shape.cols; let col = output % shape.cols;
  if (shape.lowerOnly != 0u && col > row) { return; }
  var value = vec4<f32>(0.0);
  for (var chunk = local.x; chunk < shape.chunks; chunk += 256u) {
    value = add(value, partials[output * shape.chunks + chunk]);
  }
  sums[local.x] = value;
  workgroupBarrier();
  for (var stride = 128u; stride > 0u; stride /= 2u) {
    if (local.x < stride) { sums[local.x] = add(sums[local.x], sums[local.x + stride]); }
    workgroupBarrier();
  }
  if (local.x == 0u) {
    result[output] = sums[0];
    if (shape.lowerOnly != 0u && row != col) { result[col * shape.cols + row] = sums[0]; }
  }
}`;

export function compensateSplit(source) {
  const fragment = 'hi += product; lo += residual;';
  if (source.split(fragment).length !== 3) throw new Error('Split compensation template mismatch');
  return source.replaceAll(fragment, `
      let next = hi + product;
      if (abs(hi) >= abs(product)) { lo += (hi - next) + product; }
      else { lo += (product - next) + hi; }
      lo += residual;
      hi = next;`);
}
