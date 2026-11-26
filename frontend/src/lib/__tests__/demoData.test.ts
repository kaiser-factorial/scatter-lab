import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runPCA } from '../pca';
import { demoSurveySpec } from '../demo-survey';
import { prepareEfa } from '../efa/prepare';
import { correlate } from '../efa/correlation';
import { fitEfa, scoreEfa } from '../efa/fit';
import { rowsToTable, type DataTable } from '../table';

// Resolved against this file, not the cwd, so the suite passes wherever vitest
// is invoked from (CI runs it with working-directory: frontend, but a plain
// `pnpm --filter frontend exec vitest run` from the repo root must work too).
const IRIS_CSV = fileURLToPath(new URL('../../../public/demo/iris.csv', import.meta.url));

// The demo file must stay Fisher's iris, not the UCI/Kaggle mirror.
//
// The upstream mirror carries two documented transcription errors (samples 35
// and 38; see public/demo/iris.SOURCE.md). With those present, a correlation
// PCA reports 72.77% on PC1 where R, scikit-learn and every textbook say
// 72.96% — which reads as a bug in our eigensolver rather than a difference in
// the data. Regenerating the file from upstream would silently reintroduce it,
// so these values are pinned.
//
// This doubles as the suite's only external ground truth for runPCA: the rest
// of pca.test.ts checks analytic and self-consistency properties, which cannot
// catch an error shared between the implementation and its own assumptions.

const loadIris = (): DataTable => {
  const lines = readFileSync(IRIS_CSV, 'utf8').replace(/\r\n/g, '\n').trimEnd().split('\n');
  const columns = lines[0].split(',');
  const rows = lines.slice(1).map(line => {
    const cells = line.split(',');
    return Object.fromEntries(columns.map((c, i) => {
      const n = Number(cells[i]);
      return [c, cells[i] !== '' && Number.isFinite(n) ? n : cells[i]];
    }));
  });
  return rowsToTable(rows, columns);
};

const MEASUREMENTS = ['SepalLengthCm', 'SepalWidthCm', 'PetalLengthCm', 'PetalWidthCm'];

it('ships reproducible Likert responses that fit and score with the walkthrough settings', () => {
  const csv = readFileSync(new URL('../../../public/demo/synthetic-survey.csv', import.meta.url), 'utf8').trimEnd();
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/efa/mixed.input.json', import.meta.url), 'utf8')) as DataTable & { categories: number[][] };
  const [header, ...records] = csv.split('\n'), columns = header.split(',');
  const spec = demoSurveySpec();
  const items = spec.items.map(item => item.column);
  expect(columns).toEqual(['ResponseID', ...items, 'Gender', 'Age']);
  expect(records).toHaveLength(fixture.nRows);
  const table = rowsToTable(records.map(record => Object.fromEntries(record.split(',').map((value, index) => [columns[index], columns[index] === 'Gender' ? value : Number(value)]))), columns);
  expect(table.data.ResponseID).toEqual(Array.from({ length: 1500 }, (_, row) => row + 1));
  expect(table.data.Gender.filter(gender => gender === 'Nonbinary')).toHaveLength(86);
  expect(table.data.Gender.filter(gender => gender === 'Woman')).toHaveLength(722);
  expect(table.data.Gender.filter(gender => gender === 'Man')).toHaveLength(692);
  expect(table.data.Age.every(age => typeof age === 'number' && Number.isInteger(age) && age >= 18 && age <= 80)).toBe(true);
  items.forEach((column, index) => {
    expect(table.data[column]).toEqual(fixture.data[fixture.columns[index]]);
    expect(spec.items[index].categories).toEqual(fixture.categories[index]);
  });
  const prepared = prepareEfa(table, spec, records.map((_, index) => index));
  const fit = fitEfa(prepared, correlate(prepared), spec);
  const scores = scoreEfa(prepared, fit);
  expect(scores).toHaveLength(table.nRows);
  expect(scores.every(row => row.length === 2 && row.every(Number.isFinite))).toBe(true);
});

describe('demo iris dataset', () => {
  const iris = loadIris();

  it('has the expected shape', () => {
    expect(iris.nRows).toBe(150);
    expect(iris.columns).toEqual(['Id', 'SepalLengthCm', 'SepalWidthCm', 'PetalLengthCm', 'PetalWidthCm', 'Species']);
    const counts = (iris.data.Species as string[]).reduce<Record<string, number>>((a, s) => {
      a[s] = (a[s] ?? 0) + 1;
      return a;
    }, {});
    expect(counts).toEqual({ 'Iris-setosa': 50, 'Iris-versicolor': 50, 'Iris-virginica': 50 });
  });

  it('carries Fisher\'s values at the two rows the UCI mirror gets wrong', () => {
    const at = (id: number) => MEASUREMENTS.map(c => (iris.data[c] as number[])[(iris.data.Id as number[]).indexOf(id)]);
    expect(at(35)).toEqual([4.9, 3.1, 1.5, 0.2]); // mirror has petal width 0.1
    expect(at(38)).toEqual([4.9, 3.6, 1.4, 0.1]); // mirror has 3.1 / 1.5
  });

  // Published values for R's `iris`. Independent of anything in this codebase.
  it('reproduces R\'s column means and sample sds', () => {
    const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
    const sampleSd = (v: number[]) => {
      const m = mean(v);
      return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
    };
    const cols = MEASUREMENTS.map(c => iris.data[c] as number[]);
    [5.843333, 3.057333, 3.758, 1.199333].forEach((want, j) => {
      expect(mean(cols[j])).toBeCloseTo(want, 5);
    });
    [0.8280661, 0.4358663, 1.7652982, 0.7622377].forEach((want, j) => {
      expect(sampleSd(cols[j])).toBeCloseTo(want, 5);
    });
  });

  it('runPCA matches prcomp(iris, scale.=TRUE) variance explained', () => {
    const res = runPCA(iris, MEASUREMENTS, { k: 4, standardize: true });
    [72.9624, 22.8508, 3.6689, 0.5179].forEach((want, i) => {
      expect(res.varianceExplained[i] * 100).toBeCloseTo(want, 3);
    });
    expect(res.cumulative[3]).toBeCloseTo(1, 9);
  });

  it('runPCA matches prcomp(iris) on the covariance scale too', () => {
    const res = runPCA(iris, MEASUREMENTS, { k: 4, standardize: false });
    [92.4619, 5.3066, 1.7103, 0.5212].forEach((want, i) => {
      expect(res.varianceExplained[i] * 100).toBeCloseTo(want, 3);
    });
  });
});
