import { describe, it, expect } from 'vitest';
import { policyFor, combinedPolicy, asDataMode } from '../dataPolicy';

describe('policyFor — what each mode permits', () => {
  it('private mode permits nothing beyond aggregates', () => {
    const p = policyFor('private');
    expect(p.mode).toBe('private');
    expect(p.rowAccess).toBe(false);
    expect(p.fullCategories).toBe(false);
    expect(p.identifiersVisible).toBe(false);
  });

  it('open mode permits row access and full listings', () => {
    const p = policyFor('open');
    expect(p.mode).toBe('open');
    expect(p.rowAccess).toBe(true);
    expect(p.fullCategories).toBe(true);
    expect(p.identifiersVisible).toBe(true);
  });
});

describe('combinedPolicy — the session runs at the minimum', () => {
  it('is open only when every dataset is open', () => {
    expect(combinedPolicy(['open']).rowAccess).toBe(true);
    expect(combinedPolicy(['open', 'open']).rowAccess).toBe(true);
  });

  it('one private dataset makes the whole session private', () => {
    expect(combinedPolicy(['open', 'private']).rowAccess).toBe(false);
    expect(combinedPolicy(['private', 'open', 'open']).rowAccess).toBe(false);
  });

  it('an empty session is private (fail closed)', () => {
    expect(combinedPolicy([]).rowAccess).toBe(false);
  });
});

describe('asDataMode — deserialization fails closed', () => {
  it('accepts the two real modes', () => {
    expect(asDataMode('open')).toBe('open');
    expect(asDataMode('private')).toBe('private');
  });

  it('maps everything else to private', () => {
    // The absent field of a pre-feature workspace, and hand-edited garbage.
    expect(asDataMode(undefined)).toBe('private');
    expect(asDataMode(null)).toBe('private');
    expect(asDataMode('OPEN')).toBe('private');
    expect(asDataMode('public')).toBe('private');
    expect(asDataMode(1)).toBe('private');
    expect(asDataMode({ mode: 'open' })).toBe('private');
  });
});
