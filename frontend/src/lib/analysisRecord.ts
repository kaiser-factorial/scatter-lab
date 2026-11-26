import type { DatasetPartition, DatasetSplitOptions } from './datasetSplit';
import type { EfaState } from './efa/types';
import type { FilterCondition } from './rowFilter';
import type { DataTable } from './table';
import type { PCAResult } from './pca';
import type { PcaImputationBatch } from './pca-imputation';
import { MARK_KINDS, TEST_KINDS } from './analysisPlan';
import { version as applicationVersion } from '../../package.json';

const kinds = ['import', 'coercion', 'split', 'partition', 'unlock', 'filter', 'transfer', 'recode', 'pca', 'cluster', 'test', 'chart', 'efa-fit', 'efa-scores', 'efa-completion', 'efa-parallel', 'efa-imputation', 'efa-stability', 'membership', 'view', 'legacy'] as const;
type Kind = typeof kinds[number];
const numeric = ['rows', 'columns', 'sheetIndex', 'warnings', 'seed', 'fraction', 'development', 'holdout', 'sourceColumn', 'groupColumn', 'stratumColumn', 'eligible', 'fitted', 'scored', 'visible', 'filled', 'requestedK', 'retained', 'revision', 'runIndex', 'iterations', 'maxIterations', 'tolerance', 'eps', 'minSamples', 'color', 'shape', 'imputation', 'rotIterations', 'plotted'] as const;
const flags = ['projected', 'locked', 'standardized', 'converged', 'rotationConverged', 'afterFullExploration'] as const;
const lists = ['inputs', 'outputs', 'filterColumns', 'reversed', 'categories', 'varianceExplained'] as const;
const choices = {
  format: ['csv', 'xlsx', 'parquet'], mode: ['open', 'private'], partition: ['full', 'development', 'holdout', 'all'], rule: ['source-column', 'mulberry32'],
  test: TEST_KINDS, chart: MARK_KINDS,
  method: ['DBSCAN', 'KMEANS', 'minres', 'dwls', 'wlsmv', 'ml', 'fiml'], missing: ['pairwise', 'complete', 'median', 'mean', 'iterative', 'mice', 'fiml'],
  rotation: ['oblimin', 'varimax', 'promax'], correlation: ['pearson', 'polychoric', 'auto'], backend: ['cpu', 'webgpu'], dimension: ['2D', '3D'], transfer: ['order', 'match'],
} as const;
const hashes = ['inputSha256', 'sourceInputSha256', 'componentsSha256', 'membershipSha256', 'plottedSha256', 'fittingSha256', 'eligibleSha256', 'developmentSha256', 'holdoutSha256'] as const;
type Fields = Partial<Record<typeof numeric[number], number | undefined> & Record<typeof flags[number], boolean | undefined> & Record<typeof lists[number], number[]> & Record<keyof typeof choices | typeof hashes[number], string | undefined> & { filterOps: string[]; measurements: string[]; reviewed: Reviewed }>;
type Reviewed = Partial<Record<keyof typeof metadataSchema, unknown>>;
type Projection = 'text' | 'scalar' | readonly [Projection] | { readonly [key: string]: Projection };
const vector = { x: 'scalar', y: 'scalar', z: 'scalar' } as const;
const metadataSchema = {
  filename: 'text', componentsFile: 'text', sheet: 'text', dataset: 'text', datasetId: 'scalar', sourceDatasetId: 'scalar', sourceDataset: 'text', sourceFilename: 'text', sourcePartition: 'text', splitId: 'text', sourceColumn: 'text', groupColumn: 'text', stratumColumn: 'text', developmentValue: 'scalar', holdoutValue: 'scalar',
  label: 'text', variables: ['text'], derived: ['text'], removed: ['text'], warnings: ['text'], filters: [{column: 'text', op: 'text', value: 'scalar'}], recodes: [{column: 'text', values: ['scalar']}],
  runId: 'text', parentId: 'text', engine: 'text', scoring: 'text', datasetRevision: 'text', extraction: 'text', groups: ['scalar'],
  items: [{column: 'text', categories: ['scalar'], reverse: 'scalar', measurement: 'text'}], likelihood: {starts: 'scalar', tolerance: 'scalar', maxIterations: 'scalar', uniquenessFloor: 'scalar'},
  compute: {backend: 'text', correction: 'text', probes: 'scalar', probeSeed: 'scalar', memoryMiB: 'scalar', blockSize: 'scalar'},
  dimensionLabels: ['text'], muted: [{category: 'text', state: 'text'}], aspect: 'text', showAxes: 'scalar', color: 'text', shape: 'text', camera: {eye: vector, up: vector, center: vector, projection: {type:'text'}}, range: {x:['scalar'], y:['scalar']},
  minimumPairN: 'scalar', imputationSettings: {imputations:'scalar',iterations:'scalar',seed:'scalar',predictorEncoding:'text',predictors:[['scalar']]},
  requested:'scalar', completed:'scalar', confidence:'scalar', crossLoadingThreshold:'scalar', percentile:'scalar', runKind:'text', generator:'text',
  starts:'scalar', rank:'scalar', algorithm:'text', fillRules:[{variable:'text', measurement:'text', rule:'text',value:'scalar'}], design:'text', orientation:'text', aggregation:'text', bins:'scalar', decomposition:'text',
} as const satisfies Record<string, Projection>;

