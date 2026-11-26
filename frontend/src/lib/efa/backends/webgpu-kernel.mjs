/** Shared WLSMV kernel used by qualification and the application. The app selects
 * only the portable split-f32 configuration; experimental modes remain harness-only. */
import { panelDotShader, panelShader } from "./panel-shader.mjs";
import { splitShader, residentShader } from "./split-shader.mjs";
import { reduceShader, compensateSplit } from "./reduce-shader.mjs";
import { portableDotShader, portableReductionShader, tiledPortableShader } from "./portable-shader.mjs";
export async function createGpuKernel({ compensated = true, split = false, resident = false, compensatedSplit = false, reduce = false, portable = false, strictMath, signal, dotChunkSize, materializePanels = false, preSplit = false, loading = "columnar" } = {}) {
  dotChunkSize ??= portable ? 1024 : 256;
  if (![64, 128, 256, 512, 1024, 2048].includes(dotChunkSize)) throw new Error('Unsupported dot chunk size');
  if (materializePanels && (!resident || !portable)) throw new Error('Panel expansion requires the portable resident kernel');
  if (preSplit && !portable) throw new Error("Tiled splitting requires portable arithmetic");
  if (!["columnar", "cooperative", "respondent"].includes(loading)) throw new Error("Unknown ordinal loading layout");
  if (loading !== "columnar" && (!resident || !portable || materializePanels || preSplit)) throw new Error("Layout experiments require the portable resident kernel without panel/pre-split experiments");
  split ||= resident;
  if (portable && (!split || strictMath !== undefined || compensatedSplit)) throw new Error('Portable precision requires split inputs and no strictMath/alternate compensation');
  if ((compensatedSplit || reduce) && !split) throw new Error('Split precision is required for these experiments');
  const startup = performance.now();
  if (!navigator.gpu) throw new Error("WebGPU unavailable");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter || adapter.info.isFallbackAdapter) throw new Error("No hardware WebGPU adapter");
  const timestamps = adapter.features.has("timestamp-query");
  const bindingLimit = Math.min(512 * 1024 ** 2, adapter.limits.maxStorageBufferBindingSize, adapter.limits.maxBufferSize);
  const device = await adapter.requestDevice({ requiredFeatures: timestamps ? ["timestamp-query"] : [], ...(resident ? { requiredLimits: { maxStorageBufferBindingSize: bindingLimit, maxBufferSize: bindingLimit } } : {}) });
  let lost;
  void device.lost.then(info => { lost = info.message || "GPU device lost"; });
  const abort = () => device.destroy();
  signal?.addEventListener("abort", abort, { once: true });
  const add = compensated
    ? "let t = av * bv - correction; let next = sum + t; correction = (next - sum) - t; sum = next;"
    : "sum += av * bv;";
  let code = materializePanels ? panelDotShader : resident ? residentShader : split ? splitShader : `
struct Shape { rows: u32, cols: u32, pairs: u32, parameters: u32 }
@group(0) @binding(0) var<storage, read> a: array<f32>;
@group(0) @binding(1) var<storage, read> b: array<f32>;
@group(0) @binding(2) var<storage, read> za: array<f32>;
@group(0) @binding(3) var<storage, read> zb: array<f32>;
@group(0) @binding(4) var<storage, read_write> out: array<f32>;
@group(0) @binding(5) var<uniform> shape: Shape;
var<workgroup> tileA: array<f32, 256>;
var<workgroup> tileB: array<f32, 256>;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) group: vec3<u32>) {
  let row = gid.y; let col = gid.x; let t = lid.y * 16u + lid.x;
  var sum = 0.0; var correction = 0.0;
  for (var offset = 0u; offset < shape.pairs; offset += 16u) {
    tileA[t] = 0.0; tileB[t] = 0.0;
    if (row < shape.rows && offset + lid.x < shape.pairs) { tileA[t] = a[row * shape.pairs + offset + lid.x]; }
    let bRow = group.x * 16u + lid.y;
    if (bRow < shape.cols && offset + lid.x < shape.pairs) { tileB[t] = b[bRow * shape.pairs + offset + lid.x]; }
    workgroupBarrier();
    for (var k = 0u; k < 16u; k++) { let av = tileA[lid.y * 16u + k]; let bv = tileB[lid.x * 16u + k]; ${add} }
    workgroupBarrier();
  }
  let product = sum; sum = 0.0; correction = 0.0;
  for (var offset = 0u; offset < shape.parameters; offset += 16u) {
    tileA[t] = 0.0; tileB[t] = 0.0;
    if (row < shape.rows && offset + lid.x < shape.parameters) { tileA[t] = za[row * shape.parameters + offset + lid.x]; }
    let bRow = group.x * 16u + lid.y;
    if (bRow < shape.cols && offset + lid.x < shape.parameters) { tileB[t] = zb[bRow * shape.parameters + offset + lid.x]; }
    workgroupBarrier();
    for (var k = 0u; k < 16u; k++) { let av = tileA[lid.y * 16u + k]; let bv = tileB[lid.x * 16u + k]; ${add} }
    workgroupBarrier();
  }
  if (row < shape.rows && col < shape.cols) { out[row * shape.cols + col] = product - sum; }
}`;
  if (split) code = code.replaceAll('group.z * 256u', `group.z * ${dotChunkSize}u`)
    .replaceAll('begin + 256u', `begin + ${dotChunkSize}u`)
    .replace('(max(shape.pairs, shape.parameters) + 255u) / 256u', `(max(shape.pairs, shape.parameters) + ${dotChunkSize - 1}u) / ${dotChunkSize}u`);
  if (portable) code = portableDotShader(code, resident);
  if (loading === "respondent") code = code.replace('roundingMask: u32 }', 'roundingMask: u32, items: u32 }')
    .replace('rank(pairInfo.x + row)', 'rank(row * shape.items + pairInfo.x)')
    .replace('rank(pairInfo.y + row)', 'rank(row * shape.items + pairInfo.y)');
  if (loading === "cooperative") {
    const before = `    if (row < shape.rows && offset + lid.x < shape.pairs) { tileA[t] = ordinal(shape.leftStart + row, offset + lid.x); }
    let bRow = group.x * 16u + lid.y;
    if (bRow < shape.cols && offset + lid.x < shape.pairs) { tileB[t] = ordinal(shape.rightStart + bRow, offset + lid.x); }`;
    if (!code.includes(before)) throw new Error("Cooperative loader template mismatch");
    code = code.replace(before, `    let at = lid.x * 16u + lid.y;
    let aRow = group.y * 16u + lid.x; let bRow = group.x * 16u + lid.x;
    // Each lane initializes its transposed slot, including ragged tails.
    tileA[at] = vec2<f32>(0.0); tileB[at] = vec2<f32>(0.0);
    if (aRow < shape.rows && offset + lid.y < shape.pairs) { tileA[at] = ordinal(shape.leftStart + aRow, offset + lid.y); }
    if (bRow < shape.cols && offset + lid.y < shape.pairs) { tileB[at] = ordinal(shape.rightStart + bRow, offset + lid.y); }`)
      // Avoid races between the old row-major initialization and transposed stores.
      .replace('    tileA[t] = vec2<f32>(0.0); tileB[t] = vec2<f32>(0.0);', '');
  }
  if (compensatedSplit) code = compensateSplit(code);
  if (preSplit) code = tiledPortableShader(code);
  // Only complete workgroups above the diagonal return before barriers.
  // Threads in a diagonal tile still cooperate in loading, but only its lower
  // triangle performs the arithmetic. Reduction mirrors the retained entries.
  const triangular = resident && reduce;
  let triangularCode;
  if (triangular) {
    triangularCode = code.replace('  let row = gid.y; let col = gid.x; let t = lid.y * 16u + lid.x;', `  let row = gid.y; let col = gid.x; let t = lid.y * 16u + lid.x;
  let lowerOnly = true;
  if (lowerOnly && group.x > group.y) { return; }`);
    let loops = 0;
    triangularCode = triangularCode.replace(/    for \(var k = 0u; k < 16u; k\+\+\) \{([\s\S]*?)\n    \}\n    workgroupBarrier\(\);/g, (_, body) => {
      loops++;
      return `    if (!lowerOnly || row >= col) {
    for (var k = 0u; k < 16u; k++) {${body}
    }
    }
    workgroupBarrier();`;
    });
    if (loops !== 2) throw new Error('Triangular kernel template mismatch');
  }
  const reductionCode = portable ? portableReductionShader(reduceShader) : reduceShader;
  let strictMathRecognized = strictMath === undefined ? null : false;
  const createShaderModule = code => {
    const descriptor = { code };
    if (strictMath !== undefined) Object.defineProperty(descriptor, 'strictMath', { enumerable: true, get() { strictMathRecognized = true; return strictMath; } });
    const shader = device.createShaderModule(descriptor);
    if (strictMath === true && !strictMathRecognized) { device.destroy(); throw new Error('strictMath was not recognized; this experiment requires the developer-only browser feature'); }
    return shader;
  };
  const shaderModule = createShaderModule(code);
  const info = await shaderModule.getCompilationInfo();
  if (info.messages.some(m => m.type === "error")) {
    device.destroy(); throw new Error(info.messages.map(m => m.message).join("\n"));
  }
  const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module: shaderModule, entryPoint: "main" } });
  const triangularPipeline = triangular ? await device.createComputePipelineAsync({ layout: "auto", compute: { module: createShaderModule(triangularCode), entryPoint: "main" } }) : undefined;
  const reductionPipeline = reduce ? await device.createComputePipelineAsync({ layout: 'auto', compute: { module: createShaderModule(reductionCode), entryPoint: 'main' } }) : undefined;
  const panelPipeline = materializePanels ? await device.createComputePipelineAsync({ layout: 'auto', compute: { module: createShaderModule(panelShader), entryPoint: 'main' } }) : undefined;
  const panels = [], panelCapacities = [0, 0], panelRanges = [];
  const panelShapes = materializePanels ? [0, 1].map(() => device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })) : [];
  const queryCount = materializePanels ? 6 : reduce ? 4 : 2, queryBytes = queryCount * 8;
  const query = timestamps ? device.createQuerySet({ type: "timestamp", count: queryCount }) : undefined;
  const queryResolve = timestamps ? device.createBuffer({ size: queryBytes, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }) : undefined;
  const queryRead = timestamps ? device.createBuffer({ size: queryBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }) : undefined;
  const reductionShape = reduce ? device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }) : undefined;
  let reduced, reducedCapacity = 0;
  let sourceByteEstimate = 0, dotBinding, dotBindingKey, triangularBinding, triangularBindingKey, reductionBinding, reductionBindingKey;
  let buffers = [], capacities = [], sourceSizes, currentSource, read, readSize = 0, dispatchObserver;
  const timings = { startupMs: performance.now() - startup, packMs: 0, uploadSubmitMs: 0, dispatchReadbackMs: 0, readMapWaitMs: 0, hostReductionMs: 0, gpuMs: timestamps ? 0 : null, reductionGpuMs: timestamps && reduce ? 0 : null, panelExpansions: 0, panelCacheHits: 0, panelGpuMs: timestamps && materializePanels ? 0 : null, calls: 0, uploadedBytes: 0, readbackBytes: 0, peakOwnedGpuBufferBytes: 0, sourceInitializations: 0, triangularBlocks: 0, bindGroupCacheHits: 0 };
  const pack = rows => {
    const result = new Float32Array(rows.length * rows[0].length * (split ? 2 : 1));
    if (split) rows.forEach((row, i) => { for (let k = 0; k < row.length; k++) {
      const offset = 2 * (i * row.length + k), hi = Math.fround(row[k]);
      result[offset] = hi; result[offset + 1] = row[k] - hi;
    } });
    else rows.forEach((row, i) => result.set(row, i * row.length));
    return result;
  };
  const packSource = source => {
    const codes = new Uint32Array(Math.ceil(source.codes.length / 2));
    const items = source.codes.length / source.nRows;
    for (let i = 0; i < source.codes.length; i++) {
      const at = loading === "respondent" ? (i % source.nRows) * items + Math.floor(i / source.nRows) : i;
      codes[at >>> 1] |= (source.observed[i] ? source.codes[i] : 65535) << ((at & 1) * 16);
    }
    const meta = new Uint32Array(source.pairs.length * 4);
    const lookup = new Float32Array(source.pairs.reduce((sum, pair) => sum + pair.values.length, 0) * 2);
    let at = 0;
    source.pairs.forEach((pair, i) => {
      meta.set([pair.i * (loading === "respondent" ? 1 : source.nRows), pair.j * (loading === "respondent" ? 1 : source.nRows), pair.columns, at / 2], 4 * i);
      for (const value of pair.values) {
        const scaled = value * source.rootWeights[i], hi = Math.fround(scaled);
        lookup[at++] = hi; lookup[at++] = scaled - hi;
      }
    });
    return [codes, meta, lookup, pack(source.projection)];
  };
  return {
    metadata: { backend: "webgpu", triangular, loading, dotChunkSize, materializePanels, preSplit, precision: split ? `${portable ? 'explicit-rounding-dekker-' : compensatedSplit ? 'compensated-' : ''}split-f32/${reduce ? 'gpu-pair-reduction/host-f64' : 'chunked-host-f64'}` : compensated ? "f32-compensated/host-f64" : "f32/host-f64", strictMathRequested: strictMath ?? null, strictMathRecognized, developerOnly: strictMath === true, transport: resident ? "Resident ordinal source and projections; per-block row ranges only" : "Expanded block inputs uploaded per call", ownedGpuBufferBudgetBytes: 1024 ** 3, adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description }, timestamps, shader: code, triangularShader: triangularCode, panelShader: materializePanels ? panelShader : undefined, reductionShader: reduce ? reductionCode : undefined },
    timings,
    setDispatchObserver(observer) { dispatchObserver = observer; },
    async run(block) {
      if (lost || signal?.aborted) throw new Error(lost || "Cancelled");
      const start = performance.now();
      if (resident && !block.ordinal) throw new Error("Resident GPU kernel requires an ordinal source");
      const ordinal = block.ordinal;
      const shape = resident
        ? new Uint32Array([ordinal.leftRows, ordinal.rightRows, ordinal.source.pairs.length, ordinal.source.projection[0].length, ordinal.leftStart, ordinal.rightStart, 0, ordinal.source.codes.length / ordinal.source.nRows])
        : new Uint32Array([block.left.length, block.right.length, block.left[0].length, block.leftProjection[0].length, ...(portable ? [0, 0, 0, 0] : [])]);
      const chunks = split ? Math.ceil(Math.max(shape[2], shape[3]) / dotChunkSize) : 1;
      const outputBytes = shape[0] * shape[1] * 4 * chunks * (split ? 4 : 1);
      const panelSizes = materializePanels ? [shape[0] * shape[2] * 8, shape[1] * shape[2] * 8] : [];
      const panelOwned = panelSizes.reduce((sum, size, i) => sum + Math.max(size, panelCapacities[i]), 0) + panelShapes.length * 16;
      const reducedBytes = reduce ? shape[0] * shape[1] * 16 : 0;
      const readBytes = reduce ? reducedBytes : outputBytes;
      if (resident) {
        const source = ordinal.source;
        if (currentSource !== source) sourceByteEstimate = Math.ceil(source.codes.length / 2) * 4 + source.pairs.length * 16 + source.pairs.reduce((sum, pair) => sum + pair.values.length * 8, 0) + source.nRows * shape[3] * 8;
        const estimate = sourceByteEstimate + outputBytes + readBytes + reducedBytes + panelOwned + 128;
        if (estimate > 1024 ** 3) throw new Error("Resident GPU source and blocks exceed the explicit 1 GiB device-buffer budget");
      }
      const inputs = resident ? currentSource === ordinal.source ? undefined : packSource(ordinal.source)
        : [pack(block.left), pack(block.right), pack(block.leftProjection), pack(block.rightProjection)];
      if (inputs) sourceSizes = inputs.map(v => v.byteLength);
      timings.packMs += performance.now() - start;
      const sizes = [...sourceSizes, outputBytes, shape.byteLength];
      if ([...sizes, ...panelSizes].some(size => size > device.limits.maxStorageBufferBindingSize)) throw new Error("Block exceeds GPU storage-buffer limit");
      const retainedBytes = panelOwned + sizes.reduce((sum, size, i) => sum + Math.max(size, capacities[i] ?? 0), 0) + Math.max(readSize, readBytes) + Math.max(reducedCapacity, reducedBytes) + (query ? queryBytes * 2 : 0) + (reduce ? 32 : 0);
      if (retainedBytes > 1024 ** 3) throw new Error("Retained GPU buffers exceed the explicit 1 GiB device-buffer budget");
      const beforeUpload = performance.now();
      panelSizes.forEach((size, i) => {
        if (panelCapacities[i] >= size) return;
        dotBinding = undefined; triangularBinding = undefined;
        panels[i]?.destroy(); panelRanges[i] = undefined; panelCapacities[i] = size;
        panels[i] = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE });
      });
      sizes.forEach((size, i) => {
        if ((capacities[i] ?? 0) >= size) return;
        dotBinding = undefined; triangularBinding = undefined; reductionBinding = undefined;
        buffers[i]?.destroy(); capacities[i] = size;
        buffers[i] = device.createBuffer({ size, usage: i === 5 ? GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST : GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
      });
      if (readSize < readBytes) {
        read?.destroy(); readSize = readBytes;
        read = device.createBuffer({ size: readSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      }
      if (reduce && reducedCapacity < reducedBytes) {
        reductionBinding = undefined;
        reduced?.destroy(); reducedCapacity = reducedBytes;
        reduced = device.createBuffer({ size: reducedCapacity, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      }
      inputs?.forEach((input, i) => device.queue.writeBuffer(buffers[i], 0, input));
      if (materializePanels && inputs) panelRanges.length = 0;
      if (resident && inputs) { currentSource = ordinal.source; timings.sourceInitializations++; }
      device.queue.writeBuffer(buffers[5], 0, shape);
      const outputs = shape[0] * shape[1];
      const lowerOnly = triangular && shape[4] === shape[5] && shape[0] === shape[1];
      if (lowerOnly) timings.triangularBlocks++;
      const reductionRows = Math.ceil(outputs / device.limits.maxComputeWorkgroupsPerDimension);
      const reductionWidth = Math.ceil(outputs / reductionRows);
      if (reduce) device.queue.writeBuffer(reductionShape, 0, new Uint32Array([shape[0] * shape[1], chunks, 0, reductionWidth, shape[1], lowerOnly ? 1 : 0, 0, 0]));
      const dotBuffers = materializePanels ? [panels[0], panels[1], buffers[3], buffers[3], buffers[4], buffers[5]] : buffers;
      const dotSizes = materializePanels ? [panelSizes[0], panelSizes[1], sizes[3], sizes[3], sizes[4], sizes[5]] : sizes;
      const bindingKey = dotSizes.join(":");
      const activePipeline = lowerOnly ? triangularPipeline : pipeline;
      let bindGroup;
      if (lowerOnly) {
        if (!triangularBinding || triangularBindingKey !== bindingKey) {
          triangularBinding = device.createBindGroup({ layout: activePipeline.getBindGroupLayout(0), entries: dotBuffers.map((buffer, binding) => ({ binding, resource: { buffer, size: dotSizes[binding] } })) });
          triangularBindingKey = bindingKey;
        } else timings.bindGroupCacheHits++;
        bindGroup = triangularBinding;
      } else {
        if (!dotBinding || dotBindingKey !== bindingKey) {
          dotBinding = device.createBindGroup({ layout: activePipeline.getBindGroupLayout(0), entries: dotBuffers.map((buffer, binding) => ({ binding, resource: { buffer, size: dotSizes[binding] } })) });
          dotBindingKey = bindingKey;
        } else timings.bindGroupCacheHits++;
        bindGroup = dotBinding;
      }
      device.pushErrorScope("validation");
      const encoder = device.createCommandEncoder();
      if (materializePanels) {
        const expansion = encoder.beginComputePass(query ? { timestampWrites: { querySet: query, beginningOfPassWriteIndex: 4, endOfPassWriteIndex: 5 } } : {});
        expansion.setPipeline(panelPipeline);
        for (let i = 0; i < 2; i++) {
          const rows = shape[i], start = shape[4 + i], key = `${start}:${rows}`;
          if (panelRanges[i] === key) { timings.panelCacheHits++; continue; }
          const groups = Math.ceil(rows * shape[2] / 256);
          if (groups > device.limits.maxComputeWorkgroupsPerDimension) throw new Error('Panel expansion exceeds dispatch limits');
          device.queue.writeBuffer(panelShapes[i], 0, new Uint32Array([rows, start, shape[2], 0]));
          const expansionBuffers = [buffers[0], buffers[1], buffers[2], panels[i], panelShapes[i]];
          const expansionSizes = [sizes[0], sizes[1], sizes[2], panelSizes[i], 16];
          expansion.setBindGroup(0, device.createBindGroup({ layout: panelPipeline.getBindGroupLayout(0), entries: expansionBuffers.map((buffer, binding) => ({ binding, resource: { buffer, size: expansionSizes[binding] } })) }));
          expansion.dispatchWorkgroups(groups);
          panelRanges[i] = key; timings.panelExpansions++;
        }
        expansion.end();
      }
      const pass = encoder.beginComputePass(query ? { timestampWrites: { querySet: query, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {});
      pass.setPipeline(activePipeline); pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(shape[1] / 16), Math.ceil(shape[0] / 16), chunks); pass.end();
      if (reduce) {
        const key = `${outputBytes}:${reducedBytes}`;
        if (!reductionBinding || reductionBindingKey !== key) {
        reductionBinding = device.createBindGroup({ layout: reductionPipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: buffers[4], size: outputBytes } },
          { binding: 1, resource: { buffer: reduced, size: reducedBytes } },
          { binding: 2, resource: { buffer: reductionShape } },
        ] });
        reductionBindingKey = key;
        } else timings.bindGroupCacheHits++;
        const bindings = reductionBinding;
        const reduction = encoder.beginComputePass(query ? { timestampWrites: { querySet: query, beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 } } : {});
        reduction.setPipeline(reductionPipeline); reduction.setBindGroup(0, bindings); reduction.dispatchWorkgroups(reductionWidth, Math.ceil(shape[0] * shape[1] / reductionWidth)); reduction.end();
      }
      encoder.copyBufferToBuffer(reduce ? reduced : buffers[4], 0, read, 0, readBytes);
      if (query) { encoder.resolveQuerySet(query, 0, queryCount, queryResolve, 0); encoder.copyBufferToBuffer(queryResolve, 0, queryRead, 0, queryBytes); }
      device.queue.submit([encoder.finish()]);
      dispatchObserver?.();
      timings.uploadSubmitMs += performance.now() - beforeUpload;
      const beforeRead = performance.now();
      await read.mapAsync(GPUMapMode.READ);
      timings.readMapWaitMs += performance.now() - beforeRead;
      const beforeReduce = performance.now();
      const partials = new Float32Array(read.getMappedRange(0, readBytes));
      const output = new Float64Array(shape[0] * shape[1]);
      if (reduce) for (let i = 0; i < output.length; i++) output[i] = (partials[4 * i] + partials[4 * i + 1]) - (partials[4 * i + 2] + partials[4 * i + 3]);
      else if (split) for (let i = 0; i < output.length; i++) {
        let a = 0, z = 0;
        for (let c = 0; c < chunks; c++) {
          const offset = 4 * (i * chunks + c);
          a += partials[offset] + partials[offset + 1];
          z += partials[offset + 2] + partials[offset + 3];
        }
        output[i] = a - z;
      } else output.set(partials);
      read.unmap();
      timings.hostReductionMs += performance.now() - beforeReduce;
      if (queryRead) {
        await queryRead.mapAsync(GPUMapMode.READ);
        const times = new BigUint64Array(queryRead.getMappedRange());
        timings.gpuMs += Number(times[1] - times[0]) / 1e6;
        if (reduce) { const elapsed = Number(times[3] - times[2]) / 1e6; timings.reductionGpuMs += elapsed; timings.gpuMs += elapsed; }
        if (materializePanels) { const elapsed = Number(times[5] - times[4]) / 1e6; timings.panelGpuMs += elapsed; timings.gpuMs += elapsed; }
        queryRead.unmap();
      }
      const error = await device.popErrorScope();
      if (error || lost || signal?.aborted) throw new Error(error?.message || lost || "Cancelled");
      timings.dispatchReadbackMs += performance.now() - beforeRead;
      timings.calls++;
      timings.uploadedBytes += (inputs?.reduce((sum, v) => sum + v.byteLength, 0) ?? 0) + shape.byteLength + (reduce ? 32 : 0);
      timings.readbackBytes += readBytes;
      timings.peakOwnedGpuBufferBytes = Math.max(timings.peakOwnedGpuBufferBytes, panelOwned + capacities.reduce((a, b) => a + b, 0) + readSize + reducedCapacity + (query ? queryBytes * 2 : 0) + (reduce ? 32 : 0));
      return output;
    },
    destroy() {
      signal?.removeEventListener("abort", abort);
      panels.forEach(buffer => buffer.destroy()); panelShapes.forEach(buffer => buffer.destroy());
      buffers.forEach(buffer => buffer.destroy()); read?.destroy(); reduced?.destroy(); reductionShape?.destroy(); query?.destroy(); queryResolve?.destroy(); queryRead?.destroy(); device.destroy();
    },
  };
}
