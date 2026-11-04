// Default-WebGPU precision candidate. The uniform roundingMask is uploaded as
// zero, but is unknown at shader compilation. Observing each arithmetic result
// through a nontrivial integer operation prevents floating-point reassociation
// across the rounding boundary. No strictMath option or fused fma is required.
// A plain bitcast round trip alone could be removed as an identity operation.
// This is split-f32 arithmetic, not a general IEEE binary64 implementation.
const arithmetic = `
fn rounded(value: f32) -> f32 {
  return bitcast<f32>(bitcast<u32>(value) ^ shape.roundingMask);
}
fn fpAdd(a: f32, b: f32) -> f32 { return rounded(a + b); }
fn fpSub(a: f32, b: f32) -> f32 { return rounded(a - b); }
fn fpMul(a: f32, b: f32) -> f32 { return rounded(a * b); }
fn productError(a: f32, b: f32, product: f32) -> f32 {
  // Split each 24-bit significand into two <=12-bit pieces. Every component
  // product is representable in f32 in the normal range. Unlike fma(), these
  // error-recovery operations do not depend on optional fused evaluation.
  let ah = bitcast<f32>(bitcast<u32>(a) & 0xfffff000u);
  let bh = bitcast<f32>(bitcast<u32>(b) & 0xfffff000u);
  let al = fpSub(a, ah); let bl = fpSub(b, bh);
  let first = fpSub(fpMul(ah, bh), product);
  return fpAdd(fpAdd(fpAdd(first, fpMul(ah, bl)), fpMul(al, bh)), fpMul(al, bl));
}
`;

export function portableDotShader(source, resident) {
  const declaration = resident
    ? 'parameters: u32, leftStart: u32, rightStart: u32 }'
    : 'parameters: u32 }';
  if (!source.includes(declaration)) throw new Error('Portable shape template mismatch');
  source = source.replace(declaration, declaration.replace(' }', ', roundingMask: u32 }'));
  const fragment = `let product = av.x * bv.x;
      let residual = fma(av.x, bv.x, -product) + av.x * bv.y + av.y * bv.x + av.y * bv.y;
      hi += product; lo += residual;`;
  if (source.split(fragment).length !== 3) throw new Error('Portable dot template mismatch');
  return source.replaceAll(fragment, `let product = fpMul(av.x, bv.x);
      let residual = fpAdd(fpAdd(fpAdd(productError(av.x, bv.x, product), fpMul(av.x, bv.y)), fpMul(av.y, bv.x)), fpMul(av.y, bv.y));
      let next = fpAdd(hi, product);
      if (abs(hi) >= abs(product)) { lo = fpAdd(lo, fpAdd(fpSub(hi, next), product)); }
      else { lo = fpAdd(lo, fpAdd(fpSub(product, next), hi)); }
      lo = fpAdd(lo, residual);
      hi = next;`) + arithmetic;
}

export function portableReductionShader(source) {
  const start = source.indexOf('  let sum = a.x + b.x;');
  const end = source.indexOf('\n}', start);
  if (start < 0 || end < 0) throw new Error('Portable reduction template mismatch');
  return (source.slice(0, start) + `  let sum = fpAdd(a.x, b.x);
  let delta = fpSub(sum, a.x);
  let error = fpAdd(fpAdd(fpAdd(fpSub(a.x, fpSub(sum, delta)), fpSub(b.x, delta)), a.y), b.y);
  let hi = fpAdd(sum, error);
  return vec2<f32>(hi, fpSub(error, fpSub(hi, sum)));` + source.slice(end))
    .replace('unused0: u32', 'roundingMask: u32') + arithmetic;
}

// Share the exact significand decomposition across the 16 dot products using
// each tile input. Rounded values and per-dot accumulation order are unchanged.
export function tiledPortableShader(source) {
  if (source.split('productError(av.x, bv.x, product)').length !== 3) throw new Error('Portable tile template mismatch');
  return source.replaceAll('array<vec2<f32>, 256>', 'array<vec4<f32>, 256>')
    .replaceAll('tileA[t] = vec2<f32>(0.0); tileB[t] = vec2<f32>(0.0);', 'tileA[t] = vec4<f32>(0.0); tileB[t] = vec4<f32>(0.0);')
    .replace(/(tile[AB]\[t\] = )([^;]+)(; \})/g, '$1splitInput($2)$3')
    .replaceAll('productError(av.x, bv.x, product)', 'tileProductError(av, bv, product)') + `
fn splitInput(v: vec2<f32>) -> vec4<f32> {
  let high = bitcast<f32>(bitcast<u32>(v.x) & 0xfffff000u);
  return vec4<f32>(v, high, fpSub(v.x, high));
}
fn tileProductError(a: vec4<f32>, b: vec4<f32>, product: f32) -> f32 {
  let first = fpSub(fpMul(a.z, b.z), product);
  return fpAdd(fpAdd(fpAdd(first, fpMul(a.z, b.w)), fpMul(a.w, b.z)), fpMul(a.w, b.w));
}`;
}
