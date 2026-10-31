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
        },
        required: ["column", "categories", "reverse"],
        additionalProperties: false,
      },
    },
    nFactors: { type: "integer", minimum: 1 },
    rotation: { type: "string", enum: ["oblimin", "promax", "varimax"] },
    missing: { type: "string", enum: ["pairwise", "complete"] },
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
  tool(
    "run_efa",
    "Start native ordinal EFA: two-step polychoric (tetrachoric for binary), MINRES, oblimin by default. Require explicitly reviewed category orders; never infer text order. Return a job id; poll efa_job. No scores are added automatically. Saved fits are exploratory. Rotation comparisons reuse a parent extraction; structure-replication freezes a development parent and refits its saved holdout. Ordinal MICE and resampling stability are available in the local EFA panel; this tool currently runs observed-data fits. DWLS/WLSMV are not yet available.",
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
    "efa_job",
    "Read EFA job progress/completion, or cancel a running EFA job. Completed fit jobs return a saved run id. Dataset changes and undo invalidate pending results.",
    { jobId: { type: "string" }, cancel: { type: "boolean" } },
    ["jobId"],
  ),
  tool(
    "get_efa_diagnostics",
    "Read permitted aggregate EFA loadings, factor correlations, communalities, residual RMS and diagnostics. Private mode omits respondent rows, score arrays, thresholds, and rare combinations.",
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
    "Explicitly add ordinal linear regression-score approximations from a saved run. Complete fitting rows only; source columns are never overwritten. Returns column names, never respondent scores.",
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
