/** All persisted EFA values are JSON-compatible; working arrays stay in workers. */
import type { ImputationAnalysis } from "./imputation-analysis";
import type { StabilityResult } from "./stability";
import type { WeightedTest, InferencePlan } from "./weighted-inference";
import type { RotatedUncertainty } from "./weighted-rotation";
export type OrdinalCategory = string | number;
export type Rotation = "oblimin" | "varimax" | "promax";
export type EfaEstimator = "minres" | "dwls" | "wlsmv";
export type ItemReview = {
  status: "retain" | "investigate" | "exclude";
  note: string;
};
export interface EfaItem {
  column: string;
  categories: OrdinalCategory[];
  reverse: boolean;
}
export interface EfaSpec {
  compute?: import("./backends/types").EfaComputeSettings;
  /** Absent in older workspaces: MINRES. WLSMV uses the DWLS point fit. */
  extraction?: EfaEstimator;
  items: EfaItem[];
  nFactors: number;
  rotation: Rotation;
  missing: "pairwise" | "complete";
  seed: number;
  label: string;
  sample: {
    splitId?: string;
    partition: "all" | "development" | "holdout";
    fixedRows?: number[];
  };
}
export interface SampleSplit {
  id: string;
  label: string;
  seed: number;
  fraction: number;
  development: number[];
  holdout: number[];
  eligible: number[];
  groupColumn?: string;
  stratumColumn?: string;
  sourceColumn?: string;
  createdAt: string;
  afterFullExploration: boolean;
  holdoutOpenedAt?: string;
}
export interface EfaDiagnostic {
  code: string;
  message: string;
  items?: string[];
  count?: number;
}
export class EfaError extends Error {
  constructor(
    public code: string,
    message: string,
    public diagnostics: EfaDiagnostic[] = [],
  ) {
    super(message);
    this.name = "EfaError";
  }
}
export interface EfaPreparedData {
  fingerprint?: string;
  items: EfaItem[];
  nRows: number;
  originalRowCount: number;
  rows: number[];
  /** Column-major ordinal ranks, zero based. Missingness is separate, never a category. */
  codes: Uint16Array;
  observed: Uint8Array;
  means: number[];
  sds: number[];
  counts: number[][];
  diagnostics: EfaDiagnostic[];
}
export interface PairEstimate {
  i: number;
  j: number;
  n: number;
  rho: number;
  thresholdsX: number[];
  thresholdsY: number[];
  observedCategoriesX: number[];
  observedCategoriesY: number[];
  sparseCells: number;
  boundary: boolean;
}
export interface EfaCorrelations {
  matrix: number[][];
  pairs: PairEstimate[];
  counts: number[];
  diagnostics: EfaDiagnostic[];
}
export interface Convergence {
  maxIterations?: number;
  converged: boolean;
  iterations: number;
  objective: number;
  gradient: number;
}
export const EFA_ENGINE = "scatter-efa/8";
export interface EfaExtraction {
  estimator?: "minres" | "dwls";
  method?: string;
  initialization?: {
    selected: "smc" | "unit-uniqueness";
    smcObjective: number;
    unitUniquenessObjective: number | null;
  };
  loadings: number[][];
  uniquenessParameters: number[];
  convergence: Convergence;
  eigenvalues: number[];
  boundaryItems: number[];
}
export interface EfaRotation {
  pattern: number[][];
  phi: number[][];
  convergence: Convergence;
  starts: number;
}
export interface EfaResult {
  weighted?: {
    estimator: "dwls" | "wlsmv";
    samplingVariances: number[];
    fittingWeights: number[];
    uncertaintyMethod: string;
    rawStatistic: number;
    df: number;
    robust?: {
      test: WeightedTest;
      standardErrors: RotatedUncertainty;
      plan: InferencePlan;
    };
  };
  correlation: EfaCorrelations;
  extraction: EfaExtraction;
  rotation: EfaRotation;
  structure: number[][];
  communalities: number[];
  uniquenesses: number[];
  reproduced: number[][];
  residuals: number[][];
  rmsr: number;
  means: number[];
  sds: number[];
  weights: number[][];
  categoryCounts: number[][];
  fittingRows: number[];
  originalRowCount: number;
  conditionNumber: number;
  diagnostics: EfaDiagnostic[];
  provenance: {
    inputSha256?: string;
    execution?: import("./backends/types").EfaExecution;
    engine: string;
    matrix: string;
    correlation: string;
    extraction: string;
    rotation: string;
    scoring: string;
    seed: number;
  };
}
export interface EfaRun {
  id: string;
  revision: number;
  createdAt: string;
  datasetRevision: string;
  spec: EfaSpec;
  result: EfaResult;
  eligibleRows: number[];
  parentId?: string;
  kind: "fit" | "items" | "rotation" | "structure-replication";
  reviews: Record<string, ItemReview>;
  /** Mutable review metadata; numerical results/specifications remain immutable. */
  reviewRevision?: number;
  parentReviewRevision?: number;
  reasons: string;
  revisedAfterHoldout: boolean;
  scoreColumns: string[];
}
export interface EfaState {
  runs: EfaRun[];
  splits: SampleSplit[];
  parallelRuns?: {
    id: string;
    spec: EfaSpec;
    eligibleRows: number[];
    createdAt: string;
    result: ParallelResult;
  }[];
  imputationRuns?: EfaImputationRun[];
  stabilityRuns?: EfaStabilityRun[];
}
export interface EfaImputationRun {
  id: string;
  revision: number;
  createdAt: string;
  datasetRevision: string;
  /** Preparation retains all eligible rows; each completed dataset is fitted separately. */
  spec: EfaSpec;
  eligibleRows: number[];
  parentId?: string;
  reviews: Record<string, ItemReview>;
  reviewRevision?: number;
  parentReviewRevision?: number;
  reasons: string;
  revisedAfterHoldout: boolean;
  result: ImputationAnalysis;
}
export interface EfaStabilityRun {
  id: string;
  runId: string;
  createdAt: string;
  datasetRevision: string;
  groupColumn?: string;
  result: StabilityResult;
}
export interface EfaProgress {
  traceEstimation?: import("./trace-estimation").TraceEstimate;
  stage: string;
  completed: number;
  total: number;
}
export type Progress = (value: EfaProgress) => void;
export interface ParallelResult {
  provenance?: {
    inputSha256?: string;
    execution?: import("./backends/types").EfaExecution;
    engine: string;
    correlation: string;
    extraction: string;
    nullModel: string;
    communalityConvention: string;
    generator: string;
    percentile: string;
  };
  seed: number;
  requested: number;
  completed: number;
  percentile: number;
  observed: number[];
  nullEigenvalues: number[][];
  reference: (number | null)[];
  failures: { replicate: number; error: string }[];
  suggested: number | null;
}
