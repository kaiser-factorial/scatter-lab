import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { prepareEfa } from '../../../src/lib/efa/prepare';
import { correlate } from '../../../src/lib/efa/correlation';
import { fitEfa } from '../../../src/lib/efa/fit';
import { conditionalCompletion } from '../../../src/lib/efa/maximum-likelihood';
import { completionOperation, COMPLETION_REPLAY_R, serializeCompletionCsv } from '../../../src/lib/efa/completion';
import type { DataTable } from '../../../src/lib/table';
import type { EfaRun, EfaSpec } from '../../../src/lib/efa/types';
const input = JSON.parse(readFileSync(`${process.env.CONGRUENCE_FIXTURE_ROOT ?? 'src/lib/__tests__/fixtures'}/efa-congruence/holzinger-mar.input.json`, 'utf8')) as DataTable;
const table = structuredClone(input);
// Synthetic edge added to public data: preserve a wholly unobserved fitting row.
table.columns.forEach(column => { table.data[column][12] = null; });
const rows = Array.from({ length: 220 }, (_, i) => i + 3).filter(i => i % 3 !== 1);
const spec: EfaSpec = { extraction: 'ml', correlation: 'pearson', missing: 'fiml', nFactors: 3, rotation: 'promax', seed: 73021, label: 'replay', sample: { partition: 'all', fixedRows: rows },
  items: table.columns.map((column, j) => ({ column, categories: [], reverse: j === 0 || j === 3, measurement: 'continuous' })) };
const data = prepareEfa(table, spec, rows), result = fitEfa(data, correlate(data), spec);
const run: EfaRun = { id: 'replay-reference', revision: 1, createdAt: new Date().toISOString(), datasetRevision: 'public-holzinger-mar', spec, result, eligibleRows: rows, kind: 'fit', reviews: {}, reasons: '', revisedAfterHoldout: false, scoreColumns: [] };
const completion = conditionalCompletion(table, spec, result), operation = completionOperation(table, run, completion);
let observedCells = 0, observedChanges = 0;
completion.rows.forEach((row, i) => completion.columns.forEach((column, j) => {
  const original = table.data[column][row];
  if (original != null) { observedCells++; if (completion.values[j][i] !== original) observedChanges++; }
}));
const destination = process.env.COMPLETION_REPLAY_DIR ?? 'scripts/efa-reference/congruence/replay';
mkdirSync(destination, { recursive: true });
writeFileSync(`${destination}/operation.json`, JSON.stringify(operation, null, 2) + '\n');
writeFileSync(`${destination}/replay-completion.R`, COMPLETION_REPLAY_R);
writeFileSync(`${destination}/native-completed.csv`, serializeCompletionCsv(completion));
const report = { source: 'HolzingerSwineford1939 x1:x9 with saved MAR mask, synthetic wholly missing row12, fixed fitting subset, reverse keys x1/x4', fittingRows: rows.length, resultRows: completion.rows.length, observedCells, observedChanges, completedCells: completion.completedCells, uninformativeRows: completion.uninformativeRows, reverseOffsets: result.numericReverseOffsets, operationSha256: createHash('sha256').update(readFileSync(`${destination}/operation.json`)).digest('hex'), replayCodeSha256: createHash('sha256').update(COMPLETION_REPLAY_R).digest('hex') };
writeFileSync(process.env.CONGRUENCE_OUTPUT ?? `${destination}/native-report.json`, JSON.stringify(report, null, 2) + '\n');
if (observedChanges || !completion.uninformativeRows.includes(12)) throw new Error('Completion changed observed values or lost the wholly missing row.');
