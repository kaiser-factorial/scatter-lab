import { describe, it, expect } from 'vitest';
import { toolsFor, buildSystemPrompt, type AppBridge } from '../assistant';
import { policyFor } from '../dataPolicy';

type DS = { name: string; nRows: number; active: boolean; dataMode: 'private' | 'open' };

const bridgeWith = (datasets: DS[]): AppBridge => ({
  getState: () => ({
    datasets,
    columns: [],
    axes: { x: 'a', y: 'b', z: null },
    colorBy: 'a',
    shapeBy: '',
    viewMode: '2D' as const,
    pinnedViews: 0, rowFilter: null,
    clusterSettings: { method: 'NONE', eps: 0.5, minSamples: 5, k: 3, standardize: false },
    clusterBreakdown: { attribute: '', direction: 'cluster' as const, palette: 'Viridis' as const },
    pcaRuns: [],
  }),
}) as unknown as AppBridge;

const toolNames = (p: ReturnType<typeof policyFor>) =>
  toolsFor(p).map(t => t.type === 'function' ? t.function.name : '');

describe('dataset summaries in the assistant', () => {
  it.each(['open', 'private'] as const)('withholds row tools even with a legacy %s flag', mode => {
    const names = toolNames(policyFor(mode));
    expect(names).toContain('correlate');
    for (const tool of ['sample_rows', 'get_rows_where', 'list_categories']) expect(names).not.toContain(tool);
    const prompt = buildSystemPrompt(bridgeWith([{ name: 'survey', nRows: 200, active: true, dataMode: mode }]));
    expect(prompt).toContain('never see raw data rows');
    expect(prompt).toContain('survey (200 rows, active)');
    expect(prompt).not.toMatch(/sample_rows|public.open mode|private mode/i);
  });

  it('renders an empty workspace', () => {
    expect(buildSystemPrompt(bridgeWith([]))).toContain('No dataset loaded yet');
  });
});
