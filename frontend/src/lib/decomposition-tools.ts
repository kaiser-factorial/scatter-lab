import type { ChatCompletionTool } from 'openai/resources/chat/completions';

export const DECOMPOSITION_TOOLS: ChatCompletionTool[] = [{ type: 'function', function: {
  name: 'analyze_decomposition_items',
  description: 'Assess the current fitting sample before choosing PCA/EFA settings. Uses the same local deterministic adviser as Analyze selected items in the sidebar. Returns bounded aggregate item-type candidates, missingness/distribution diagnostics, compatible correlation/extraction options, assumptions and explanatory reasons. Defaults to the selected sidebar items. Does not change types, settings, datasets, or fit a model. Integer scales and distribution flags are suggestions, not proof of measurement level, joint Gaussian data, or a missingness mechanism. After discussing an appropriate option, use the existing run tools with explicit settings.',
  parameters: { type: 'object', properties: {
    variables: { type: 'array', minItems: 2, maxItems: 500, uniqueItems: true, items: { type: 'string' } },
    method: { type: 'string', enum: ['pca', 'efa'] },
    measurements: { type: 'object', additionalProperties: { type: 'string', enum: ['auto', 'ordinal', 'continuous'] } },
    orders: { type: 'object', additionalProperties: { type: 'array', items: { anyOf: [{ type: 'number' }, { type: 'string' }] } }, description: 'Only explicitly known category orders; never invent an ordering for text labels.' },
    missing: { type: 'string', enum: ['mean', 'median', 'pairwise', 'complete', 'iterative', 'mice', 'fiml'] },
    offset: { type: 'integer', minimum: 0, description: 'Item-detail page offset; default zero.' },
    limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Item-detail page size; default20.' },
  }, additionalProperties: false },
} }];