function project(value: unknown, schema: Projection): unknown {
  if (typeof schema === 'string') {
    if (typeof value === 'string') return value.replace(/\b(?:Bearer\s+\S+|(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-)[\w-]{8,}|(?:api[_-]?key|password|token|secret)\s*[:=]\s*[^\s,;]+)/gi, '[credential withheld]');
    if (schema === 'scalar' && (typeof value === 'boolean' || Number.isFinite(value))) return value;
    return undefined;
  }
  if (Array.isArray(schema)) return Array.isArray(value) ? value.map(item => project(item, schema[0])).filter(item => item !== undefined) : undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(schema).flatMap(([key, child]) => {
    if (!Object.hasOwn(source, key)) return [];
    const projected = project(source[key], key === 'value' && Array.isArray(source[key]) ? ['scalar'] : child);
    return projected === undefined ? [] : [[key, projected]];
  }));
}
export type TraceEntry = { at: string; action: string; event?: { kind: Kind; fields: Fields } };
export const event = (kind: Kind, fields: Fields = {}): NonNullable<TraceEntry['event']> => ({ kind, fields });
export const positions = (columns: string[], selected: (string | null | undefined)[]) => selected.map(name => name ? columns.indexOf(name) + 1 : 0);
export const filterFields = (columns: string[], conditions?: FilterCondition[] | null, reviewed: Reviewed = {}) => ({ filterColumns: positions(columns, (conditions ?? []).map(condition => condition.column)), filterOps: (conditions ?? []).map(condition => condition.op), reviewed: { ...reviewed, filters: conditions ?? [] } });

export function splitEvent(split: EfaState['splits'][number], options: DatasetSplitOptions, sourceDatasetId: number, columns: string[], removed: string[]) {
  return event('split', {
    rule: options.sourceColumn ? 'source-column' : 'mulberry32', seed: split.seed, fraction: split.fraction,
    development: split.development.length, holdout: split.holdout.length, afterFullExploration: split.afterFullExploration,
    sourceColumn: positions(columns, [options.sourceColumn])[0], groupColumn: positions(columns, [options.groupColumn])[0], stratumColumn: positions(columns, [options.stratumColumn])[0],
    reviewed: { sourceDatasetId, splitId: split.id, removed, sourceColumn: options.sourceColumn, groupColumn: options.groupColumn, stratumColumn: options.stratumColumn,
      developmentValue: options.sourceColumn ? options.developmentValue ?? 'development' : undefined, holdoutValue: options.sourceColumn ? options.holdoutValue ?? 'holdout' : undefined },
  });
}

export function clusterEvent(method: string, standardized: boolean, k: number, eps: number, minSamples: number, fitted: number, axes: string[], columns: string[], derived: string[], filters: FilterCondition[] | null, output: string, observed: number) {
  const dbscan = method === 'DBSCAN';
  return event('cluster', { method, standardized, fitted, requestedK: dbscan ? undefined : k, retained: dbscan ? undefined : observed, eps: dbscan ? eps : undefined, minSamples: dbscan ? minSamples : undefined,
    seed: dbscan ? undefined : 42, maxIterations: dbscan ? undefined : 300, inputs: positions(columns, axes), outputs: positions(derived, [output]),
    ...filterFields(columns, filters, { variables: axes, derived: [output], generator: dbscan ? undefined : 'mulberry32(42 + start index)', starts: dbscan ? undefined : 10, algorithm: dbscan ? 'DBSCAN' : 'k-means++' }),
  });
}

