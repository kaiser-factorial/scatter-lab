import { describe, it, expect } from 'vitest';
import { runAssistantTurn, type AppBridge } from '../assistant';
import { call, replayTransport, say } from '../replay';
import { formatFailures, MAX_PLAN_REVISIONS, type AnalysisPlan } from '../analysisPlan';
import { analysisProfileOf, validatePlan } from '../validators';
import { formatTestResult, runTestPlan } from '../statTests';
import { compileChart } from '../chartCompile';
import { policyFor } from '../dataPolicy';
import type { DataTable } from '../table';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

// Replay cases for the analysis tools: the full propose → validate → revise
// loop, driven through the REAL runAssistantTurn against a bridge that runs
// the REAL validator and executors — exactly the pipeline page.tsx wires up.

const table = (data: Record<string, unknown[]>): DataTable => {
  const columns = Object.keys(data);
  return { columns, data: data as DataTable['data'], nRows: data[columns[0]].length };
};

const fixture = table({
  sepal_len: [5.1, 4.9, 6.2, 5.8, 6.4, 5.5, 5.0, 6.0, 5.9, 6.1, 5.2, 9.9],
  species: ['setosa', 'setosa', 'setosa', 'setosa', 'setosa', 'setosa',
            'virginica', 'virginica', 'virginica', 'virginica', 'virginica', 'ghost_orchid'],
});

// The same gate page.tsx implements: validate against the mode's profile,
// then execute; rejections come back as formatted failures.
const bridgeFor = (mode: 'private' | 'open'): { current: AppBridge } => {
  const profile = analysisProfileOf(fixture, policyFor(mode));
  const gate = (plan: unknown): string => {
    const failures = validatePlan(plan, profile);
    if (failures.length) return formatFailures(failures);
    const p = plan as AnalysisPlan;
    if (p.kind === 'test') return formatTestResult(runTestPlan(p, fixture, profile));
    return compileChart(p, fixture, profile).summary;
  };
  return {
    current: {
      getState: () => ({
        datasets: [{ name: 'iris', nRows: 12, active: true, dataMode: mode }],
        columns: [], axes: { x: 'a', y: 'b', z: null }, colorBy: 'a', shapeBy: '',
        viewMode: '2D' as const, pinnedViews: 0,
        clusterSettings: { method: 'NONE', eps: 0.5, minSamples: 5, k: 3, standardize: false },
        clusterBreakdown: { attribute: '', direction: 'cluster' as const, palette: 'Viridis' as const },
        pcaRuns: [],
      }),
      runTest: gate,
      plotChart: gate,
    } as unknown as AppBridge,
  };
};

const run = (mode: 'private' | 'open', t: ReturnType<typeof replayTransport>) =>
  runAssistantTurn('', '', 'replay', [] as ChatCompletionMessageParam[], 'go', bridgeFor(mode),
    { onText: () => {}, onToolUse: () => {} }, t);

describe('run_test through the loop', () => {
  it('happy path: t-test result reaches the model with p, CI, effect', async () => {
    const t = replayTransport([
      call('run_test', { test: 't', column: 'sepal_len', group_by: 'species', groups: ['setosa', 'virginica'] }),
      ctx => {
        expect(ctx.lastObservation).toContain('t=');
        expect(ctx.lastObservation).toContain('95% CI');
        expect(ctx.lastObservation).toContain("Cohen's d");
        return say('done');
      },
    ]);
    await run('open', t);
  });

  it('misspelled column → typed rejection → scripted revision succeeds', async () => {
    const t = replayTransport([
      call('run_test', { test: 't', column: 'sepal_length', group_by: 'species', groups: ['setosa', 'virginica'] }),
      ctx => {
        expect(ctx.lastObservation).toContain('[unknown_column]');
        expect(ctx.lastObservation).toContain('Available: sepal_len');
        return call('run_test', { test: 't', column: 'sepal_len', group_by: 'species', groups: ['setosa', 'virginica'] });
      },
      ctx => {
        expect(ctx.lastObservation).toContain('t=');
        return say('revised and done');
      },
    ]);
    await run('open', t);
  });

  it('private mode: probing the withheld group reads as nonexistent', async () => {
    const t = replayTransport([
      call('run_test', { test: 't', column: 'sepal_len', group_by: 'species', groups: ['setosa', 'ghost_orchid'] }),
      ctx => {
        expect(ctx.lastObservation).toContain('[unknown_group_value]');
        expect(ctx.lastObservation).toContain('Available: setosa, virginica');
        expect(ctx.lastObservation).not.toMatch(/withheld|privacy|rare/i);
        return say('cannot compare that');
      },
    ]);
    await run('private', t);
  });

  it('the revision cap is enforced in the loop, not just prompted', async () => {
    const bad = () => call('run_test', { test: 't', column: 'nope', group_by: 'species', groups: ['setosa', 'virginica'] });
    const steps = [bad(), bad(), bad(), bad(),
      (ctx: { lastObservation: string | null }) => {
        expect(ctx.lastObservation).toContain(`Revision limit reached (${MAX_PLAN_REVISIONS})`);
        expect(ctx.lastObservation).toContain('do NOT retry');
        return say('giving up, asking the user');
      },
    ];
    const t = replayTransport(steps);
    await run('open', t);
    expect(t.calls.length).toBe(4);
  });
});

describe('plot_chart through the loop', () => {
  it('grouped ECDF returns quantile summaries, not values', async () => {
    const t = replayTransport([
      call('plot_chart', { mark: 'ecdf', column: 'sepal_len', group_by: 'species' }),
      ctx => {
        expect(ctx.lastObservation).toContain('median=');
        expect(ctx.lastObservation).toContain('setosa: n=6');
        return say('plotted');
      },
    ]);
    await run('open', t);
  });

  it('line without a temporal column enumerates none and rejects', async () => {
    const t = replayTransport([
      call('plot_chart', { mark: 'line', column: 'sepal_len', x: 'species' }),
      ctx => {
        expect(ctx.lastObservation).toContain('[not_temporal]');
        return say('no time column here');
      },
    ]);
    await run('open', t);
  });

  it('bins out of range → bad_bins with the legal range in the fix', async () => {
    const t = replayTransport([
      call('plot_chart', { mark: 'histogram', column: 'sepal_len', bins: 300 }),
      ctx => {
        expect(ctx.lastObservation).toContain('[bad_bins]');
        expect(ctx.lastObservation).toContain('5–100');
        return call('plot_chart', { mark: 'histogram', column: 'sepal_len', bins: 10 });
      },
      ctx => {
        expect(ctx.lastObservation).toContain('Counts per bin');
        return say('fixed');
      },
    ]);
    await run('open', t);
  });
});
