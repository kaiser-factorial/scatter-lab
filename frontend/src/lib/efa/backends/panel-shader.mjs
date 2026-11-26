import { splitShader } from './split-shader.mjs';
// Expand a row panel once instead of repeating ordinal lookup in every 16x16
// output tile. The lookup is a bit-exact copy of the uploaded split inputs.
export const panelDotShader = splitShader
  .replace('parameters: u32 }', 'parameters: u32, leftStart: u32, rightStart: u32 }')
  .replace('za[row * shape.parameters + offset + lid.x]', 'za[(shape.leftStart + row) * shape.parameters + offset + lid.x]')
  .replace('zb[bRow * shape.parameters + offset + lid.x]', 'zb[(shape.rightStart + bRow) * shape.parameters + offset + lid.x]');
export const panelShader = `
struct Shape { rows: u32, start: u32, pairs: u32, unused: u32 }
@group(0) @binding(0) var<storage, read> codes: array<u32>;
@group(0) @binding(1) var<storage, read> pairs: array<vec4<u32>>;
@group(0) @binding(2) var<storage, read> lookup: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read_write> panel: array<vec2<f32>>;
@group(0) @binding(4) var<uniform> shape: Shape;
fn rank(index: u32) -> u32 { return (codes[index / 2u] >> ((index % 2u) * 16u)) & 65535u; }
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let index = gid.x;
  if (index >= shape.rows * shape.pairs) { return; }
  let row = shape.start + index / shape.pairs; let pair = pairs[index % shape.pairs];
  let x = rank(pair.x + row); let y = rank(pair.y + row);
  var value = vec2<f32>(0.0);
  if (x != 65535u && y != 65535u) { value = lookup[pair.w + x * pair.z + y]; }
  panel[index] = value;
}`;
