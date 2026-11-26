import { expect, it } from 'vitest';
import { columnReplacement, inferMeasurement } from '../measurement';

it('suggests repeated integer scales but keeps continuous and ambiguous numeric samples continuous', () => {
  expect(inferMeasurement([1, 1, 2, 2, 3, 3]).kind).toBe('ordinal');
  expect(inferMeasurement([1.2, 1.2, 2.8, 2.8]).kind).toBe('continuous');
  expect(inferMeasurement([1, 2, 3, 4]).kind).toBe('continuous');
  expect(inferMeasurement([1, 1, 2, 2], { measurement: 'continuous' }).kind).toBe('continuous');
});
it('keeps an ordinal median in category and maps its mean without creating levels', () => {
  const values = [1, 1, 4, 4, null];
  expect(columnReplacement(values, 'median')).toMatchObject({ value: 1, rule: 'category-median' });
  expect(columnReplacement(values, 'mean')).toMatchObject({ value: 1, rule: 'nearest-category-mean' });
  expect(columnReplacement([1, 4, 4], 'mean', { measurement: 'ordinal', categories: [1, 2, 4] }).value).toBe(2);
  expect(columnReplacement(values, 'mean', { categories: [1, 2, 4] }).value).toBe(2);
  expect(columnReplacement(values, 'median', { categories: [4, 2, 1] }).value).toBe(4);
  expect(values).toEqual([1, 1, 4, 4, null]);
});
it('retains fractional continuous means and medians and permits a categorical override', () => {
  expect(columnReplacement([1, 2, 4, 8, null], 'median').value).toBe(3);
  expect(columnReplacement([1, 2, 4, 8, null], 'mean').value).toBe(3.75);
  expect(columnReplacement([1, 2, 4, 8, null], 'median', { measurement: 'ordinal' }).value).toBe(2);
});
it('requires an explicit text order and uses that order instead of lexical sorting', () => {
  const categories = ['never', 'sometimes', 'often'];
  expect(() => columnReplacement(['often', 'never'], 'median')).toThrow(/explicit ordered/);
  expect(columnReplacement(['often', 'never'], 'median', { categories })).toMatchObject({ value: 'never', rule: 'category-median' });
  expect(columnReplacement(['often', 'never'], 'mean', { categories })).toMatchObject({ value: 'sometimes', rule: 'nearest-category-mean-rank' });
});
