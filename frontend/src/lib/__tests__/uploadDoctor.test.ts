import { describe, it, expect } from 'vitest';
import type { DataTable } from '../table';
import { cleanNumericText, diagnoseTable, summarizeDiagnosis, applyNumericFix } from '../uploadDoctor';

const table = (data: Record<string, unknown[]>): DataTable => {
  const columns = Object.keys(data);
  return { columns, data, nRows: data[columns[0]].length };
};

describe('cleanNumericText — formatted numbers asNumber rejects', () => {
  it('parses currency, percent, and grouped formats', () => {
    expect(cleanNumericText('$1,234.50')).toBe(1234.5);
    expect(cleanNumericText('€ 1.234,56')).toBe(1234.56);
    expect(cleanNumericText('45%')).toBe(45);
    expect(cleanNumericText('3,14')).toBe(3.14);
    expect(cleanNumericText('1 234')).toBe(1234);
    expect(cleanNumericText('(120)')).toBe(-120);
    expect(cleanNumericText('1,234,567')).toBe(1234567);
  });

  it('passes plain numbers through', () => {
    expect(cleanNumericText(7)).toBe(7);
    expect(cleanNumericText('7.5')).toBe(7.5);
    expect(cleanNumericText('-3')).toBe(-3);
  });

  it('refuses genuine text, dates, and ambiguity rather than guessing', () => {
    expect(cleanNumericText('hello')).toBeNull();
    expect(cleanNumericText('2026-08-16')).toBeNull();
    expect(cleanNumericText('https://x.test/1234')).toBeNull();
    expect(cleanNumericText('youtube_views=23833')).toBeNull();
    expect(cleanNumericText('')).toBeNull();
    expect(cleanNumericText(null)).toBeNull();
    // "12,34,56" is neither thousands-grouped nor a decimal — leave it alone.
    expect(cleanNumericText('12,34,56')).toBeNull();
  });
});

describe('diagnoseTable', () => {
  it('classifies a source-ledger-like table: nothing numeric, nothing fixable', () => {
    // Mirrors the real failing upload: ids, titles, urls, free text, dates.
    const t = table({
      source_id: ['source:2d8e', 'source:a5b5', 'source:1a01', 'source:d27c'],
      title: ['A dataset', 'Another dataset', 'A talk', 'An interview'],
      url: ['https://a.test/1', 'https://a.test/2', 'https://a.test/3', 'https://a.test/4'],
      supports: ['row counts audited', 'label schema', 'x; youtube_views=23833', 'y; youtube_views=56034'],
      retrieved_at: ['2026-08-16', '2026-08-16', '2026-08-16', '2026-08-16'],
    });
    const diags = diagnoseTable(t);
    expect(diags.find(d => d.col === 'retrieved_at')?.kind).toBe('date-like');
    for (const col of ['source_id', 'title', 'url', 'supports']) {
      expect(diags.find(d => d.col === col)?.kind).toBe('text');
    }
    const summary = summarizeDiagnosis(diags);
    expect(summary).toContain('No column contains numeric values');
    expect(summary).toContain('retrieved_at');
  });

  it('flags formatted-text columns as fixable with their pattern', () => {
    const t = table({
      name: ['a', 'b', 'c', 'd', 'e'],
      revenue: ['$1,200', '$980', '$1,050.25', '$400', '$77'],
      growth: ['12%', '9%', '31%', '4%', '18%'],
    });
    const diags = diagnoseTable(t);
    const revenue = diags.find(d => d.col === 'revenue');
    expect(revenue?.kind).toBe('fixable');
    expect(revenue?.numericAfterFix).toBe(5);
    expect(revenue?.patterns).toContain('currency symbol');
    expect(diags.find(d => d.col === 'growth')?.kind).toBe('fixable');
    expect(summarizeDiagnosis(diags)).toContain('fixable right here');
  });

  it('leaves already-numeric columns alone and does not call them fixable', () => {
    const t = table({ x: [1, 2, 3], label: ['a', 'b', 'c'] });
    const diags = diagnoseTable(t);
    expect(diags.find(d => d.col === 'x')?.kind).toBe('numeric');
    expect(diags.find(d => d.col === 'label')?.kind).toBe('text');
  });

  it('requires 80% of values to parse before offering the fix', () => {
    // 2 of 5 parseable — coercing would null out most of the column.
    const t = table({ mixed: ['$5', '$9', 'call us', 'n/a', 'tbd'] });
    expect(diagnoseTable(t)[0].kind).toBe('text');
  });
});

describe('applyNumericFix', () => {
  it('coerces only the chosen columns, value by value', () => {
    const t = table({
      revenue: ['$1,200', '$980', 'oops'],
      growth: ['12%', '9%', '4%'],
      name: ['a', 'b', 'c'],
    });
    const fixed = applyNumericFix(t, ['revenue']);
    expect(fixed.data.revenue).toEqual([1200, 980, null]);
    expect(fixed.data.growth).toEqual(['12%', '9%', '4%']); // untouched
    expect(fixed.data.name).toEqual(['a', 'b', 'c']);
    expect(fixed.nRows).toBe(3);
    // The original table is not mutated.
    expect(t.data.revenue[0]).toBe('$1,200');
  });
});
