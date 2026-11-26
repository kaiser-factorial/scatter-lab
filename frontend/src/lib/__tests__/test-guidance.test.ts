import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_GUIDE_OVERVIEW, appGuideContext } from '../app-guide';
import { createAppReferenceReader } from '../app-reference';
import { runAssistantTurn, toolsFor, type AppBridge } from '../assistant';
import { policyFor } from '../dataPolicy';
import { DISCLOSURES } from '../disclosures';
import { APP_REFERENCE_MANIFEST } from '../generated/app-reference-manifest';
import { searchMethods } from '../methods';
import { call, replayTransport, say } from '../replay';

// Assert the release contract at each reader-facing entry point. In particular,
// a corrected tool schema must not be contradicted by a later methods lookup.
const expectReleaseGuidance = (text: string) => {
  expect(text).toContain('four tests');
  expect(text).toContain('KS inference is temporarily unavailable');
  expect(text).toContain('Descriptive ECDF charts remain available');
  expect(text).toContain('Paired and clustered inference is unsupported');
  expect(text).toContain('only when the user has confirmed independent observations for this analysis');
  expect(text).toContain('If the design is unclear, ask the user');
  expect(text).toContain('Do not substitute another hypothesis');
  expect(text).toMatch(/Welch's t: exactly two independent groups, at least 2 usable numeric observations/);
  expect(text).toContain('positive within-group variance in at least one group');
  expect(text).toMatch(/Mann–Whitney U: exactly two independent groups, at least 8 usable numeric observations/);
  expect(text).toContain('normal approximation without continuity correction');
  expect(text).toMatch(/Kruskal–Wallis: at least two independent groups, at least 5 usable numeric observations/);
  expect(text).toContain('not all observations equal');
  expect(text).toContain('positive row and column margins');
  expect(text).toContain('every expected cell count at least 5');
  expect(text).toContain('without Yates correction');
  expect(text).toContain('after missing/unusable values are excluded');
  expect(text).toContain('Reporting additionally requires at least 5 usable observations');
  expect(text).toContain('Nonfinite or degenerate results are rejected');
  expect(text).not.toMatch(/five tests|exact (?:two-sided )?p(?:-value|\b)/i);
};

const bridge = {
  getState: () => ({
    datasets: [{ name: 'example', nRows: 30, active: true, dataMode: 'private' }],
    columns: [], axes: { x: '', y: '', z: null }, colorBy: '', shapeBy: '',
    viewMode: '2D', pinnedViews: 0, rowFilter: null,
    clusterSettings: { method: 'NONE', eps: .5, minSamples: 5, k: 3, standardize: true },
    clusterBreakdown: { attribute: '', direction: 'cluster', palette: 'PrimaryBlue' },
    pcaRuns: [],
  }),
} as unknown as AppBridge;

describe('statistical guidance agrees with the released assistant capabilities', () => {
  it.each(['private', 'open'] as const)('includes eligibility and approximation requirements in the %s tool', mode => {
    const tool = toolsFor(policyFor(mode)).find(item => item.type === 'function' && item.function.name === 'run_test');
    if (!tool || tool.type !== 'function') throw new Error('run_test tool missing');
    expectReleaseGuidance(tool.function.description ?? '');
    const parameters = tool.function.parameters as { properties: { test: { enum: string[] } } };
    expect(parameters.properties.test.enum).toEqual(['t', 'mann_whitney', 'kruskal_wallis', 'chi_square']);
  });

  it('keeps the methods lookup aligned with the execution limits', () => {
    const topic = searchMethods({ topics: ['statistical_tests'] })[0];
    expectReleaseGuidance(topic.text);
    expect(topic.text).not.toContain('which the result flags');
  });

  it.each(['run_test', 'Which statistical tests can I run?', 'KS', 'Mann Whitney', 'paired significance tests'])(
    'automatically supplies the full policy for %s', query => {
      const context = appGuideContext(query);
      expect(context).toContain('[tests]');
      expectReleaseGuidance(context);
    },
  );

  it('keeps the always-injected overview and About entry consistent', () => {
    expect(APP_GUIDE_OVERVIEW).toContain('four tests');
    expect(APP_GUIDE_OVERVIEW).toContain('KS inference is temporarily unavailable');
    const disclosure = DISCLOSURES.statistical_tests;
    expectReleaseGuidance([...disclosure.text, ...(disclosure.more ?? [])].join(' '));
  });

  it('returns the full policy through the real tutorial and methods tool loop', async () => {
    const transport = replayTransport([
      context => {
        expectReleaseGuidance(context.system);
        return call('get_tutorial', { topics: ['analyze'] });
      },
      context => {
        expectReleaseGuidance(context.lastObservation ?? '');
        return call('get_methods_reference', { topics: ['statistical_tests'] });
      },
      context => {
        expectReleaseGuidance(context.lastObservation ?? '');
        return say('The available tests and requirements are shown.');
      },
    ]);
    await runAssistantTurn('', '', 'replay', [], 'Explain the statistical tests and their requirements.',
      { current: bridge }, { onText: () => {}, onToolUse: () => {} }, transport);
    expect(transport.calls.map(tool => tool.name)).toEqual(['get_tutorial', 'get_methods_reference']);
  });

  it('ships a reference snapshot that distinguishes legacy library KS from app availability', async () => {
    const asset = readFileSync(resolve(process.cwd(), 'public' + APP_REFERENCE_MANIFEST.assetPath), 'utf8');
    const reader = createAppReferenceReader(APP_REFERENCE_MANIFEST, async () => new Response(asset));
    const result = JSON.parse(await reader.read({
      path: 'packages/statistics/VALIDATION.md', startLine: 1, lineCount: 120,
    })) as { text: string };
    expect(result.text).toContain('KS inference is disabled in the application');
    expect(result.text).toContain('not an available assistant capability');
    expect(result.text).not.toContain('application defaults remain compatible');
  });

  it('describes the current shared PCA/EFA setup and missing-data choices', async () => {
    const transport = replayTransport([
      call('get_tutorial', { topics: ['pca'] }),
      context => {
        const text = context.lastObservation ?? '';
        expect(text).toContain('3. PCA / EFA');
        expect(text).toContain('Shift-click');
        expect(text).toContain('Pairwise deletion');
        expect(text).toContain('MICE');
        expect(text).toContain('explicitly select one fit');
        expect(text).toContain('FIML is EFA-only');
        expect(text).not.toContain('half the error');
        return say('The current setup and missing-data choices are shown.');
      },
    ]);
    await runAssistantTurn('', '', 'replay', [], 'Explain the PCA setup.',
      { current: bridge }, { onText: () => {}, onToolUse: () => {} }, transport);
  });
});
