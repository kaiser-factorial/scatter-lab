import { describe, it, expect } from 'vitest';
import { numericTails, correlationAllowed, groupComparisonReport } from '../aggregatePolicy';
import { policyFor } from '../dataPolicy';

const priv = policyFor('private');
const open = policyFor('open');

describe('numericTails — an extreme is reported only when enough rows share it', () => {
  it('withholds a lone extreme in private mode and keeps it in open mode', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 987];
    expect(numericTails(sorted, priv)).toEqual({ tailsWithheld: true });
    expect(numericTails(sorted, open)).toEqual({ min: 1, max: 987, tailsWithheld: false });
  });
  it('keeps a shared ceiling (Likert stacked at 7) and withholds the other tail', () => {
    const sorted = [1, 3, 4, 5, 6, 7, 7, 7, 7, 7];
    expect(numericTails(sorted, priv)).toEqual({ max: 7, tailsWithheld: true });
  });
  it('keeps both tails when both are shared by five or more rows', () => {
    const sorted = [0, 0, 0, 0, 0, 3, 5, 5, 5, 5, 5];
    expect(numericTails(sorted, priv)).toEqual({ min: 0, max: 5, tailsWithheld: false });
  });
  it('empty column reports nothing', () => {
    expect(numericTails([], priv)).toEqual({ tailsWithheld: false });
  });
});

describe('correlationAllowed', () => {
  it('needs five complete pairs in private mode, any in open', () => {
    expect(correlationAllowed(4, priv)).toBe(false);
    expect(correlationAllowed(5, priv)).toBe(true);
    expect(correlationAllowed(2, open)).toBe(true);
  });
});

describe('groupComparisonReport — the Codex case: nine rows in one group, one in another', () => {
  const numeric = [10, 11, 12, 13, 14, 15, 16, 17, 18, 987];
  const groups = ['a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'b'];

  it('open mode lists the singleton with its exact value', () => {
    const r = groupComparisonReport('score', 'grp', numeric, groups, open);
    expect(r.ok).toBe(true);
    expect(r.message).toContain('b: mean=987.00');
    expect(r.message).toContain('a single observation');
  });

  it('private mode pools the singleton and never prints its value or its n', () => {
    const r = groupComparisonReport('score', 'grp', numeric, groups, priv);
    expect(r.ok).toBe(true);
    expect(r.message).not.toContain('987');
    expect(r.message).not.toContain('b:');
    expect(r.message).not.toMatch(/n=1\b/);
    expect(r.message).not.toContain('single observation');
    expect(r.message).toContain('1 group below the privacy floor');
    expect(r.message).toContain('a: mean=14.00');
    if (r.ok) { expect(r.withheldGroups).toBe(1); expect(r.withheldRows).toBe(1); }
  });

  it('private mode refuses an identifier column and a column with no groupable value', () => {
    const ids = ['p1', 'p1', 'p2', 'p2', 'p3', 'p3', 'p4', 'p4', 'p5', 'p5'];
    const r = groupComparisonReport('score', 'participant_id', numeric, ids, priv);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('identifier');
    const r2 = groupComparisonReport('score', 'note', [...numeric, ...numeric], ['x', 'x', 'x', 'x', 'y', 'y', 'y', 'y', 'z', 'z', 'z', 'z', 'w', 'w', 'w', 'w', 'v', 'v', 'u', 'u'], priv);
    expect(r2.ok).toBe(false);
    expect(r2.message).toContain('no value covering enough rows');
  });

  it('open mode still refuses one-row-per-group identifiers', () => {
    const r = groupComparisonReport('score', 'id', numeric, numeric.map(String), open);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('one per row');
  });
});
