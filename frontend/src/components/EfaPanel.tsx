"use client";

import { EfaBackendControls } from "./EfaBackendControls";
import { InfoTip } from "./InfoTip";
import { mvRuntimeAdvice } from "@/lib/efa/runtime-advice";
import type { EfaService } from "@/lib/efa/service";
import type { EfaComputeSettings } from "@/lib/efa/backends/types";
import { useEffect, useMemo, useState } from "react";
import type { AdvicePatch } from '@/lib/decomposition-advice';
import type { DataTable } from "@/lib/table";
import { proposedCategories } from "@/lib/efa/prepare";
import type { EfaJob } from "@/lib/efa/service";
import type { MiceOptions } from "@/lib/efa/mice";
import type { StabilityOptions } from "@/lib/efa/stability";
import type { InferencePlan } from "@/lib/efa/weighted-inference";
import { EfaResults as Results } from "./EfaResults";
import { ImputationResults } from "./EfaBatchResults";
import { ParallelAnalysisChart } from "./ParallelAnalysisChart";
import { isIdentifierColumn } from "@/lib/defaults";
import { inferMeasurement, type MeasurementChoice } from "@/lib/measurement";
import type {
  EfaSpec,
  EfaState,
  EfaRun,
  ItemReview,
  Rotation,
  SampleSplit,
  ParallelResult,
  OrdinalCategory,
  EfaEstimator,
} from "@/lib/efa/types";

export interface EfaActions {
  impute: (
    spec: EfaSpec,
    options: MiceOptions,
    changes?: {
      parentId?: string;
      reviews?: Record<string, ItemReview>;
      reasons?: string;
    },
  ) => Promise<string>;
  imputationReviews: (id: string, reviews: Record<string, ItemReview>) => void;
  stability: (
    runId: string,
    options: Omit<StabilityOptions, "groups">,
    groupColumn?: string,
  ) => Promise<string>;
  run: (
    spec: EfaSpec,
    options?: {
      parentId?: string;
      kind?: EfaRun["kind"];
      reviews?: Record<string, ItemReview>;
      reasons?: string;
    },
  ) => Promise<string>;
  previewRefit: (parentId: string, columns: string[], reviews: Record<string, ItemReview>) => Promise<EfaRun>;
  cancelRefitPreview: (options?: { preserveCompleted?: boolean }) => void;
  saveRefitPreview: (previewId: string, reviews?: Record<string, ItemReview>, reasons?: string) => Promise<string>;
  addScores: (id: string) => Promise<string>;
  complete?: (id: string, destination: 'columns' | 'csv' | 'operation' | 'code') => Promise<string>;
  parallel: (spec: EfaSpec, replicates: number) => Promise<ParallelResult>;
  preview: (spec: EfaSpec) => Promise<{
    nRows: number;
    counts: number[][];
    inferencePlan?: InferencePlan;
  }>;
  split: (options: {
    seed: number;
    fraction: number;
    groupColumn?: string;
    stratumColumn?: string;
    sourceColumn?: string;
    developmentValue?: string;
    holdoutValue?: string;
  }) => SampleSplit;
  reviews: (id: string, reviews: Record<string, ItemReview>) => void;
  openHoldout: (id: string) => void;
  cancel: () => void;
}
const control =
  "w-full border border-[var(--border)] bg-[var(--input)] p-1.5 text-xs outline-none";
const button =
  "scatterlab-action-button border border-[var(--border)] bg-[var(--input)] px-3 py-1 text-xs font-bold disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2";
