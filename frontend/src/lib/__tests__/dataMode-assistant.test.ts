import { describe, it, expect } from 'vitest';
import { toolsFor, sessionPolicyOf, buildSystemPrompt, type AppBridge } from '../assistant';
import { policyFor } from '../dataPolicy';

// The three layers of the data-mode boundary must switch TOGETHER: which tools
// exist, what the prompt claims, and what the profiles carry. These tests pin
// the first two to the same policy object.

type DS = { name: string; nRows: number; active: boolean; dataMode: 'private' | 'open' };

const bridgeWith = (datasets: DS[]): AppBridge => ({
  getState: () => ({
    datasets,
    columns: [],
    axes: { x: 'a', y: 'b', z: null },
    colorBy: 'a',
    shapeBy: '',
    viewMode: '2D' as const,
    pinnedViews: 0,
    clusterSettings: { method: 'NONE', eps: 0.5, minSamples: 5, k: 3, standardize: false },
    clusterBreakdown: { attribute: '', direction: 'cluster' as const, palette: 'Viridis' as const },
    pcaRuns: [],
  }),
}) as unknown as AppBridge;

const toolNames = (p: ReturnType<typeof policyFor>) =>
  toolsFor(p).map(t => t.type === 'function' ? t.function.name : '');

describe('toolsFor — row tools exist only under an open policy', () => {
  const ROW_TOOLS = ['sample_rows', 'get_rows_where', 'list_categories'];

  it('private policy registers none of the row tools', () => {
    const names = toolNames(policyFor('private'));
    for (const t of ROW_TOOLS) expect(names).not.toContain(t);
  });

  it('open policy registers all of them, on top of the base set', () => {
    const open = toolNames(policyFor('open'));
    const base = toolNames(policyFor('private'));
    for (const t of ROW_TOOLS) expect(open).toContain(t);
    for (const t of base) expect(open).toContain(t);
    expect(open.length).toBe(base.length + ROW_TOOLS.length);
  });
});

describe('sessionPolicyOf — conversation-level minimum', () => {
  it('all open → open', () => {
    expect(sessionPolicyOf(bridgeWith([
      { name: 'iris', nRows: 150, active: true, dataMode: 'open' },
    ]).getState()).rowAccess).toBe(true);
  });

  it('one private dataset locks the session', () => {
    expect(sessionPolicyOf(bridgeWith([
      { name: 'iris', nRows: 150, active: true, dataMode: 'open' },
      { name: 'survey', nRows: 900, active: false, dataMode: 'private' },
    ]).getState()).rowAccess).toBe(false);
  });

  it('no datasets → private', () => {
    expect(sessionPolicyOf(bridgeWith([]).getState()).rowAccess).toBe(false);
  });
});

describe('buildSystemPrompt — the prompt tells the truth about the tools', () => {
  it('private session keeps the aggregates-only guarantee', () => {
    const prompt = buildSystemPrompt(bridgeWith([
      { name: 'survey', nRows: 900, active: true, dataMode: 'private' },
    ]));
    expect(prompt).toContain('never see raw data rows');
    expect(prompt).toContain('privacy guarantee');
    expect(prompt).not.toContain('sample_rows');
    expect(prompt).toContain('PRIVATE — aggregates only');
    expect(prompt).toContain('(900 rows, private, active)');
  });

  it('open session describes the row tools instead', () => {
    const prompt = buildSystemPrompt(bridgeWith([
      { name: 'iris', nRows: 150, active: true, dataMode: 'open' },
    ]));
    expect(prompt).toContain('sample_rows');
    expect(prompt).toContain('declared public/open');
    expect(prompt).not.toContain('never see raw data rows');
    expect(prompt).toContain('OPEN — row tools available');
  });

  it('mixed session runs private and explains why', () => {
    const prompt = buildSystemPrompt(bridgeWith([
      { name: 'iris', nRows: 150, active: false, dataMode: 'open' },
      { name: 'survey', nRows: 900, active: true, dataMode: 'private' },
    ]));
    expect(prompt).toContain('never see raw data rows');
    expect(prompt).toContain('at least one is private');
    expect(prompt).toContain('PRIVATE — aggregates only');
  });

  it('no-dataset prompt still renders (empty session is private)', () => {
    const prompt = buildSystemPrompt(bridgeWith([]));
    expect(prompt).toContain('No dataset loaded yet');
  });
});
