import { expect, it, vi } from 'vitest';
import { MUTATING_TOOLS, runAssistantTurn, toolsFor, type AppBridge } from '../assistant';
import { policyFor } from '../dataPolicy';
import { call, replayTransport, say } from '../replay';

const state = () => ({ datasets: [{ name: 'private sample', nRows: 100, active: true, dataMode: 'private' }], columns: [],
  axes: { x: '', y: '', z: null }, colorBy: '', shapeBy: '', viewMode: '2D', pinnedViews: 0, rowFilter: null,
  clusterSettings: { method: 'NONE', eps: .5, minSamples: 5, k: 3, standardize: true },
  clusterBreakdown: { attribute: '', direction: 'cluster', palette: 'PrimaryBlue' }, pcaRuns: [] });

it('offers all decomposition job tools privately while keeping MICE out of synchronous PCA choices', () => {
  const registry = toolsFor(policyFor('private')).filter(tool => tool.type === 'function').map(tool => tool.function);
  for (const name of ['start_pca_imputations', 'pca_imputation_job', 'cancel_pca_imputations', 'apply_pca_imputation',
    'impute_efa', 'stability_efa', 'get_efa_stability', 'complete_efa_values', 'retry_efa', 'analyze_decomposition_items']) expect(registry.some(tool => tool.name === name)).toBe(true);
  const pca = registry.find(tool => tool.name === 'run_pca')!;
  const parameters = pca.parameters as { properties: { missing: { enum: string[] } } };
  expect(parameters.properties.missing.enum).toEqual(['mean', 'median', 'complete', 'pairwise', 'iterative']);
  for (const name of ['start_pca_imputations', 'cancel_pca_imputations', 'apply_pca_imputation', 'impute_efa', 'stability_efa', 'complete_efa_values'])
    expect(MUTATING_TOOLS.has(name)).toBe(true);
  expect(MUTATING_TOOLS.has('pca_imputation_job')).toBe(false);
  expect(MUTATING_TOOLS.has('get_efa_stability')).toBe(false);
});

it('routes PCA start/poll/apply with chain, predictor and measurement settings unchanged', async () => {
  const pcaImputations = vi.fn((action, args) => JSON.stringify({ action, args, jobId: 'pca-test' }));
  const bridge = { current: { getState: state, pcaImputations } as unknown as AppBridge };
  const request = { variables: ['a', 'b'], n_components: 1, standardize: false, label: 'scale',
    imputations: 3, iterations: 5, seed: 912, predictors: { a: ['b'], b: ['a'] }, predictor_encoding: 'rank', measurements: { a: 'ordinal' } };
  const transport = replayTransport([
    ctx => { expect(ctx.system).toContain('observed-data FIML'); return call('start_pca_imputations', request); },
    call('pca_imputation_job', { jobId: 'pca-test' }),
    call('apply_pca_imputation', { jobId: 'pca-test', imputation: 2 }), say('Selected fit applied.'),
  ]);
  await runAssistantTurn('', '', 'replay', [], 'Use MICE PCA', bridge, { onText() {}, onToolUse() {} }, transport);
  expect(pcaImputations.mock.calls).toEqual([
    ['start_pca_imputations', request], ['pca_imputation_job', { jobId: 'pca-test' }], ['apply_pca_imputation', { jobId: 'pca-test', imputation: 2 }],
  ]);
});

it.each(['impute_efa', 'stability_efa', 'get_efa_stability', 'complete_efa_values', 'retry_efa'])('routes %s through the real assistant dispatcher', async action => {
  const efa = vi.fn(async () => 'accepted'), args = { runId: 'saved-fit', options: { seed: 123 } };
  const bridge = { current: { getState: state, efa } as unknown as AppBridge };
  const transport = replayTransport([call(action, args), say('accepted')]);
  await runAssistantTurn('', '', 'replay', [], 'Run the requested analysis', bridge, { onText() {}, onToolUse() {} }, transport);
  expect(efa).toHaveBeenCalledWith(action, args);
});


it('routes the shared item adviser as a read-only tool with measurement and paging options', async () => {
  const analyzeDecomposition = vi.fn(async () => JSON.stringify({ version: 'decomposition-advice/1', recommendations: [] }));
  const bridge = { current: { getState: state, analyzeDecomposition } as unknown as AppBridge };
  const args = { variables: ['a', 'b', 'c'], method: 'efa', measurements: { a: 'ordinal' }, orders: { a: [1, 2, 3] }, offset: 0, limit: 10 };
  const transport = replayTransport([call('analyze_decomposition_items', args), say('Review the suggested methods.')]);
  await runAssistantTurn('', '', 'replay', [], 'Assess these items', bridge, { onText() {}, onToolUse() {} }, transport);
  expect(analyzeDecomposition).toHaveBeenCalledWith(args);
  expect(MUTATING_TOOLS.has('analyze_decomposition_items')).toBe(false);
  expect(MUTATING_TOOLS.has('retry_efa')).toBe(true);
});

it('forwards explicit iterative-PCA controls without treating a pending fit as applied', async () => {
  const runPCA = vi.fn(() => JSON.stringify({ status: 'nonconverged', applied: false }));
  const bridge = { current: { getState: state, runPCA } as unknown as AppBridge };
  const args = { variables: ['a', 'b', 'c'], missing: 'iterative', iterative: { maxIterations: 1000, tolerance: 1e-8, rank: 2 } };
  const transport = replayTransport([call('run_pca', args), say('The convergence dialog is open.')]);
  await runAssistantTurn('', '', 'replay', [], 'Retry PCA', bridge, { onText() {}, onToolUse() {} }, transport);
  expect(runPCA).toHaveBeenCalledWith(args);
});
