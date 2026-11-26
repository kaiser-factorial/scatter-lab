import type { ChatCompletionTool } from 'openai/resources/chat/completions';

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ChatCompletionTool => ({
  type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});
const job = { jobId: { type: 'string', description: 'Job ID returned by start_pca_imputations.' } };
export const PCA_BATCH_TOOLS: ChatCompletionTool[] = [
  tool('start_pca_imputations',
    'Start asynchronous ordinal MICE followed by a separate PCA for each completed dataset. Returns a job ID; poll pca_imputation_job, then explicitly select a completed imputation with apply_pca_imputation before adding scores. No scores or imputed input cells are published automatically. Fitting uses the active row filter and original observed-pair support floor. These conditional models require ordered categorical numeric items, including explicit item-type overrides. Continuous data need a supported numeric missing-value method. Results are separate fits, not pooled inference or averaged scores.', {
      variables: { type: 'array', minItems: 2, uniqueItems: true, items: { type: 'string' } },
      n_components: { type: 'integer', minimum: 1, maximum: 10, description: 'Components per fit, at most the selected item count; default 3.' },
      standardize: { type: 'boolean', description: 'Use correlation PCA; default true.' },
      label: { type: 'string', description: 'Semantic run label; individual fit names include the imputation index.' },
      measurements: { type: 'object', additionalProperties: { type: 'string', enum: ['auto', 'ordinal', 'continuous'] } },
      imputations: { type: 'integer', minimum: 2, maximum: 100, description: 'Independent completed datasets; default 20.' },
      iterations: { type: 'integer', minimum: 1, maximum: 100, description: 'Conditional-model sweeps per chain; default 10.' },
      seed: { type: 'integer', description: 'Reproducible seed; default 73021.' },
      predictors: { type: 'object', additionalProperties: { type: 'array', uniqueItems: true, items: { type: 'string' } }, description: 'Optional target-item to predictor-item name mapping; omitted targets use all other selected items.' },
      predictor_encoding: { type: 'string', enum: ['ordered-polynomial', 'rank'], description: 'Default ordered-polynomial matches ordered-category contrasts.' },
    }, ['variables']),
  tool('pca_imputation_job', 'Read aggregate-only PCA imputation job status, progress, settings, completed-fit variance summaries and failures. No row values or score vectors are returned. Changed dataset/filter identities invalidate publication.', job, ['jobId']),
  tool('cancel_pca_imputations', 'Cancel a running PCA imputation batch and terminate its worker. Cancellation publishes no scores.', job, ['jobId']),
  tool('apply_pca_imputation', 'Explicitly add scores from one completed PCA imputation fit to the same active dataset and fitting filter. Original input cells stay unchanged. Select the one-based imputation number reported by pca_imputation_job; this does not average fits or pool uncertainty. Existing matching score labels may be replaced.', { ...job,
    imputation: { type: 'integer', minimum: 1, description: 'One-based completed imputation number.' },
  }, ['jobId', 'imputation']),
];
