import type { ChatCompletionTool } from "openai/resources/chat/completions";

const spec = {
  type: "object",
  properties: {
    items: {
      type: "array",
      minItems: 3,
      maxItems: 500,
      items: {
        type: "object",
        properties: {
          column: { type: "string" },
          categories: {
            type: "array",
            items: { anyOf: [{ type: "string" }, { type: "number" }] },
          },
          reverse: { type: "boolean" },
          measurement: { type: 'string', enum: ['auto', 'ordinal', 'continuous'] },
        },
        required: ["column", "categories", "reverse"],
        additionalProperties: false,
      },
    },
    extraction: { type: "string", enum: ["minres", "ml", "wlsmv", "dwls"], description: 'UI choices are MINRES, ML and WLSMV. DWLS remains available for legacy reproductions.' },
    likelihood: { type: 'object', properties: {
      maxIterations: { type: 'integer', minimum: 10, maximum: 20000 },
      tolerance: { type: 'number', minimum: 1e-10, maximum: 1e-3 },
      starts: { type: 'integer', minimum: 1, maximum: 20 },
      uniquenessFloor: { type: 'number', minimum: 1e-8, maximum: 0.1 },
    }, additionalProperties: false, description: 'ML/FIML optimizer settings. Defaults: 2000 iterations, tolerance 1e-7, 3 deterministic starts, uniqueness floor 1e-6 of observed variance. Results record resolved settings and convergence.' },
    correlation: { type: 'string', enum: ['auto', 'polychoric', 'pearson'], description: 'Independent of missing-value policy. Auto detects fitting-sample measurement levels; all ordinal items use polychoric, numeric continuous/mixed items use Pearson. Use explicit item measurement/category overrides when known.' },
    compute: { type: "object", properties: {
      backend: { type: "string", enum: ["cpu", "webgpu", "scala"] },
      blockSize: { type: "integer", enum: [32, 64, 128, 256] },
      memoryMiB: { type: "integer", minimum: 256, maximum: 4096 },
      correction: { type: "string", enum: ["exact", "estimated"] },
      probes: { type: "integer", minimum: 16, maximum: 4096 },
      probeSeed: { type: "integer", minimum: 0, maximum: 4294967295 },
    }, required: ["backend"], additionalProperties: false },
    nFactors: { type: "integer", minimum: 1 },
    rotation: { type: "string", enum: ["oblimin", "promax", "varimax"] },
    missing: { type: "string", enum: ["pairwise", "complete", "mean", "median", "fiml"], description: "Ordinal median stays in category; ordinal mean maps to nearest declared category, ties lower order. Continuous items keep exact numeric replacements. FIML requires ML and numeric Pearson treatment, and estimates from observed cells without imputing them. ML does not accept pairwise deletion. Replacements use fitting respondents only." },
    seed: { type: "integer" },
    label: { type: "string" },
    sample: {
      type: "object",
      properties: {
        partition: { type: "string", enum: ["all", "development", "holdout"] },
        splitId: { type: "string" },
      },
      required: ["partition"],
      additionalProperties: false,
    },
  },
  required: [
    "items",
    "nFactors",
    "rotation",
    "missing",
    "seed",
    "label",
    "sample",
  ],
  additionalProperties: false,
};
const tool = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): ChatCompletionTool => ({
  type: "function",
  function: {
    name,
    description,
    parameters: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  },
});
export const EFA_TOOLS: ChatCompletionTool[] = [
  tool('retry_efa', 'Retry the latest nonconverged ML/FIML fit with explicit numerical settings, preserving its captured dataset, fitting rows, item transforms and model. Rejects stale dataset/filter changes. No unconverged EFA result is published. Discuss the diagnostic and settings; do not silently relax tolerance. Returns a new job ID for efa_job.', {
    jobId: { type: 'string' },
    settings: { ...spec.properties.likelihood, required: ['maxIterations', 'tolerance'] },
  }, ['jobId', 'settings']),
  tool(
    "list_efa_runs",
    "List saved observed-data and MICE EFA analyses, with review revisions, method and sample metadata. At most 20 per page.",
    {
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 20 },
    },
    [],
  ),
  tool(
    "get_efa_items",
    "Read at most 20 items × 12 factors from a saved EFA. Includes pattern/structure coefficients, primary and next absolute pattern loadings, gap, communality, uniqueness, related-item correlations (polychoric or Pearson, as recorded in the fit), review status and available within-fit SEs. Factors are one-based in output; offsets are zero-based. Primary/next scan all factors. MICE view=imputation-summary returns aligned descriptive dispersion, NOT pooled SEs; view=fit can select a one-based imputation. Failed imputations stay recorded. Private mode never returns local notes, thresholds, replacements or respondent scores. Read reviewRevision before changing items.",
    {
      runId: { type: "string" },
      columns: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: { type: "string" },
      },
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 20 },
      factorOffset: { type: "integer", minimum: 0 },
      factorLimit: { type: "integer", minimum: 1, maximum: 12 },
      view: { type: "string", enum: ["fit", "imputation-summary"] },
      imputation: { type: "integer", minimum: 1 },
    },
    ["runId"],
  ),
  tool(
    "update_efa_items",
    "Edit the SAME visible retain/investigate/exclude statuses and substantive notes as the local EFA table. Supply the current reviewRevision to prevent overwriting newer edits; on conflict reread. Each change is explicit, and does not refit or add scores. Retain and investigate remain included. Consider content coverage and redundant items as well as loading metrics; no cutoff determines an ideal item set. Notes stay local in private mode.",
    {
      runId: { type: "string" },
      expectedReviewRevision: { type: "integer", minimum: 0 },
      changes: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: {
          type: "object",
          properties: {
            column: { type: "string" },
            status: {
              type: "string",
              enum: ["retain", "investigate", "exclude"],
            },
            note: { type: "string", maxLength: 2000 },
          },
          required: ["column", "status", "note"],
          additionalProperties: false,
        },
      },
    },
    ["runId", "expectedReviewRevision", "changes"],
  ),
  tool(
    "refit_efa_selection",
    "Refit the visible retained/investigate item set as a NEW immutable child, preserving its parent and review revision. Supply label and substantive reasons. Default keepRows=true keeps the original fitting respondents; false can admit additional complete cases under the active filter. MICE always keeps fitting rows, removes excluded predictors and regenerates separate imputations with the saved options. Category order, reverse-keying, estimator, rotation and split stay fixed; nFactors can be explicitly changed. Returns job id: poll efa_job. No scores are added automatically.",
    {
      runId: { type: "string" },
      expectedReviewRevision: { type: "integer", minimum: 0 },
      label: { type: "string", minLength: 1, maxLength: 200 },
      reasons: { type: "string", minLength: 1, maxLength: 2000 },
      keepRows: { type: "boolean" },
      nFactors: { type: "integer", minimum: 1 },
    },
    ["runId", "expectedReviewRevision", "label", "reasons"],
  ),

  tool(
    "run_efa",
    "Start EFA. Correlation choice is independent of missing-value handling. Set correlation=auto to infer measurement levels from the fitting sample: all ordinal items use two-step polychoric (tetrachoric for binary); numeric continuous or mixed items use Pearson. Explicit ordinal/continuous item overrides and category orders take precedence; never infer text order. Polychoric supports MINRES, DWLS and WLSMV; Pearson supports MINRES and Gaussian ML. ML requires explicit Pearson or auto-inferred continuous numeric items, and complete/mean/median/FIML handling (not pairwise). FIML uses the observed-data Gaussian likelihood directly; choose likelihood hyperparameters explicitly when requested. Conditional completion is a separate complete_efa_values operation. Column median chooses the lower ordered category for ordinal items, and column mean chooses the nearest declared category (ties lower); continuous columns retain exact numeric replacements. Replacements use fitting respondents only. Weighted uncertainty after single imputation is conditional on the fixed filled categories, without imputation-variance propagation. Omitted correlation preserves legacy missing-policy defaults. The sidebar defaults to Promax; always supply the requested rotation explicitly. Return a job id; poll efa_job. No scores are added automatically. Saved fits are exploratory. Rotation comparisons reuse a parent extraction; structure-replication freezes a development parent and refits its saved holdout. Use impute_efa for separate ordinal MICE fits and stability_efa for bootstrap refits; both expose their hyperparameters and return jobs. Select compute.backend explicitly for WLSMV trace acceleration: webgpu or scala; cpu is the default. Scala requires an already paired local companion; tools cannot pair it or provide endpoints or tokens. Accelerated fits must pass a synthetic numerical self-check. WLSMV applies MV correction and rotated standard errors. compute.correction defaults to exact; estimated requires WebGPU and uses fixed-budget random probes (compute.probes 16–4096, default 128; compute.probeSeed default 61001). Report its approximation label and Monte Carlo uncertainty with the corrected test. Both modes apply MV correction; large jobs can be expensive. Use refit_efa_selection to refine a saved observed or MICE run.",
    {
      spec,
      parentId: { type: "string" },
      kind: {
        type: "string",
        enum: ["fit", "items", "rotation", "structure-replication"],
      },
      reasons: { type: "string" },
    },
    ["spec"],
  ),
  tool(
    'impute_efa',
    'Start separate ordinal MICE imputations and fit EFA to each completion. No Rubin pooling or averaged score columns. Supply explicit category orders and predictor indices (zero-based per target); set missing=pairwise in spec, or complete for ML/Pearson completed fits. Poll efa_job, then get_efa_diagnostics/get_efa_items for the saved batch. Continuous-variable conditional models are not implemented.',
    { spec, options: { type: 'object', properties: {
      imputations: { type: 'integer', minimum: 2, maximum: 100 },
      iterations: { type: 'integer', minimum: 1, maximum: 100 },
      seed: { type: 'integer' },
      predictors: { type: 'array', items: { type: 'array', items: { type: 'integer', minimum: 0 } } },
      predictorEncoding: { type: 'string', enum: ['ordered-polynomial', 'rank'] },
    }, required: ['imputations', 'iterations', 'seed', 'predictors'], additionalProperties: false } },
    ['spec', 'options'],
  ),
  tool(
    'stability_efa',
    'Start respondent or grouped bootstrap refits of a saved individual EFA with its original fitting rows and settings. Reports aligned descriptive intervals and failures; it is not a general validity certificate. Poll efa_job. The group column stays local.',
    { runId: { type: 'string' }, groupColumn: { type: 'string' }, options: { type: 'object', properties: {
      replicates: { type: 'integer', minimum: 2, maximum: 1000 }, seed: { type: 'integer' },
      confidence: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
      crossLoadingThreshold: { type: 'number', minimum: 0 },
    }, required: ['replicates', 'seed', 'confidence', 'crossLoadingThreshold'], additionalProperties: false } },
    ['runId', 'options'],
  ),
  tool(
    'get_efa_stability',
    'Inspect bounded aggregate bootstrap intervals from a saved EFA stability run. Returns no respondent indices, bootstrap samples, or group labels. Intervals describe resampling variation under the saved model; incomplete batches remain provisional.',
    { runId: { type: 'string' }, stabilityId: { type: 'string' },
      offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 },
      factorOffset: { type: 'integer', minimum: 0 }, factorLimit: { type: 'integer', minimum: 1, maximum: 12 } },
    ['runId'],
  ),
  tool(
    'complete_efa_values',
    'Explicitly preserve or locally export conditional expected missing values from a saved ML/FIML fit. columns adds completed copies with source values unchanged; csv exports completed fitting rows; operation downloads input/model/settings/masks/results JSON; code downloads standalone R code that replays that JSON without refitting. FIML itself is likelihood estimation, not imputation. Never returns respondent values to the assistant. Preserve fitting-row and dataset scope.',
    { runId: { type: 'string' }, destination: { type: 'string', enum: ['columns', 'csv', 'operation', 'code'] } },
    ['runId', 'destination'],
  ),
  tool(
    "efa_job",
    "Read EFA job progress/completion, or cancel a running EFA job. Completed fit jobs return a saved run id. Dataset changes and undo invalidate pending results.",
    { jobId: { type: "string" }, cancel: { type: "boolean" } },
    ["jobId"],
  ),
  tool(
    "get_efa_diagnostics",
    "Read bounded run-level EFA diagnostics, convergence, residual RMS and weighted inference. Use get_efa_items for loading/structure values and item reviews. Supports saved observed and MICE analyses. Private mode excludes raw data, rare combinations, notes and diagnostic prose.",
    { runId: { type: "string" } },
    ["runId"],
  ),
  tool(
    "compare_efa",
    "Compare two saved EFA runs on shared items with sign/permutation matching. Reports congruence and unmatched factors. A holdout refit is structure replication, not a validated badge.",
    { runId: { type: "string" }, otherRunId: { type: "string" } },
    ["runId", "otherRunId"],
  ),
  tool(
    "add_efa_scores",
    "Explicitly add linear regression-score approximations from a saved run. Unimputed fits score complete fitting rows; column mean/median fits use saved fitting replacements and the recorded correlation/scoring scale. Excluded rows remain unscored and source columns are never overwritten. Returns column names, never respondent scores.",
    { runId: { type: "string" } },
    ["runId"],
  ),
  tool(
    "parallel_efa",
    "Start an explicit factor parallel-analysis batch. Default 100 permutations, 95th percentile, same one-factor MINRES communality convention for observed and null data, missingness masks preserved. May be slow at 500 items. Returns a job id; failures are retained and incomplete jobs give no definitive suggestion.",
    { spec, replicates: { type: "integer", minimum: 1, maximum: 1000 } },
    ["spec"],
  ),
];