export function pcaEvent(result: PCAResult, variables: string[], input: DataTable, eligible: number, standardized: boolean, measurements: Record<string, string>, filters: FilterCondition[] | null, minimumPairN: number, imputationSettings?: PcaImputationBatch['settings']) {
  const report = result.missing;
  return event('pca', { inputs: positions(input.columns, variables), outputs: positions(result.table.columns, result.columns), retained: result.k,
    backend: 'cpu', standardized, missing: report.strategy, eligible, fitted: report.rowsUsed, filled: report.imputedCells,
    scored: result.table.data[result.columns[0]].filter(value => value != null).length,
    measurements: variables.map(variable => measurements[variable] ?? 'auto'), varianceExplained: result.varianceExplained,
    converged: report.converged, iterations: report.iterations, maxIterations: report.iterativeSettings?.maxIterations, tolerance: report.iterativeSettings?.tolerance, seed: report.seed, imputation: report.imputation,
    ...filterFields(input.columns, filters, { label: result.label, variables, derived: result.columns, removed: result.replaced, minimumPairN, rank: report.iterativeSettings?.rank, fillRules: report.fillRules, imputationSettings }),
  });
}

export function plottedRows(table: DataTable, axes: (string | null)[], filter: boolean[] | null, hidden: (row: number) => boolean) {
  const rows: number[] = [];
  for (let row = 0; row < table.nRows; row++) {
    if ((!filter || filter[row]) && !hidden(row) && axes.every(axis => !axis || table.data[axis]?.[row] != null)) rows.push(row);
  }
  return rows;
}

function safeFields(source: Fields) {
  const out: Record<string, unknown> = {};
  for (const key of numeric) if (Number.isFinite(source[key])) out[key] = source[key];
  for (const key of flags) if (typeof source[key] === 'boolean') out[key] = source[key];
  for (const key of lists) if (Array.isArray(source[key]) && source[key].every(Number.isFinite)) out[key] = source[key];
  for (const [key, allowed] of Object.entries(choices)) {
    const value = source[key as keyof typeof choices];
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) out[key] = value;
  }
  for (const key of hashes) if (typeof source[key] === 'string' && /^[0-9a-f]{64}$/.test(source[key])) out[key] = source[key];
  for (const [key, allowed] of [['filterOps', ['eq','neq','lt','lte','gt','gte','in','contains']], ['measurements', ['auto','ordinal','continuous']]] as const) {
    if (Array.isArray(source[key]) && source[key].every(value => (allowed as readonly string[]).includes(value))) out[key] = source[key];
  }
  return out;
}

export async function sha256(bytes: string | ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function fileDigest(file: File | null) {
  if (!file || !globalThis.crypto?.subtle) return undefined;
  const buffer = typeof file.arrayBuffer === 'function' ? await file.arrayBuffer() : await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = () => reject(reader.error); reader.readAsArrayBuffer(file);
  });
  return sha256(buffer);
}

export type ImportDigests = Pick<Fields, 'inputSha256' | 'componentsSha256'>;
type RecordDigests = ImportDigests & Pick<Fields, 'sourceInputSha256'>;
const pending = new WeakMap<TraceEntry, Promise<RecordDigests>>();
export function pendingImportDigests(entry?: TraceEntry) {
  return entry && pending.get(entry);
}
export function attachDigests(entry: TraceEntry, digests: Promise<RecordDigests>) {
  pending.set(entry, digests);
}
export function withDigests(entry: TraceEntry, digests: RecordDigests): TraceEntry {
  return { ...entry, event: event(entry.event?.kind ?? 'import', { ...entry.event?.fields, ...digests }) };
}

