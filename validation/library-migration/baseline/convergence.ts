/** Aggregate-only diagnostics. Never include item values, rows, or fitted parameters. */
export type ConvergenceFailureReason = 'iteration-limit' | 'line-search' | 'stalled' | 'non-finite' | 'mixed';
export type ConvergenceStopReason = Exclude<ConvergenceFailureReason, 'mixed'> | 'converged';

export interface IterativePcaSettings {
  maxIterations?: number;
  tolerance?: number;
  rank?: number;
}
export interface ConvergenceRetrySettings {
  maxIterations: number;
  tolerance: number;
  rank?: number;
  starts?: number;
  uniquenessFloor?: number;
}
export interface ConvergenceStart {
  start: number;
  iterations: number;
  objective: number | null;
  gradient: number | null;
  reason: ConvergenceStopReason;
}
export interface ConvergenceIssue {
  method: 'iterative-pca' | 'ml' | 'fiml';
  reason: ConvergenceFailureReason;
  settings: ConvergenceRetrySettings;
  /** Iterations in the reported best-objective start, or in the PCA pass. */
  iterations: number;
  objective: number | null;
  criterion?: number | null;
  gradient?: number | null;
  bestStart?: number;
  starts?: ConvergenceStart[];
  partialAvailable: boolean;
}

export const DEFAULT_ITERATIVE_PCA_SETTINGS = { maxIterations: 200, tolerance: 1e-8 } as const;
export const finiteMetric = (value: number): number | null => Number.isFinite(value) ? value : null;

/** Resolve only caller-controlled options; dimensional rank clamping stays in PCA. */
export function iterativePcaSettings(value: IterativePcaSettings | undefined, defaultRank = 2): Required<IterativePcaSettings> {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !['maxIterations', 'tolerance', 'rank'].includes(key))))
    throw new Error('Iterative PCA settings accept maxIterations, tolerance and rank.');
  const resolved = { ...DEFAULT_ITERATIVE_PCA_SETTINGS, rank: defaultRank, ...value };
  if (!Number.isSafeInteger(resolved.maxIterations) || resolved.maxIterations < 1 || resolved.maxIterations > 20000 ||
    !Number.isFinite(resolved.tolerance) || resolved.tolerance < 1e-12 || resolved.tolerance > 1e-2 ||
    !Number.isSafeInteger(resolved.rank) || resolved.rank < 1)
    throw new Error('Iterative PCA needs 1–20000 iterations, tolerance 1e-12–1e-2, and a positive integer reconstruction rank.');
  return resolved;
}

/** Shared UI validation; model-specific numerical entry points validate again. */
export function convergenceRetryError(method: ConvergenceIssue['method'], settings: ConvergenceRetrySettings): string | undefined {
  if (method === 'iterative-pca') {
    try { iterativePcaSettings({ maxIterations: settings.maxIterations, tolerance: settings.tolerance, ...(settings.rank !== undefined ? { rank: settings.rank } : {}) }); }
    catch (error) { return error instanceof Error ? error.message : String(error); }
    return;
  }
  if (!Number.isSafeInteger(settings.maxIterations) || settings.maxIterations < 10 || settings.maxIterations > 20000)
    return 'Use an iteration limit from 10 to 20000.';
  if (!Number.isFinite(settings.tolerance) || settings.tolerance < 1e-10 || settings.tolerance > 1e-3)
    return 'Use a tolerance from 1e-10 to 1e-3.';
  if (!Number.isSafeInteger(settings.starts) || settings.starts! < 1 || settings.starts! > 20)
    return 'Use 1–20 starting points.';
  if (!Number.isFinite(settings.uniquenessFloor) || settings.uniquenessFloor! < 1e-8 || settings.uniquenessFloor! > .1)
    return 'Use a relative uniqueness floor from 1e-8 to 0.1.';
}

/** Whitelist copy for worker/job/assistant transport; no arbitrary extra keys. */
export function convergenceIssueSummary(issue: ConvergenceIssue): ConvergenceIssue {
  const settings = issue.settings;
  return {
    method: issue.method, reason: issue.reason, iterations: issue.iterations,
    objective: issue.objective === null ? null : finiteMetric(issue.objective),
    settings: { maxIterations: settings.maxIterations, tolerance: settings.tolerance,
      ...(issue.method === 'iterative-pca' && settings.rank !== undefined ? { rank: settings.rank } : {}),
      ...(issue.method !== 'iterative-pca' ? { starts: settings.starts, uniquenessFloor: settings.uniquenessFloor } : {}) },
    ...(issue.criterion !== undefined ? { criterion: issue.criterion === null ? null : finiteMetric(issue.criterion) } : {}),
    ...(issue.gradient !== undefined ? { gradient: issue.gradient === null ? null : finiteMetric(issue.gradient) } : {}),
    ...(issue.bestStart !== undefined ? { bestStart: issue.bestStart } : {}),
    ...(issue.starts ? { starts: issue.starts.map(start => ({ start: start.start, reason: start.reason,
      iterations: start.iterations, objective: start.objective === null ? null : finiteMetric(start.objective),
      gradient: start.gradient === null ? null : finiteMetric(start.gradient) })) } : {}),
    partialAvailable: issue.method === 'iterative-pca' && issue.partialAvailable,
  };
}
