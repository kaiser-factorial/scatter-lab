import { asNumber, type DataTable } from '../table';
import { CSV_BOM, csvCell } from '../csv';
import { sanitizeLabel } from '../pca';
import type { ConditionalCompletion } from './maximum-likelihood';
import { EfaError, type EfaRun } from './types';

export interface EfaCompletionRecord {
  id: string;
  runId: string;
  createdAt: string;
  method: 'conditional-gaussian-mean';
  sourceFingerprint: string;
  columns: Record<string, string>;
  filledCells: number;
  rows: number[];
}

/** Publish completed copies; the fitted source columns remain replayable. */
export function addCompletionColumns(table: DataTable, run: EfaRun, completion: ConditionalCompletion) {
  if (!completion.completedCells) throw new EfaError('completion-empty', 'There are no missing fitting cells to complete.');
  if (completion.columns.length !== run.spec.items.length || completion.columns.some((c, j) => c !== run.spec.items[j].column)
    || JSON.stringify(completion.rows) !== JSON.stringify(run.result.fittingRows)
    || completion.values.length !== completion.columns.length || completion.filled.length !== completion.columns.length
    || completion.columns.some((c, j) => !table.data[c] || completion.values[j]?.length !== completion.rows.length || completion.filled[j]?.length !== completion.rows.length))
    throw new EfaError('completion-shape', 'Completion does not match this saved fit.');
  let filledCells = 0;
  completion.rows.forEach((row, i) => {
    if (!Number.isInteger(row) || row < 0 || row >= table.nRows) throw new EfaError('completion-shape', 'A fitting row is outside the source dataset.');
    completion.columns.forEach((source, j) => {
      if (!completion.filled[j][i]) return;
      if (asNumber(table.data[source][row]) !== null) throw new EfaError('completion-observed', 'Completion cannot replace an observed source value.');
      filledCells++;
    });
  });
  if (filledCells !== completion.completedCells) throw new EfaError('completion-shape', 'The completed-cell count does not match the calculation mask.');
  const data = { ...table.data }, columns = table.columns.slice(), mapping: Record<string, string> = {};
  const label = sanitizeLabel(run.spec.label) || 'EFA';
  completion.columns.forEach((source, j) => {
    const base = `${source}_completed_${label}`;
    let target = base, suffix = 2;
    while (columns.includes(target)) target = `${base}_${suffix++}`;
    mapping[source] = target; columns.push(target);
    data[target] = table.data[source].slice();
    completion.rows.forEach((row, i) => {
      if (completion.filled[j][i]) {
        const value = completion.values[j][i];
        if (value == null || !Number.isFinite(value)) throw new EfaError('completion-value', 'A completed value is not finite.');
        data[target][row] = value;
      }
    });
  });
  const record: EfaCompletionRecord = {
    id: crypto.randomUUID(), runId: run.id, createdAt: new Date().toISOString(), method: completion.method,
    sourceFingerprint: run.result.provenance.inputSha256 ?? '', columns: mapping,
    filledCells, rows: completion.rows.slice(),
  };
  return { table: { ...table, columns, data }, record };
}

/** Export only the saved fitting population, with stable one-based source rows. */
export function serializeCompletionCsv(completion: ConditionalCompletion) {
  return CSV_BOM + [
    ['source_row', ...completion.columns].map(csvCell).join(','),
    ...completion.rows.map((row, i) => [row + 1, ...completion.values.map(column => column[i])].map(csvCell).join(',')),
  ].join('\r\n');
}

export function completionOperation(table: DataTable, run: EfaRun, completion: ConditionalCompletion) {
  if (!run.result.likelihood) throw new EfaError('completion-model', 'This fit has no saved likelihood model.');
  return {
    format: 'scatterlab-conditional-completion/1',
    method: completion.method,
    description: 'Conditional expected missing values under the saved Gaussian model; no refit, no random draw, no pooled imputation uncertainty. Rows are zero-based source indices. Observed values are preserved.',
    createdAt: new Date().toISOString(), runId: run.id,
    sourceFingerprint: run.result.provenance.inputSha256,
    engine: run.result.provenance.engine,
    spec: run.spec,
    columns: completion.columns,
    rows: completion.rows,
    input: completion.rows.map(row => completion.columns.map(column => table.data[column][row] ?? null)),
    model: {
      means: run.result.likelihood.means,
      covariance: run.result.likelihood.covariance,
      reverseOffsets: run.result.numericReverseOffsets ?? run.result.imputation?.reverseOffsets ?? completion.columns.map(() => null),
      settings: run.result.likelihood.settings,
      logLikelihood: run.result.likelihood.logLikelihood,
    },
    completed: completion.rows.map((_, i) => completion.values.map(column => column[i])),
    filled: completion.rows.map((_, i) => completion.filled.map(column => column[i])),
    completedCells: completion.completedCells,
  };
}

/** Replays the saved model's conditional means; deliberately does not refit it. */
export const COMPLETION_REPLAY_R = `# Scatter Lab conditional Gaussian completion replay
# Usage: Rscript replay-completion.R operation.json completed.csv
# Dependency: jsonlite. Uses the saved fitted parameters, not a new lavaan fit.
# Expected values are predictions; this operation adds no imputation uncertainty.
args <- commandArgs(trailingOnly = TRUE)
stopifnot(length(args) == 2L)
op <- jsonlite::read_json(args[[1]], simplifyVector = FALSE)
stopifnot(identical(op$format, "scatterlab-conditional-completion/1"))
num <- function(x) if (is.null(x) || identical(x, "")) NA_real_ else as.numeric(x)
rows <- function(x) do.call(rbind, lapply(x, function(row) vapply(row, num, numeric(1))))
input <- rows(op$input)
mu <- unlist(op$model$means)
Sigma <- rows(op$model$covariance)
offsets <- vapply(op$model$reverseOffsets, num, numeric(1))
output <- input
stopifnot(ncol(input) == length(mu), all(dim(Sigma) == length(mu)))
for (i in seq_len(nrow(input))) {
  observed <- which(!is.na(input[i, ]))
  missing <- which(is.na(input[i, ]))
  if (!length(observed) || !length(missing)) next
  values <- input[i, ]
  reverse <- which(!is.na(offsets))
  values[reverse] <- offsets[reverse] - values[reverse]
  solved <- solve(Sigma[observed, observed, drop = FALSE], values[observed] - mu[observed])
  predicted <- mu[missing] + as.vector(Sigma[missing, observed, drop = FALSE] %*% solved)
  reversed <- !is.na(offsets[missing])
  predicted[reversed] <- offsets[missing][reversed] - predicted[reversed]
  output[i, missing] <- predicted
}
colnames(output) <- unlist(op$columns)
result <- data.frame(source_row = unlist(op$rows) + 1L, output, check.names = FALSE)
write.csv(result, args[[2]], row.names = FALSE, na = "")
`;