export function efaEvents(previous: EfaState, next: EfaState, columns: string[], filters?: FilterCondition[] | null, table?: DataTable): TraceEntry[] {
  const entries: TraceEntry[] = [];
  for (const [index, run] of next.runs.entries()) {
    if (previous.runs.some(old => old.id === run.id && old.revision === run.revision)) continue;
    const { spec, result } = run;
    entries.push({ at: run.createdAt, action: `Saved EFA fit ${run.id} (revision ${run.revision}).`, event: event('efa-fit', {
      runIndex: index + 1, revision: run.revision, inputs: positions(columns, spec.items.map(item => item.column)), reversed: spec.items.map(item => Number(item.reverse)), categories: spec.items.map(item => item.categories.length), measurements: spec.items.map(item => item.measurement ?? 'auto'),
      retained: spec.nFactors, rotation: spec.rotation, missing: spec.missing, seed: spec.seed, method: spec.extraction ?? 'minres', correlation: result.correlationMethod ?? spec.correlation,
      ...filterFields(columns, filters), backend: result.provenance.execution?.backend ?? (spec.extraction !== 'wlsmv' ? 'cpu' : undefined), inputSha256: result.provenance.inputSha256, partition: spec.sample.partition, eligible: run.eligibleRows.length, fitted: result.fittingRows.length,
      converged: result.extraction.convergence.converged, iterations: result.extraction.convergence.iterations, rotationConverged: result.rotation.convergence.converged, rotIterations: result.rotation.convergence.iterations, warnings: result.diagnostics.length,
      reviewed: { filters, runId: run.id, runKind: run.kind, parentId: run.parentId, label: spec.label, items: spec.items, splitId: spec.sample.splitId, datasetRevision: run.datasetRevision, engine: result.provenance.engine, scoring: result.provenance.scoring, extraction: result.provenance.extraction, likelihood: result.likelihood?.settings ?? spec.likelihood, compute: spec.compute, warnings: result.diagnostics.map(warning => warning.code) },
    }) });
  }
  for (const run of next.parallelRuns ?? []) if (!previous.parallelRuns?.some(old => old.id === run.id)) entries.push({ at: run.createdAt, action: 'Saved parallel analysis.', event: event('efa-parallel', { seed: run.result.seed, eligible: run.eligibleRows.length, missing: run.spec.missing, warnings: run.result.failures.length, inputSha256: run.result.provenance?.inputSha256, reviewed: { runId: run.id, label: run.spec.label, items: run.spec.items, percentile: run.result.percentile, requested: run.result.requested, completed: run.result.completed, generator: run.result.provenance?.generator } }) });
  for (const run of next.imputationRuns ?? []) if (!previous.imputationRuns?.some(old => old.id === run.id)) entries.push({ at: run.createdAt, action: 'Saved EFA imputation batch.', event: event('efa-imputation', { revision: run.revision, retained: run.spec.nFactors, rotation: run.spec.rotation, eligible: run.eligibleRows.length, fitted: run.result.fittingRows.length, warnings: run.result.failures.length, inputSha256: run.result.provenance.inputSha256, reviewed: { runId: run.id, parentId: run.parentId, label: run.spec.label, items: run.spec.items, imputationSettings: run.result.options, requested: run.result.requested, completed: run.result.completed } }) });
  for (const run of next.stabilityRuns ?? []) if (!previous.stabilityRuns?.some(old => old.id === run.id)) entries.push({ at: run.createdAt, action: 'Saved EFA stability analysis.', event: event('efa-stability', { seed: run.result.options.seed, warnings: run.result.failures.length, inputSha256: run.result.provenance?.inputSha256, reviewed: { runId: run.id, parentId: run.runId, groupColumn: run.groupColumn, requested: run.result.requested, completed: run.result.completed, confidence: run.result.options.confidence, crossLoadingThreshold: run.result.options.crossLoadingThreshold } }) });
  for (const split of next.splits) {
    const old = previous.splits.find(candidate => candidate.id === split.id);
    if (!old) {
      const source = split.sourceColumn && table ? table.data[split.sourceColumn] : undefined;
      entries.push({ at: split.createdAt, action: 'Created EFA sample split.', event: event('split', {
        development: split.development.length, holdout: split.holdout.length, seed: split.seed, fraction: split.fraction, rule: split.sourceColumn ? 'source-column' : 'mulberry32',
        ...filterFields(columns, filters, { splitId: split.id, label: split.label, groupColumn: split.groupColumn, stratumColumn: split.stratumColumn, sourceColumn: split.sourceColumn,
          developmentValue: source ? String(source[split.development[0]]) : undefined, holdoutValue: source ? String(source[split.holdout[0]]) : undefined }),
      }) });
    } else if (!old.holdoutOpenedAt && split.holdoutOpenedAt) entries.push({ at: split.holdoutOpenedAt, action: 'Opened EFA holdout.', event: event('unlock', {partition:'holdout', reviewed:{splitId:split.id}}) });
  }
  return entries;
}

