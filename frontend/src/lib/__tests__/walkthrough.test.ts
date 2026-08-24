import { describe, expect, it } from 'vitest';
import {
  WALKTHROUGH, WALKTHROUGH_STEPS, FIRST_STEP,
  walkthroughStep, walkthroughIndex, assistantGreeting,
} from '../walkthrough';
import { GUIDE_TARGETS } from '../assistant';
import type { AppBridge } from '../assistant';

// The walkthrough's failure mode is not a wrong number, it is a dead end: a
// button whose `next` names a step that was renamed, or a step nothing reaches.
// Neither shows up in a type check — both are trivially provable here.
describe('walkthrough graph', () => {
  const ids = WALKTHROUGH.map(s => s.id);

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
  for (const action of walkthroughStep(stepId)!.run ?? []) await action(bridge);
  return calls;
};

const runWholeTour = async () => {
  const { bridge, calls } = recordingBridge();
  for (const step of WALKTHROUGH) for (const action of step.run ?? []) await action(bridge);
  return calls;
};

describe('walkthrough step actions', () => {
  it('loads the demo at the data-added step, through the taught door', async () => {
    // The tour teaches the upload area FIRST (the Data step's advance button is
    // anchored beside the dropzone), and only then adds the demo — so nothing
    // is prepopulated before the user has seen where data comes from.
    expect(await runAll(FIRST_STEP)).toEqual([]);
    expect(await runAll('data')).toEqual([]);
    expect(await runAll('data-added')).toContainEqual({ method: 'loadDemoData', args: [] });
    const dataStep = walkthroughStep('data')!;
    expect(dataStep.anchorChoice).toBe(true);
    expect(dataStep.highlight).toBe('upload-dropzone');
    expect(dataStep.choices[0].next).toBe('data-added');
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
      for (const action of step.run ?? []) await action(bridge);
      expect(c.some(x => (x.args[0] as { shape_by?: string } | undefined)?.shape_by),
        `${step.id} sets the shape channel too early`).toBeFalsy();
    }
  });

  it('leaves the plot rotating for the comparison, and stops it at the end', async () => {
    expect(await runAll('compare')).toContainEqual(
      { method: 'controlView', args: [{ rotation: 'start' }] });
    expect(await runAll('done')).toContainEqual(
      { method: 'controlView', args: [{ rotation: 'stop' }] });
  });

  it('moves the panel out of the way before it pins a second pane', async () => {
    // Pinning while the panel is docked right splits the leftover strip into
    // two unreadable slivers, so the dock move has to come first.
    const calls = await runAll('compare');
    const docked = calls.findIndex(c => c.method === 'setAssistantDock');
    expect(calls[docked]?.args).toEqual(['bottom']);
    expect(docked).toBeLessThan(calls.findIndex(c => c.method === 'pinView'));
  });

  it('returns the live view to the flower measurements after pinning the 2D one', async () => {
    const calls = await runAll('compare');
    const pinnedAt = calls.findIndex(c => c.method === 'pinView');
    const last = calls.filter(c => c.method === 'setPlot').at(-1)!;
    expect(pinnedAt).toBeGreaterThan(0);
    expect(calls.indexOf(last)).toBeGreaterThan(pinnedAt);
    expect(last.args[0]).toMatchObject({ view_mode: '3D', x: 'PetalLengthCm' });
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
