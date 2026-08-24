import { describe, it, expect } from 'vitest';
import { runAssistantTurn, type AppBridge } from '../assistant';
import { call, replayTransport, say } from '../replay';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

// Replay cases drive the REAL runAssistantTurn loop — registry, policy,
// executeTool, history bookkeeping — with a scripted transport instead of a
// model. What a case pins down is the tool layer's contract: what the "model"
// is offered, what an execution returns, and that a rejection observation is
// good enough to script a successful revision against.

type DS = { name: string; nRows: number; active: boolean; dataMode: 'private' | 'open' };

// A bridge exposing just what these cases touch; everything else is absent and
// would throw, which is what a case SHOULD do if it wanders off-script.
const bridgeWith = (datasets: DS[], overrides: Partial<Record<string, unknown>> = {}): { current: AppBridge } => ({
  current: {
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
    // A correlate with one real pair — the revision case misspells a column
    // first and corrects it from the observation.
    correlate: (a: string, b: string) =>
      a === 'age' && b === 'score'
        ? 'Pearson r=0.42, Spearman rho=0.40, n=900 (pairwise-complete)'
        : `Tool error: unknown column "${a !== 'age' ? a : b}". Numeric columns: age, score.`,
    ...overrides,
  } as unknown as AppBridge,
});

const run = (
  bridgeRef: { current: AppBridge },
  transport: ReturnType<typeof replayTransport>,
  text = 'go',
  onText: string[] = [],
) =>
  runAssistantTurn('', '', 'replay', [] as ChatCompletionMessageParam[], text, bridgeRef,
    { onText: d => onText.push(d), onToolUse: () => {} }, transport);

describe('replayTransport inside runAssistantTurn', () => {
  it('happy path: one tool call, observation lands, final text returned', async () => {
    const t = replayTransport([
      call('correlate', { col_a: 'age', col_b: 'score' }),
      ctx => say(`They correlate: ${ctx.lastObservation}`),
    ]);
    const history = await run(bridgeWith([{ name: 'survey', nRows: 900, active: true, dataMode: 'private' }]), t);
    expect(t.seen.length).toBe(2);
    expect(t.seen[1].lastObservation).toContain('r=0.42');
    const final = history[history.length - 1];
    expect(final.role).toBe('assistant');
    expect(final.content).toContain('r=0.42');
    // History shape survives the loop: user, assistant+tool_calls, tool, assistant.
    expect(history.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('revision: a misspelled column is corrected from the observation', async () => {
    const t = replayTransport([
      call('correlate', { col_a: 'aeg', col_b: 'score' }),
      ctx => {
        // The observation must be informative enough to revise from.
        expect(ctx.lastObservation).toContain('unknown column "aeg"');
        expect(ctx.lastObservation).toContain('age, score');
        return call('correlate', { col_a: 'age', col_b: 'score' });
      },
      ctx => say(`done: ${ctx.lastObservation}`),
    ]);
    const history = await run(bridgeWith([{ name: 'survey', nRows: 900, active: true, dataMode: 'private' }]), t);
    expect(t.calls.map(c => c.name)).toEqual(['correlate', 'correlate']);
    expect(String(history[history.length - 1].content)).toContain('r=0.42');
  });

  it('private session: row tools are not offered, and a stale call refuses', async () => {
    const t = replayTransport([
      ctx => {
        expect(ctx.toolNames).not.toContain('sample_rows');
        expect(ctx.toolNames).toContain('correlate');
        expect(ctx.system).toContain('PRIVATE — aggregates only');
        // A stale/hallucinated row call must hit the second fence…
        return call('sample_rows', { n: 5 });
      },
      ctx => {
        expect(ctx.lastObservation).toBe('Row access is not available: the session is in Private data mode.');
        return say('understood');
      },
    ]);
    await run(bridgeWith([{ name: 'survey', nRows: 900, active: true, dataMode: 'private' }]), t);
    expect(t.seen.length).toBe(2);
  });

  it('open session offers the row tools', async () => {
    const t = replayTransport([
      ctx => {
        expect(ctx.toolNames).toContain('sample_rows');
        expect(ctx.toolNames).toContain('get_rows_where');
        expect(ctx.toolNames).toContain('list_categories');
        return say('ok');
      },
    ]);
    await run(bridgeWith([{ name: 'iris', nRows: 150, active: true, dataMode: 'open' }]), t);
  });

  it('an exhausted script throws with the last observation in the message', async () => {
    const t = replayTransport([call('correlate', { col_a: 'age', col_b: 'score' })]);
    await expect(run(bridgeWith([{ name: 's', nRows: 9, active: true, dataMode: 'private' }]), t))
      .rejects.toThrow(/scripted 1[\s\S]*r=0\.42/);
  });

  it('streams the scripted text through onText and keeps user text first', async () => {
    const out: string[] = [];
    const t = replayTransport([say('all done')]);
    const history = await run(
      bridgeWith([{ name: 's', nRows: 9, active: true, dataMode: 'private' }]),
      t, 'please check', out,
    );
    expect(history[0]).toEqual({ role: 'user', content: 'please check' });
    expect(history[1]).toEqual({ role: 'assistant', content: 'all done' });
    expect(out.join('')).toBe('all done');
  });
});