export async function buildAnalysisRecord(trace: readonly TraceEntry[], view: Fields, partition?: DatasetPartition, includeMetadata = false, evidence?: { efa?: EfaState; plotted: number[] }) {
  const at = new Date().toISOString();
  const events = await Promise.all(trace.map(async entry => {
    const digest = pending.get(entry);
    return digest ? withDigests(entry, await digest) : entry;
  }));
  if (partition) events.push({ at, action: '', event: event('membership', { partition: partition.role, rows: partition.sourceRows.length, membershipSha256: await sha256(JSON.stringify(partition.sourceRows)), reviewed: { splitId: partition.groupId, sourceDatasetId: partition.sourceDatasetId } }) });
  const membershipDigest = (rows: number[]) => sha256(JSON.stringify(partition ? rows.map(row => partition.sourceRows[row]) : rows));
  if (evidence) {
    for (const run of evidence.efa?.runs ?? []) {
      events.push({ at, action: '', event: event('membership', { runIndex: evidence.efa!.runs.indexOf(run) + 1, fitted: run.result.fittingRows.length, eligible: run.eligibleRows.length, fittingSha256: await membershipDigest(run.result.fittingRows), eligibleSha256: await membershipDigest(run.eligibleRows), reviewed: { runId: run.id } }) });
    }
    for (const split of evidence.efa?.splits ?? []) events.push({ at, action: '', event: event('membership', { development: split.development.length, holdout: split.holdout.length, developmentSha256: await membershipDigest(split.development), holdoutSha256: await membershipDigest(split.holdout), reviewed: { splitId: split.id } }) });
  }
  events.push({ at, action: '', event: event('view', { ...view, ...(evidence ? { plotted: evidence.plotted.length, plottedSha256: await membershipDigest(evidence.plotted) } : {}) }) });
  const lines = events.map((entry, index) => {
    const structured = entry?.event && kinds.includes(entry.event.kind) ? entry.event : undefined;
    const kind = structured?.kind ?? 'legacy';
    const fields = safeFields(structured?.fields ?? {});
    const missingFields = !structured ? ['structured-operation', 'settings', 'execution', 'populations'] : kind === 'import' && !fields.inputSha256 ? ['inputSha256'] : [];
    if (kind === 'import' && fields.projected && !fields.componentsSha256) missingFields.push('componentsSha256');
    if (kind === 'transfer' && !fields.sourceInputSha256) missingFields.push('sourceInputSha256');
    if (kind === 'cluster' && fields.method === 'KMEANS' && fields.requestedK === undefined) {
      // Older exporters stored requested K under "retained". The assignments were not recorded.
      fields.requestedK = fields.retained;
      delete fields.retained;
      missingFields.push('retained');
    }
    if (kind === 'efa-fit') for (const key of ['backend', 'inputSha256', 'fitted', 'converged']) if (!(key in fields)) missingFields.push(key);
    if (kind === 'split' && fields.rule === 'source-column') for (const key of ['developmentValue', 'holdoutValue'] as const) if (structured?.fields?.reviewed?.[key] === undefined) missingFields.push(key);
    if (!trace.length && kind === 'view') missingFields.push('dataset-history');
    const metadata = includeMetadata ? (structured ? project(structured.fields?.reviewed, metadataSchema) : { legacyProse: project(entry?.action, 'text') }) : undefined;
    return { schema: 'scatterlab.analysis/1', applicationVersion, disclosure: includeMetadata ? 'reviewed-metadata' : 'masked-summary', sequence: index + 1, at: typeof entry?.at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(entry.at) ? entry.at : null, kind, fields, metadata, missingFields };
  });
  const jsonl = lines.map(line => JSON.stringify(line)).join('\n') + '\n';
  const markdown = ['# Scatter Lab analysis record · v1', '', `Exporting application: ${applicationVersion}. ${includeMetadata ? 'Includes reviewed sensitive metadata; missing steps are not inferred.' : 'Masked summary: not sufficient for replay.'} Ordered column positions are one-based at that step; 0 means unassigned. Membership hashes cover UTF-8 JSON arrays of zero-based source row positions.`, '', ...lines.map(line => `## ${line.sequence}. ${line.kind}${line.at ? ` · ${line.at}` : ''}\n\n${Object.entries(line.fields).map(([key,value]) => `- ${key}: ${JSON.stringify(value)}`).join('\n') || 'No structured details recorded.'}${line.missingFields.length ? `\n\nNot recorded: ${line.missingFields.join(', ')}.` : ''}${line.metadata ? '\n\nReviewed metadata:\n\n' + JSON.stringify(line.metadata, null, 2).split('\n').map(part => '    ' + part).join('\n') : ''}`), ''].join('\n');
  const files = [{ name: 'analysis.jsonl', text: jsonl, mime: 'application/x-ndjson' }, { name: 'analysis.md', text: markdown, mime: 'text/markdown' }];
  const checks = await Promise.all(files.map(async file => `${await sha256(file.text)}  ${file.name}`));
  return [...files, { name: 'SHA256SUMS.txt', text: checks.join('\n') + '\n', mime: 'text/plain' }];
}
