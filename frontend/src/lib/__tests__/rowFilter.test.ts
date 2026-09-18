import { describe, it, expect } from 'vitest';
import type { DataTable } from '../table';
import { buildRowMask, cellMatches, countMask, describeConditions, validateConditions } from '../rowFilter';

const table = (data: Record<string, unknown[]>): DataTable => {
  const columns = Object.keys(data);
  return { columns, data, nRows: data[columns[0]].length };
};

const t = table({
  id: [1, 2, 3, 4, 5, 6],
  score: [10, 50, 30, null, 20, 99],
  group: ['a', 'a', 'b', 'b', 'a', 'zebra'],
  answer: ['A', 'B', 'A', 'C', null, 'A'],
});

describe('cellMatches', () => {
  it('never matches a missing cell, even for neq', () => {
    expect(cellMatches(null, 'eq', 'A')).toBe(false);
    expect(cellMatches(null, 'neq', 'A')).toBe(false);
    expect(cellMatches(undefined, 'contains', '')).toBe(false);
  });
  it('compares eq numerically when both sides are numeric, else as strings', () => {
    expect(cellMatches('10', 'eq', 10)).toBe(true);
    expect(cellMatches(10, 'eq', '10.0')).toBe(true);
    expect(cellMatches('A', 'eq', 'a')).toBe(false);
    expect(cellMatches('A', 'neq', 'a')).toBe(true);
  });
  it('supports the inclusive and exclusive numeric comparisons', () => {
    expect(cellMatches(30, 'gte', 30)).toBe(true);
    expect(cellMatches(30, 'gt', 30)).toBe(false);
    expect(cellMatches(30, 'lte', 30)).toBe(true);
    expect(cellMatches(30, 'lt', 30)).toBe(false);
    expect(cellMatches('x', 'gt', 1)).toBe(false);
  });
  it('in accepts a list with mixed numeric/string members', () => {
    expect(cellMatches('A', 'in', ['A', 'B'])).toBe(true);
    expect(cellMatches(2, 'in', ['1', '2'])).toBe(true);
    expect(cellMatches('C', 'in', ['A', 'B'])).toBe(false);
  });
  it('contains is a case-insensitive substring', () => {
    expect(cellMatches('Zebra', 'contains', 'EB')).toBe(true);
  });
});

describe('buildRowMask', () => {
  it('keeps everything with no conditions', () => {
    expect(countMask(buildRowMask(t, []))).toBe(6);
  });
  it('ANDs conditions together', () => {
    const mask = buildRowMask(t, [
      { column: 'answer', op: 'eq', value: 'A' },
      { column: 'score', op: 'gte', value: 30 },
    ]);
    expect(mask).toEqual([false, false, true, false, false, true]);
    expect(countMask(mask)).toBe(2);
  });
  it('drops rows with missing values in a filtered column', () => {
    const mask = buildRowMask(t, [{ column: 'score', op: 'lt', value: 1000 }]);
    expect(mask[3]).toBe(false);
    expect(countMask(mask)).toBe(5);
  });
});

describe('validateConditions', () => {
  it('rejects unknown columns, ops, empty values, and non-numeric bounds', () => {
    const problems = validateConditions(t, [
      { column: 'nope', op: 'eq', value: 1 },
      { column: 'score', op: 'like', value: 1 },
      { column: 'score', op: 'in', value: [] },
      { column: 'score', op: 'gt', value: 'high' },
    ]);
    expect(problems).toHaveLength(4);
    expect(problems[0]).toMatch(/not a column/);
    expect(problems[1]).toMatch(/not an op/);
    expect(problems[2]).toMatch(/no value/);
    expect(problems[3]).toMatch(/numeric value/);
  });
  it('accepts a well-formed list', () => {
    expect(validateConditions(t, [{ column: 'answer', op: 'in', value: ['A', 'B'] }])).toEqual([]);
  });
  it('rejects a non-array', () => {
    expect(validateConditions(t, 'answer = A')).toHaveLength(1);
  });
});

describe('describeConditions', () => {
  it('renders a readable summary', () => {
    expect(describeConditions([
      { column: 'answer', op: 'eq', value: 'A' },
      { column: 'score', op: 'gte', value: 30 },
      { column: 'group', op: 'in', value: ['a', 'b'] },
    ])).toBe('answer = A · score ≥ 30 · group in {a, b}');
  });
});

import { validateConditionsForPolicy } from '../rowFilter';
import { analysisProfileOf } from '../validators';
import { policyFor } from '../dataPolicy';

describe('validateConditionsForPolicy — a filter may only ask what the profile answers', () => {
  const survey = table({
    participant_id: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10'],
    first_name: ['Rebecca', 'Tom', 'Ana', 'Lee', 'Sam', 'Kim', 'Bo', 'Ada', 'Ivy', 'Max'],
    condition: ['A', 'A', 'A', 'A', 'A', 'B', 'B', 'B', 'B', 'B'],
    site: ['north', 'north', 'north', 'north', 'north', 'north', 'north', 'north', 'north', 'south'],
    age: [21, 34, 45, 29, 52, 38, 41, 27, 33, 60],
  });
  const priv = analysisProfileOf(survey, policyFor('private'));
  const open = analysisProfileOf(survey, policyFor('open'));

  it('open mode allows everything', () => {
    expect(validateConditionsForPolicy(open, [{ column: 'first_name', op: 'eq', value: 'Rebecca' }])).toEqual([]);
  });
  it('private mode refuses identifier columns and columns with no groupable value', () => {
    const p = validateConditionsForPolicy(priv, [
      { column: 'participant_id', op: 'eq', value: 'p1' },
      { column: 'first_name', op: 'contains', value: 'reb' },
    ]);
    expect(p).toHaveLength(2);
    expect(p[0]).toContain('identifier');
    expect(p[1]).toContain('no value covering enough rows');
    expect(p.join(' ')).not.toContain('Rebecca');
  });
  it('a withheld value and a nonexistent value get byte-identical refusals', () => {
    const withheld = validateConditionsForPolicy(priv, [{ column: 'site', op: 'eq', value: 'south' }]);
    const missing = validateConditionsForPolicy(priv, [{ column: 'site', op: 'eq', value: 'east' }]);
    expect(withheld).toHaveLength(1);
    expect(withheld[0].replace('south', 'X')).toBe(missing[0].replace('east', 'X'));
    expect(withheld[0]).toContain('Listed values: north');
  });
  it('listed values and numeric comparisons pass', () => {
    expect(validateConditionsForPolicy(priv, [
      { column: 'condition', op: 'in', value: ['A', 'B'] },
      { column: 'age', op: 'gte', value: 30 },
      { column: 'site', op: 'neq', value: 'north' },
    ])).toEqual([]);
  });
});

import { subsetTable, scatterBack } from '../rowFilter';

describe('subsetTable / scatterBack', () => {
  it('keeps only masked rows, in order, across every column', () => {
    const sub = subsetTable(t, [true, false, true, false, false, true]);
    expect(sub.nRows).toBe(3);
    expect(sub.columns).toEqual(t.columns);
    expect(sub.data.id).toEqual([1, 3, 6]);
    expect(sub.data.answer).toEqual(['A', 'A', 'A']);
  });
  it('scatters subset results back with null for hidden rows', () => {
    expect(scatterBack(6, [true, false, true, false, false, true], ['x', 'y', 'z'])).toEqual(['x', null, 'y', null, null, 'z']);
  });
});
