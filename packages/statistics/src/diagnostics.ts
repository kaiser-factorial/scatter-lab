import { materializeSelection, type InputTable, type Selection } from './data';
import { analyzeDecompositionItems, DECOMPOSITION_ADVICE_VERSION, type DecompositionAdviceOptions } from './internal/decomposition-advice';

export { DECOMPOSITION_ADVICE_VERSION };
export type { AdviceClassification, AdviceDistribution, AdviceItem, AdviceIssue, AdvicePatch, AdviceRecommendation, DecompositionAdvice, DecompositionAdviceOptions } from './internal/decomposition-advice';
export type { ConvergenceIssue, ConvergenceFailureReason, ConvergenceRetrySettings, IterativePcaSettings } from './internal/convergence';

/** Local descriptive guidance. Measurement suggestions and distribution flags do
 * not establish measurement meaning, joint normality, or a missingness mechanism.
 * The returned report is NOT a disclosure-filtered assistant message. */
export function analyzeItems(input: InputTable, options: DecompositionAdviceOptions & Selection = {}) {
  const { columns, rows, ...diagnostics } = options;
  const selected = materializeSelection(input, { columns, rows });
  return analyzeDecompositionItems(selected.table, selected.columns, diagnostics);
}
