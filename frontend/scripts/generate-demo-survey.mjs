import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mulberry32 } from '../../packages/statistics/src/internal/random.ts';

const source = readFileSync(new URL('../src/lib/__tests__/fixtures/efa/mixed.input.json', import.meta.url));
if (createHash('sha256').update(source).digest('hex') !== '5f476601a261a99d713f3028469524a0828505db47fb59d30849000d41865f3c') throw new Error('Unexpected synthetic fixture; review its independent reference before changing the demo.');
const { columns, data, nRows } = JSON.parse(source);
const header = 'ResponseID,Plan,Explore,Organize,Imagine,Schedule,Invent,Prepare,Experiment,Gender,Age';
const random = mulberry32(73022);
const rows = Array.from({ length: nRows }, (_, index) => {
  const draw = random();
  let gender = 'Nonbinary';
  if (draw < 0.475) gender = 'Woman';
  else if (draw < 0.95) gender = 'Man';
  const age = 18 + Math.floor(random() * 63);
  return [index + 1, ...columns.map(column => data[column][index]), gender, age].join(',');
});
process.stdout.write([header, ...rows, ''].join('\n'));