const download = (name: string, text: string, type: string) => {
  const url = URL.createObjectURL(new Blob([text], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
export interface EfaSetup {
  label: string;
  selected: string[];
  missing: EfaSpec["missing"] | "mice";
  measurements?: Record<string, MeasurementChoice>;
  advice?: { seq: number; patch: AdvicePatch };
}

export function EfaPanel({
  service,
  table,
  state,
  actions,
  job,
  sample,
  setup,
  contextKey = "",
  itemTable = table,
  externalSpec,
  recoveredRunId,
  onOrdersChange,
}: {
  service: EfaService;
  table: DataTable;
  state: EfaState;
  actions: EfaActions;
  job?: EfaJob;
  sample?: EfaSpec["sample"];
  setup?: EfaSetup;
  contextKey?: string;
  itemTable?: DataTable;
  externalSpec?: { seq: number; spec: EfaSpec } | null;
  recoveredRunId?: string | null;
  onOrdersChange?: (orders: Record<string, OrdinalCategory[]>) => void;
}) {
  const effectiveSample = sample ?? externalSpec?.spec.sample ?? { partition: "all" };
  const sampleScope = effectiveSample.fixedRows
    ? `${effectiveSample.fixedRows.length} fixed rows${effectiveSample.partition === "all" ? "" : ` · ${effectiveSample.partition} partition`}`
    : effectiveSample.partition === "all" ? "" : `${effectiveSample.partition === "development" ? "Development" : "Holdout"} partition`;
  const proposed = useMemo(
    () =>
      Object.fromEntries(
        table.columns.map((column) => [
          column,
          proposedCategories(itemTable.data[column] ?? []),
        ]),
      ),
    [table.columns, itemTable],
  );
  const [localSelected, setSelected] = useState<string[]>([]),
    [orders, setOrders] = useState<Record<string, string>>({}),
    [reverse, setReverse] = useState<Record<string, boolean>>({});
  const [compute, setCompute] = useState<EfaComputeSettings>({ backend: "cpu" });
  const [likelihood, setLikelihood] = useState({ maxIterations: 2000, tolerance: 1e-7, starts: 3, uniquenessFloor: 1e-6 });
  const [factors, setFactors] = useState(2),
    [extraction, setExtraction] = useState<EfaEstimator>("minres"),
    [rotation, setRotation] = useState<Rotation>("promax"),
    [correlation, setCorrelation] = useState<"auto" | "polychoric" | "pearson">("auto"),
    [localMissing, setMissing] = useState<EfaSpec["missing"] | "mice">(
      "pairwise",
    ),
    [localLabel, setLabel] = useState("Likert"),
    [seed, setSeed] = useState(73021);
  const [message, setMessage] = useState(""),
    [search, setSearch] = useState(""),
    [results, setResults] = useState(""),
    [preview, setPreview] = useState<{
      nRows: number;
      counts: number[][];
      key: string;
      columns: string[];
      table: DataTable;
      numeric: boolean;
      inferencePlan?: InferencePlan;
    } | null>(null),
    [parallel, setParallel] = useState<{ result: ParallelResult; key: string; table: DataTable } | null>(null),
    [replicates, setReplicates] = useState(100);
  const [imputations, setImputations] = useState(20),
    [sweeps, setSweeps] = useState(10),
    [predictorEncoding, setPredictorEncoding] = useState<
      "ordered-polynomial" | "rank"
    >("ordered-polynomial"),
    [predictors, setPredictors] = useState<Record<string, string[]>>({}),
    [target, setTarget] = useState(""),
    [miceResults, setMiceResults] = useState("");
  const selected = setup?.selected ?? localSelected,
    missing = setup?.missing ?? localMissing,
    label = setup?.label ?? localLabel;
  const [externalSeq, setExternalSeq] = useState(0);
  const [adviceSeq, setAdviceSeq] = useState(0);
  const [seenRecovery, setSeenRecovery] = useState('');
  if (recoveredRunId && seenRecovery !== recoveredRunId && state.runs.some(run => run.id === recoveredRunId)) {
    setSeenRecovery(recoveredRunId); setResults(recoveredRunId);
  }
  if (setup?.advice && adviceSeq !== setup.advice.seq) {
    setAdviceSeq(setup.advice.seq);
    if (setup.advice.patch.correlation) setCorrelation(setup.advice.patch.correlation);
    if (setup.advice.patch.extraction) setExtraction(setup.advice.patch.extraction);
  }
  useEffect(() => {
    const parsed: Record<string, OrdinalCategory[]> = {};
    for (const [column, text] of Object.entries(orders)) {
      try { const value = JSON.parse(text); if (Array.isArray(value)) parsed[column] = value; } catch { /* Invalid drafts remain in the editor. */ }
    }
    onOrdersChange?.(parsed);
  }, [orders, onOrdersChange]);
  if (externalSpec && externalSeq !== externalSpec.seq) {
    const spec = externalSpec.spec;
    setExternalSeq(externalSpec.seq);
    setSelected(spec.items.map(item => item.column));
    setOrders(Object.fromEntries(spec.items.filter(item => item.categories.length).map(item => [item.column, JSON.stringify(item.categories)])));
    setReverse(Object.fromEntries(spec.items.map(item => [item.column, item.reverse])));
    setFactors(spec.nFactors); setExtraction(spec.extraction ?? 'minres'); setRotation(spec.rotation);
    setCorrelation(spec.correlation ?? 'auto'); setMissing(spec.missing); setLabel(spec.label); setSeed(spec.seed);
    setCompute(spec.compute ?? { backend: 'cpu' });
    setLikelihood({ maxIterations: 2000, tolerance: 1e-7, starts: 3, uniquenessFloor: 1e-6, ...spec.likelihood });
  }
  const predictorTarget = selected.includes(target) ? target : selected[0],
    targetPredictors =
      predictors[predictorTarget] ??
      selected.filter((c) => c !== predictorTarget);
  const busy = job?.status === "running";
  const measurements = setup?.measurements;
  const inferred = useMemo(() => selected.map(column => {
    try {
      const categories = orders[column] ? JSON.parse(orders[column]) as OrdinalCategory[] : undefined;
      return inferMeasurement(itemTable.data[column] ?? [], { measurement: measurements?.[column] ?? "auto", categories });
    } catch { return { kind: "nominal" as const, categories: [], reason: "Review this item's category order." }; }
  }), [selected, orders, itemTable, measurements]);
  const resolvedCorrelation = correlation === "auto" ? inferred.some(item => item.kind === "continuous") ? "pearson" : "polychoric" : correlation;
  const numericData = resolvedCorrelation === "pearson";
  const needsCategories = !numericData || missing === "mice";
  const incompatibility = missing === "fiml" && extraction !== "ml"
    ? "FIML requires Maximum Likelihood extraction. Select ML below."
    : extraction === "ml" && !numericData
      ? "ML models numeric spacing. Select Pearson correlations to treat these items as continuous, or choose another extraction method."
      : extraction === "ml" && missing === "pairwise"
        ? "ML requires FIML, complete cases, or a completed dataset. Choose a compatible missing-value method."
        : numericData && extraction !== "minres" && extraction !== "ml"
          ? "Choose MINRES or ML for Pearson correlations, or select Polychoric to retain WLSMV."
          : "";
  const incompatibleEstimator = !!incompatibility;
  const setupKey = JSON.stringify({
    compute,
    selected,
    orders,
    reverse,
    factors,
    extraction,
    likelihood,
    rotation,
    correlation,
    missing,
    label,
    seed,
    sample: effectiveSample,
    contextKey,
    measurements: setup?.measurements,
  });
  const previewCurrent = preview?.key === setupKey && preview.table === table;
  const runtimeAdvice = missing !== "mice" && previewCurrent && preview.inferencePlan
    ? mvRuntimeAdvice(preview.inferencePlan, compute.probes ?? 128,
      preview.counts.reduce((sum, categories, i) => sum + preview.counts.slice(i + 1).reduce((s, other) => s + categories.length * other.length, 0), 0))
    : undefined;
  const makeSpec = (): EfaSpec => ({
    items: selected.map((column, index) => {
      const measurement = setup?.measurements?.[column] ?? "auto";
      if (!needsCategories && inferred[index]?.kind !== "ordinal")
        return { column, measurement, categories: [], reverse: reverse[column] ?? false };
      let categories: OrdinalCategory[];
      try {
        categories = orders[column]
          ? JSON.parse(orders[column])
          : (proposed[column] ?? []);
      } catch {
        throw new Error(`Enter a JSON category array for ${column}.`);
      }
      if (!Array.isArray(categories))
        throw new Error(`Enter a JSON category array for ${column}.`);
      return { column, measurement, categories, reverse: reverse[column] ?? false };
    }),
    nFactors: factors,
    compute: extraction === "wlsmv" ? compute : { backend: "cpu" },
    extraction,
    ...(extraction === "ml" ? { likelihood } : {}),
    rotation,
    correlation,
    missing: missing === "mice" ? (extraction === "ml" ? "complete" : "pairwise") : missing,
    seed,
    label: label.trim() || "EFA",
    sample: effectiveSample,
  });
  const parallelKey = (spec: EfaSpec, count: number) => JSON.stringify({
    items: spec.items, missing: spec.missing,
    correlation: spec.correlation ?? (spec.missing === "mean" || spec.missing === "median" ? "pearson" : "polychoric"),
    sample: spec.sample, seed: spec.seed, replicates: count, contextKey,
  });
  let simulationKey = "";
  try { simulationKey = parallelKey(makeSpec(), replicates); } catch { /* Invalid category text needs review first. */ }
  const simulation = parallel?.key === simulationKey && parallel.table === table ? parallel.result : undefined;
  const makeMiceOptions = (): MiceOptions => ({
    imputations,
    iterations: sweeps,
    seed,
    predictorEncoding,
    predictors: selected.map((column, i) =>
      (predictors[column] ?? selected.filter((_, j) => i !== j)).flatMap(
        (name) => {
          const j = selected.indexOf(name);
          return j >= 0 && j !== i ? [j] : [];
        },
      ),
    ),
  });
  const act = async (fn: () => Promise<unknown>) => {
    try {
      setMessage("");
      await fn();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="space-y-3 text-xs" data-guide="efa">
      {!setup && <>
      <p>
        {numericData
          ? "Common-factor analysis of numeric items. Review reverse keys, then preview the fitting sample."
          : "Ordinal common-factor analysis. Review category order, then preview the fitting sample. Numeric categories are proposed in ascending order; text needs an explicit order."}
      </p>
      <input
        className={control}
        placeholder="Find items"
        aria-label="Find EFA items"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="flex gap-2">
        <button
          className={button}
          onClick={() =>
            setSelected(
              table.columns.filter(
                (c) =>
                  !isIdentifierColumn(c) && proposed[c] &&
                  proposed[c]!.length >= 2 &&
                  (numericData || proposed[c]!.length <= 20),
              ),
            )
          }
        >
          {numericData ? "Select numeric columns" : "Select ordinal candidates"}
        </button>
        <button className={button} onClick={() => setSelected([])}>
          Clear
        </button>
      </div>
      <div className="max-h-44 overflow-auto space-y-1 border border-[var(--border)] p-2">
        {table.columns
          .filter((c) => c.toLowerCase().includes(search.toLowerCase()))
          .map((c) => (
            <label className="block break-words" key={c}>
              <input
                type="checkbox"
                checked={selected.includes(c)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? [...selected, c]
                      : selected.filter((x) => x !== c),
                  )
                }
              />{" "}
              {c}
            </label>
          ))}
      </div>
      </>}
      <details>
        <summary>
          {!needsCategories ? "Review reverse keys" : "Review category order and reverse keys"} · {selected.length} items
        </summary>
        <div className="max-h-56 overflow-auto space-y-2 py-2">
          {selected.map((c) => (
            <div key={c}>
              <label className="block break-words">
                {c}
                {needsCategories && <input
                  aria-label={`Category order ${c}`}
                  className={control}
                  value={orders[c] ?? JSON.stringify(proposed[c] ?? [])}
                  onChange={(e) =>
                    setOrders({ ...orders, [c]: e.target.value })
                  }
                />}
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={reverse[c] ?? false}
                  onChange={(e) =>
                    setReverse({ ...reverse, [c]: e.target.checked })
                  }
                />{" "}
                Reverse key for this analysis
              </label>
            </div>
          ))}
        </div>
      </details>
      <div className="grid grid-cols-2 gap-2">
        <label className="col-span-2">
          Correlations<InfoTip label="Correlation method" text={`Auto currently selects ${resolvedCorrelation === "pearson" ? "Pearson" : "Polychoric"} from the fitting sample's item types. Polychoric models ordered categories; Pearson models numeric spacing. Missing-value handling does not change this choice. Categorical mean/median fills remain declared categories.`} />
          <select className={control} aria-label="EFA correlations" value={correlation} onChange={e => setCorrelation(e.target.value as "auto" | "polychoric" | "pearson")}>
            <option value="auto">Auto</option>
            <option value="polychoric">Polychoric</option>
            <option value="pearson">Pearson</option>
          </select>
        </label>
        <fieldset className="col-span-2">
          <legend className="mb-1">Extraction</legend>
          <div className="flex flex-wrap gap-x-3 gap-y-2">
            {([
              ["minres", "MINRES", "Estimates loadings by minimizing off-diagonal correlation residuals. Available for Pearson and polychoric correlations."],
              ["ml", "ML", "Maximum Likelihood fits a Gaussian factor model to numeric values. Use Pearson correlations; FIML includes incomplete respondents directly in the likelihood. Complete-case and single-imputation fits are also available."],
              ["wlsmv", "WLSMV", "Uses the DWLS solution with robust mean/variance-adjusted inference and rotated standard errors. Requires polychoric correlations; single-imputation uncertainty is not propagated."],
            ] as const).map(([method, name, help]) => <div className="flex items-center" key={method}>
              <label className={`flex items-center gap-1 cursor-pointer ${numericData && method === "wlsmv" ? "opacity-45" : ""}`}>
                <input type="radio" name="efa-extraction" value={method} checked={extraction === method} disabled={numericData && method === "wlsmv"} onChange={() => setExtraction(method)} />
                {name}
              </label>
              <InfoTip label={`About ${name}`} text={help} />
            </div>)}
          </div>
        </fieldset>
        <fieldset className="col-span-2" role="radiogroup" aria-label="EFA rotation">
          <legend className="mb-1">Rotation</legend>
          <div className="flex flex-wrap gap-x-3 gap-y-2">
            {([
              ["promax", "Promax"],
              ["oblimin", "Oblimin"],
              ["varimax", "Varimax"],
            ] as const).map(([method, name]) => <label className="flex items-center gap-1 cursor-pointer" key={method}>
              <input type="radio" name="efa-rotation" value={method} checked={rotation === method} onChange={() => setRotation(method)} />
              {name}
            </label>)}
          </div>
        </fieldset>
        {incompatibleEstimator && <p role="alert" className="col-span-2">{incompatibility}</p>}
        {(extraction === "ml" || missing === "fiml") && <details className="col-span-2">
          <summary className="cursor-pointer">{missing === "fiml" ? "FIML" : "ML"} hyperparameters<InfoTip label="Likelihood settings" text="Control the iterative likelihood fit. Multiple deterministic starts reduce sensitivity to initialization. The uniqueness floor is relative to each item’s observed variance. The saved analysis records the settings and whether optimization converged." /></summary>
          <div className="grid grid-cols-2 gap-2 pt-2">
            <label>Iterations<input aria-label="ML maximum iterations" className={control} type="number" min={10} max={20000} step={10} value={likelihood.maxIterations} onChange={e => setLikelihood(v => ({ ...v, maxIterations: +e.target.value }))} /></label>
            <label>Starts<input aria-label="ML starts" className={control} type="number" min={1} max={20} value={likelihood.starts} onChange={e => setLikelihood(v => ({ ...v, starts: +e.target.value }))} /></label>
            <label>Tolerance<input aria-label="ML tolerance" className={control} type="number" min={1e-10} max={0.001} step="any" value={likelihood.tolerance} onChange={e => setLikelihood(v => ({ ...v, tolerance: +e.target.value }))} /></label>
            <label>Uniqueness floor<input aria-label="ML uniqueness floor" className={control} type="number" min={1e-8} max={0.1} step="any" value={likelihood.uniquenessFloor} onChange={e => setLikelihood(v => ({ ...v, uniquenessFloor: +e.target.value }))} /></label>
          </div>
        </details>}
        {extraction === "wlsmv" && <EfaBackendControls value={compute} onChange={setCompute} service={service} disabled={!!busy} />}
        {extraction === "wlsmv" && compute.backend !== "cpu" && missing === "mice" && <p role="alert" className="col-span-2 text-xs">Accelerated MICE is not connected yet. Select Browser CPU explicitly to run imputation.</p>}
        {!setup && <>
          <label>
            Missing values<InfoTip label="Missing-value method" text="Pairwise uses each observed item pair; complete cases keep only complete respondents. Mean and median fill each column from fitting rows. Polychoric median selects an observed ordered category; a categorical mean uses the nearest declared category. MICE fits separate completed datasets." />
            <select className={control} value={missing} aria-label="Missing values" onChange={e => setMissing(e.target.value as EfaSpec["missing"] | "mice")}>
              <option value="pairwise">Pairwise deletion</option>
              <option value="complete">Complete cases</option>
              <option value="mean">Mean</option>
              <option value="median">Median</option>
              <option value="mice">MICE</option>
              <option value="fiml">FIML</option>
            </select>
          </label>
          <label className="col-span-2">Run label<input className={control} value={label} onChange={e => setLabel(e.target.value)} /></label>
        </>}
      </div>
      {missing === "mice" && (
        <details open>
          <summary>Ordinal MICE settings</summary>
          <p className="my-2">
            Observed cells stay unchanged. Each completed imputation receives
            its own EFA; the summary describes between-imputation variation.
            Select predictors explicitly and inspect iteration traces after
            fitting.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <label>
              Imputations
              <input
                className={control}
                type="number"
                min={2}
                max={100}
                value={imputations}
                onChange={(e) => setImputations(+e.target.value)}
              />
            </label>
            <label>
              Sweeps per imputation
              <input
                className={control}
                type="number"
                min={1}
                max={100}
                value={sweeps}
                onChange={(e) => setSweeps(+e.target.value)}
              />
            </label>
            <label>
              Predictor coding
              <select
                className={control}
                value={predictorEncoding}
                aria-label="Predictor coding"
                onChange={(e) =>
                  setPredictorEncoding(
                    e.target.value as "ordered-polynomial" | "rank",
                  )
                }
              >
                <option value="ordered-polynomial">
                  Ordered-factor contrasts
                </option>
                <option value="rank">
                  Ordinal ranks · linear predictor effect
                </option>
              </select>
            </label>
            <label>
              Imputation seed
              <input
                className={control}
                type="number"
                value={seed}
                onChange={(e) => setSeed(+e.target.value)}
              />
            </label>
          </div>
          <p className="my-2">
            Ordered-factor contrasts use one column per category minus one.
            Large predictor sets can require substantial time and memory;
            predictors are never removed automatically.
          </p>
          {predictorTarget && (
            <>
              <label>
                Predictors for
                <select
                  className={control}
                  value={predictorTarget}
                  aria-label="Predictors for"
                  onChange={(e) => setTarget(e.target.value)}
                >
                  {selected.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <div className="flex gap-2 my-2">
                <button
                  className={button}
                  onClick={() =>
                    setPredictors({
                      ...predictors,
                      [predictorTarget]: selected.filter(
                        (c) => c !== predictorTarget,
                      ),
                    })
                  }
                >
                  All other selected items
                </button>
                <button
                  className={button}
                  onClick={() =>
                    setPredictors({ ...predictors, [predictorTarget]: [] })
                  }
                >
                  Intercept only
                </button>
              </div>
              <div className="max-h-32 overflow-auto border border-[var(--border)] p-2">
                {selected
                  .filter((c) => c !== predictorTarget)
                  .map((c) => (
                    <label className="block break-words" key={c}>
                      <input
                        type="checkbox"
                        checked={targetPredictors.includes(c)}
                        onChange={(e) =>
                          setPredictors({
                            ...predictors,
                            [predictorTarget]: e.target.checked
                              ? [...targetPredictors, c]
                              : targetPredictors.filter((x) => x !== c),
                          })
                        }
                      />{" "}
                      {c}
                    </label>
                  ))}
              </div>
            </>
          )}
        </details>
      )}
      <details>
        <summary>Factor parallel analysis</summary>
        {missing === "mice" && (
          <p>
            Parallel analysis uses the observed responses with pairwise
            deletion. It does not combine null distributions across imputations.
          </p>
        )}
        <p>
          Compare observed factor eigenvalues with a shuffled-data reference.
          <InfoTip label="About factor parallel analysis" text="Uses the same bounded one-factor MINRES communality convention for observed and shuffled data. The reference is the 95th percentile across successful permutations. Weak shuffled matrices can yield different solutions from psych defaults; inspect the spectrum and nearby factor counts. With FIML, this uses pairwise Pearson spectra, not likelihood-ratio tests." />
        </p>
        <label>
          Permutations
          <input
            className={control}
            type="number"
            min={1}
            max={1000}
            value={replicates}
            onChange={(e) => setReplicates(+e.target.value)}
          />
        </label>
        <label>
          Permutation seed
          <input
            className={control}
            type="number"
            value={seed}
            onChange={(e) => setSeed(+e.target.value)}
          />
        </label>
        <button
          className={button}
          disabled={busy || selected.length < 3 || incompatibleEstimator}
          onClick={() =>
            void act(async () => {
              const spec = { ...makeSpec(), nFactors: 1 };
              const key = parallelKey(spec, replicates);
              setParallel({ result: await actions.parallel(spec, replicates), key, table });
            })
          }
        >
          Run parallel analysis
        </button>
        {simulation && (
          <div>
            <p>
              {simulation.completed}/{simulation.requested} successful
              replicates.{" "}
              {simulation.suggested === null
                ? "Incomplete: no factor-count suggestion."
                : `Sequential eigenvalue comparison suggests ${simulation.suggested} factors; review substantively.`}
            </p>
            <ParallelAnalysisChart key={simulationKey} result={simulation} />
            <button
              className={button}
              onClick={() =>
                download(
                  "parallel-analysis.json",
                  JSON.stringify(
                    simulation,
                    null,
                    2,
                  ),
                  "application/json",
                )
              }
            >
              Export simulation
            </button>
          </div>
        )}
      </details>
      <div className="space-y-1">
        <label className="flex items-center justify-between gap-2">
          Factor count
          <input
            className="w-20 border border-[var(--border)] bg-[var(--input)] px-2 py-1 text-xs"
            aria-label="Factor count"
            type="number"
            min={1}
            max={499}
            value={factors}
            onChange={(e) => setFactors(+e.target.value)}
          />
        </label>
      </div>
      {sampleScope && <p className="text-xs opacity-70" aria-label="EFA sample scope">Fitting scope: {sampleScope}</p>}
      <div className="flex gap-2">
        <button
          className={button}
          disabled={busy || incompatibleEstimator}
          onClick={() =>
            void act(async () => {
              const p = await actions.preview(makeSpec());
              setPreview({ ...p, key: setupKey, columns: selected.slice(), table, numeric: numericData });
            })
          }
        >
          Preview sample
        </button>
        <button
          className={button}
          disabled={busy || selected.length < 3 || !previewCurrent || incompatibleEstimator}
          onClick={() =>
            void act(async () => {
              if (missing === "mice")
                setMiceResults(
                  await actions.impute(makeSpec(), makeMiceOptions()),
                );
              else setResults(await actions.run(makeSpec()));
            })
          }
        >
          {missing === "mice" ? "Run MICE + EFA" : "Run EFA"}
        </button>
        {busy && (
          <button className={button} onClick={actions.cancel}>
            Cancel
          </button>
        )}
      </div>
      {preview && (
        <details open>
          <summary>
            Preview: {preview.nRows} fitting rows
            {!previewCurrent ? " · settings changed; preview again" : ""}
          </summary>
          {previewCurrent && preview.inferencePlan && (
            <p className="my-2">
              {compute.correction === "estimated" ? "WLSMV with estimated MV correction" : "Exact WLSMV inference"}: about{" "}
              {Math.ceil(
                preview.inferencePlan.estimatedBytes / 1024 ** 2,
              ).toLocaleString()}{" "}
              MiB working estimate and{" "}
              {preview.inferencePlan.approximateMultiplyAdds.toLocaleString(
                undefined,
                { maximumFractionDigits: 0 },
              )}{" "}
              multiply-add operations. Large jobs may take substantially longer
              than DWLS point fitting.
              {missing === "mice"
                ? ` This is repeated separately for each of ${imputations} imputations.`
                : ""}
            </p>
          )}
          {runtimeAdvice && <div className="my-2 border p-2 text-xs" aria-label="Runtime guidance">
            <p className="font-bold">{runtimeAdvice.title}<InfoTip label="About runtime guidance" text="Uses the preview's fitting rows, item pairs, factors, probe count and memory plan. Arithmetic estimates are not device benchmarks. The choice remains yours; no backend or correction is changed automatically. Matrix structure determines estimation error, so there is no reliable rows × items accuracy cutoff." /></p>
            <p>{runtimeAdvice.detail}</p>
          </div>}
          <div className="max-h-32 overflow-auto">
            {preview.counts.map((counts, i) => (
              <p key={i}>
                {preview.columns[i]}: {preview.numeric
                  ? `${counts.reduce((total, count) => total + count, 0)} observed values`
                  : `${counts.join(" / ")} responses per ordered category`}
              </p>
            ))}
          </div>
        </details>
      )}
      {job && (
        <p role="status">
          {job.progress.stage}: {job.progress.completed} / {job.progress.total}{" "}
          · {job.status}
          {job.error ? ` · ${job.error}` : ""}
        </p>
      )}
      <p role="alert" className="break-words">
        {message}
      </p>
      {state.runs.length > 0 && (
        <button
          className={`${button} w-full`}
          onClick={() => setResults(state.runs.at(-1)!.id)}
        >
          Open EFA results · {state.runs.length} saved runs
        </button>
      )}
      {!!state.imputationRuns?.length && (
        <button
          className={`${button} w-full`}
          onClick={() => setMiceResults(state.imputationRuns!.at(-1)!.id)}
        >
          Open MICE results · {state.imputationRuns!.length} saved analyses
        </button>
      )}
      {miceResults && !!state.imputationRuns?.length && (
        <ImputationResults
          state={state}
          activeId={miceResults}
          onSelect={setMiceResults}
          onClose={() => setMiceResults("")}
          actions={actions}
          job={job}
        />
      )}
      {results && state.runs.length > 0 && (
        <Results
          key={results}
          state={state}
          activeId={results}
          onSelect={(id) => {
            setResults(id);
            actions.openHoldout(id);
          }}
          actions={actions}
          table={table}
          job={job}
          onClose={() => setResults("")}
        />
      )}
    </div>
  );
}
