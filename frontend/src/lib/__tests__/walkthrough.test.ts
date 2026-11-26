import { describe, expect, it } from 'vitest';
import {
  WALKTHROUGH, WALKTHROUGH_STEPS, FIRST_STEP, DEMO_ENTRY,
  walkthroughStep, walkthroughIndex, stepAnchorsChoice, assistantGreeting,
} from '../walkthrough';
import { GUIDE_TARGETS } from '../assistant';
import type { AppBridge } from '../assistant';

// The walkthrough's failure mode is not a wrong number, it is a dead end: a
// button whose `next` names a step that was renamed, or a step nothing reaches.
// Neither shows up in a type check — both are trivially provable here.
describe('walkthrough graph', () => {
  const ids = WALKTHROUGH.map(s => s.id);

  it('explains all three export choices without starting a download', () => {
    const step = walkthroughStep('export')!;
    expect(step.say.split('\n').map(line => line.match(/^- \*\*(.*?)\*\*/)?.[1])).toEqual(['Image', 'Data', 'Analysis record']);
    expect(step.run).toBeUndefined();
  });

  it('has unique step ids', () => {
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('starts at the first step in the array, which is what the timeline draws', () => {
    expect(FIRST_STEP).toBe(ids[0]);
    expect(walkthroughIndex(FIRST_STEP)).toBe(0);
    expect(WALKTHROUGH_STEPS).toBe(WALKTHROUGH.length);
  });

  it('resolves every choice to a real step, or to the end', () => {
    for (const step of WALKTHROUGH) {
      expect(step.choices.length, `${step.id} has no way out`).toBeGreaterThan(0);
      for (const choice of step.choices) {
        if (choice.next === null) continue;
        expect(ids, `${step.id} → "${choice.label}" points at a missing step`).toContain(choice.next);
      }
    }
  });

  it('reaches every step from the first one', () => {
    const seen = new Set<string>();
    const walk = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const c of walkthroughStep(id)!.choices) if (c.next) walk(c.next);
    };
    walk(FIRST_STEP);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it('terminates — some reachable step ends the tour', () => {
    expect(WALKTHROUGH.some(s => s.choices.some(c => c.next === null))).toBe(true);
  });

  it('only points at anchors the app actually renders', () => {
    for (const step of WALKTHROUGH) {
      if (!step.highlight) continue;
      expect(GUIDE_TARGETS, `${step.id} highlights an unknown anchor`).toContain(step.highlight);
    }
  });

});

// Running the steps against a recording bridge, rather than scraping their
// source: what matters is the calls the app receives and their order.
type Call = { method: string; args: unknown[] };

const recordingBridge = () => {
  const calls: Call[] = [];
  const bridge = new Proxy({}, {
    get: (_t, method: string) => (...args: unknown[]) => {
      calls.push({ method, args });
      return `${method} ok`;
    },
  }) as unknown as AppBridge;
  return { bridge, calls };
};

const runAll = async (stepId: string) => {
  const { bridge, calls } = recordingBridge();
  for (const [, action] of walkthroughStep(stepId)!.run ?? []) await action(bridge);
  return calls;
};

const runWholeTour = async () => {
  const { bridge, calls } = recordingBridge();
  for (const step of [DEMO_ENTRY, ...WALKTHROUGH]) for (const [, action] of step.run ?? []) await action(bridge);
  return calls;
};

describe('walkthrough step actions', () => {
  it('opens Iris immediately, then loads the survey only when requested', async () => {
    expect(await runAll(DEMO_ENTRY.id)).toEqual([{ method: 'loadDemoData', args: ['iris'] }]);
    expect(DEMO_ENTRY.choices).toEqual([{ label: 'Begin demo walkthrough', next: FIRST_STEP }]);
    expect((await runAll(FIRST_STEP)).map(call => call.method)).toEqual(['setPlot']);
    expect(await runAll('data')).toEqual([]);
    expect(walkthroughStep('data-added')?.id).toBe('variables');
    expect((await runWholeTour()).filter(call => call.method === 'loadDemoData').map(call => call.args)).toEqual([['iris'], ['survey', 'development']]);
    expect(walkthroughStep('survey')!.choices[0].next).toBe('split');
    expect(walkthroughStep('split')!.choices[0].next).toBe('efa-setup');
    expect(walkthroughStep('efa-setup')!.highlight).toBe('efa-settings');
    expect((await runAll('efa-setup')).map(call => call.method)).toEqual(['configureDemoSurvey']);
    expect(walkthroughStep('efa-setup')!.choices[0].next).toBe('efa');
    expect((await runAll('efa')).map(call => call.method)).toEqual(['fitDemoSurvey']);
    expect((await runAll('scores')).map(call => call.method)).toEqual(['scoreDemoSurvey', 'plotDemoScores']);
    const dataStep = walkthroughStep('data')!;
    expect(stepAnchorsChoice(dataStep)).toBe(true);
    expect(dataStep.highlight).toBe('upload-dropzone');
    expect(dataStep.choices[0].next).toBe('variables');
    expect(WALKTHROUGH.filter(step => step.highlight === 'datasets-list').map(step => step.id)).toEqual(['survey']);
  });

  it('every sidebar-pointing step anchors its advance button; panel steps do not', () => {
    // "Any time we are showing a part of the menu bar, the next button sits by
    // the pointer" — derived from the highlight, so new steps inherit it.
    const anchored = WALKTHROUGH.filter(stepAnchorsChoice).map(s => s.id);
    expect(anchored).toEqual(['data', 'variables', 'pca', 'cluster', 'survey', 'split', 'efa-setup', 'scores', 'export']);
    // welcome has no highlight and done ends the tour — both keep their
    // buttons in the panel.
    expect(stepAnchorsChoice(walkthroughStep('welcome')!)).toBe(false);
    expect(stepAnchorsChoice(walkthroughStep('done')!)).toBe(false);
  });

  it('anchored steps speak without a first person — their bubble is not the chat window', () => {
    for (const step of WALKTHROUGH.filter(stepAnchorsChoice)) {
      expect(step.say, step.id).not.toMatch(/(^|[^A-Za-z])I(['’]| am| have| will|\s)/);
    }
  });

  it('runs the Iris PCA on the four measurements, never on Id', async () => {
    const [call] = await runAll('pca');
    expect(call.method).toBe('runPCA');
    const opts = call.args[0] as { variables: string[]; standardize: boolean };
    expect(opts.variables).toEqual(['SepalLengthCm', 'SepalWidthCm', 'PetalLengthCm', 'PetalWidthCm']);
    expect(opts.variables).not.toContain('Id');
    expect(opts.standardize).toBe(true);
  });

  it('clusters the PC scores without standardizing them', async () => {
    const calls = await runAll('cluster');
    const cluster = calls.find(c => c.method === 'runClustering')!;
    expect(cluster.args[0]).toBe('KMEANS');
    expect(cluster.args[1]).toMatchObject({ k: 3, standardize: false });
  });

  it('introduces the shape channel only after clustering takes over colour', async () => {
    // The initial Iris view is colour-by-Species; demonstrating shape while
    // colour still holds the same variable would encode it twice and show nothing.
    const calls = await runAll('cluster');
    const clusteredAt = calls.findIndex(c => c.method === 'runClustering');
    const shapedAt = calls.findIndex(c =>
      c.method === 'setPlot' && (c.args[0] as { shape_by?: string }).shape_by === 'Species');
    expect(clusteredAt).toBeGreaterThanOrEqual(0);
    expect(shapedAt).toBeGreaterThan(clusteredAt);

    const earlier = WALKTHROUGH.slice(0, walkthroughIndex('cluster'));
    for (const step of earlier) {
      const { bridge, calls: c } = recordingBridge();
      for (const [, action] of step.run ?? []) await action(bridge);
      expect(c.some(x => (x.args[0] as { shape_by?: string } | undefined)?.shape_by === 'Species'),
        `${step.id} sets the shape channel too early`).toBeFalsy();
    }
  });

  it('moves from the Iris species breakdown directly to survey import', async () => {
    const cluster = walkthroughStep('cluster')!;
    expect(cluster.highlight).toBe('cluster-breakdown');
    expect(cluster.choices).toEqual([{ label: 'Load the synthetic survey', next: 'survey' }]);
    expect(await runAll('survey')).toEqual([{ method: 'loadDemoData', args: ['survey', 'development'] }]);
  });

  it('teaches docking without changing the chosen layout', async () => {
    expect((await runWholeTour()).map(call => call.method)).not.toContain('setAssistantDock');
  });

  it('keeps a single live plot throughout the tour', async () => {
    const methods = (await runWholeTour()).map(call => call.method);
    expect(methods).not.toContain('pinView');
    expect(methods).not.toContain('controlView');
  });

  it('never starts a download anywhere in the tour', async () => {
    // The prose tour asked the model not to; a script simply does not contain one.
    const calls = await runWholeTour();
    expect(calls.map(c => c.method).filter(m => /^save/.test(m))).toEqual([]);
  });

  it('never saves a workspace, which undo does not cover', async () => {
    const calls = await runWholeTour();
    expect(calls.map(c => c.method)).not.toContain('saveWorkspaceAs');
  });
});

describe('assistant handoff greeting', () => {
  const state = (over: Partial<ReturnType<AppBridge['getState']>>) => ({
    datasets: [], columns: [], axes: { x: '', y: '', z: null }, colorBy: '', shapeBy: '',
    viewMode: '3D' as const, pinnedViews: 0,
    clusterSettings: { method: 'KMEANS', eps: 0.5, minSamples: 5, k: 3, standardize: false },
    clusterBreakdown: { attribute: '', direction: 'cluster' as const, palette: 'Viridis' as const },
    pcaRuns: [],
    ...over,
  });

  it('offers upload help when nothing is loaded', () => {
    const greeting = assistantGreeting(state({}));
    expect(greeting).toMatch(/do not see a dataset/i);
    expect(greeting).toMatch(/CSV/);
  });

  it('names the active dataset and its size when one is loaded', () => {
    const greeting = assistantGreeting(state({
      datasets: [
        { name: 'spare-dataset', nRows: 5, active: false, dataMode: 'private' as const },
        { name: 'survey', nRows: 3105, active: true, dataMode: 'private' as const },
      ],
      columns: [{ name: 'age' }, { name: 'score' }] as never,
    }));
    expect(greeting).toContain('survey');
    expect(greeting).toContain('3,105');
    expect(greeting).toContain('2 columns');
    expect(greeting).not.toContain('spare-dataset');
  });

  it('does not say "1 columns"', () => {
    const greeting = assistantGreeting(state({
      datasets: [{ name: 'x', nRows: 1, active: true, dataMode: 'private' as const }],
      columns: [{ name: 'only' }] as never,
    }));
    expect(greeting).toContain('1 column');
    expect(greeting).not.toContain('1 columns');
  });
});
