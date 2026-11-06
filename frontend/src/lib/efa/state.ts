import type { DataTable } from "../table";
import { mulberry32 } from "../random";
import { CSV_BOM, csvCell } from "../csv";
import {
  EfaError,
  type SampleSplit,
  type EfaRun,
  type EfaSpec,
  type EfaState,
} from "./types";

export const emptyEfaState = (): EfaState => ({ runs: [], splits: [] });
export function createSampleSplit(
  table: DataTable,
  eligible: number[],
  options: {
    seed: number;
    fraction: number;
    groupColumn?: string;
    stratumColumn?: string;
    afterFullExploration: boolean;
  },
): SampleSplit {
  if (!Number.isSafeInteger(options.seed))
    throw new EfaError("split", "Use an integer split seed.");
  if (
    !Number.isFinite(options.fraction) ||
    options.fraction <= 0 ||
    options.fraction >= 1
  )
    throw new EfaError(
      "split",
      "Development fraction must be between zero and one.",
    );
  for (const col of [options.groupColumn, options.stratumColumn])
    if (col && !table.columns.includes(col))
      throw new EfaError("split", `Unknown split column ${col}.`);
  const groups = new Map<string, { rows: number[]; stratum: string }>();
  for (const row of eligible) {
    const value = options.groupColumn
      ? table.data[options.groupColumn][row]
      : row;
    if (value == null)
      throw new EfaError("split", "Group identifiers cannot be missing.");
    const key = JSON.stringify(value),
      stratum = JSON.stringify(
        options.stratumColumn ? table.data[options.stratumColumn][row] : null,
      );
    const group = groups.get(key);
    if (group && group.stratum !== stratum)
      throw new EfaError("split", "Each group must belong to one stratum.");
    if (group) group.rows.push(row);
    else groups.set(key, { rows: [row], stratum });
  }
  const strata = new Map<string, { rows: number[]; stratum: string }[]>();
  for (const group of groups.values()) {
    const values = strata.get(group.stratum) ?? [];
    values.push(group);
    strata.set(group.stratum, values);
  }
  const development: number[] = [],
    holdout: number[] = [],
    random = mulberry32(options.seed);
  for (const values of strata.values()) {
    if (values.length < 2)
      throw new EfaError(
        "split",
        "Each stratum needs at least two independent groups (or respondents without a group column).",
      );
    for (let i = values.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [values[i], values[j]] = [values[j], values[i]];
    }
    const cut = Math.max(
      1,
      Math.min(values.length - 1, Math.round(values.length * options.fraction)),
    );
    values.forEach((g, i) => (i < cut ? development : holdout).push(...g.rows));
  }
  return {
    id: crypto.randomUUID(),
    label: "Development / holdout",
    createdAt: new Date().toISOString(),
    seed: options.seed,
    fraction: options.fraction,
    eligible: eligible.slice(),
    development: development.sort((a, b) => a - b),
    holdout: holdout.sort((a, b) => a - b),
    groupColumn: options.groupColumn,
    stratumColumn: options.stratumColumn,
    afterFullExploration: options.afterFullExploration,
  };
}
export function existingSampleSplit(
  table: DataTable,
  eligible: number[],
  column: string,
  developmentValue: string,
  holdoutValue: string,
  afterFullExploration: boolean,
): SampleSplit {
  if (!table.columns.includes(column) || developmentValue === holdoutValue)
    throw new EfaError(
      "split",
      "Choose a split column and two distinct partition values.",
    );
  const development = eligible.filter(
      (i) => String(table.data[column][i]) === developmentValue,
    ),
    holdout = eligible.filter(
      (i) => String(table.data[column][i]) === holdoutValue,
    );
  if (!development.length || !holdout.length)
    throw new EfaError("split", "Both split values must identify respondents.");
  return {
    id: crypto.randomUUID(),
    label: `Split by ${column}`,
    seed: 0,
    fraction: development.length / (development.length + holdout.length),
    eligible: eligible.slice(),
    development,
    holdout,
    sourceColumn: column,
    createdAt: new Date().toISOString(),
    afterFullExploration,
  };
}
export function fittingRows(
  eligible: number[],
  spec: EfaSpec,
  splits: SampleSplit[],
) {
  let rows = eligible.slice();
  if (spec.sample.partition !== "all") {
    const split = splits.find((s) => s.id === spec.sample.splitId);
    if (!split)
      throw new EfaError("split", "The selected sample split is unavailable.");
    const members = new Set(split[spec.sample.partition]);
    rows = rows.filter((i) => members.has(i));
  }
  if (spec.sample.fixedRows) {
    const fixed = new Set(spec.sample.fixedRows);
    rows = rows.filter((i) => fixed.has(i));
  }
  if (rows.length < 3)
    throw new EfaError(
      "sample",
      "Fewer than three eligible respondents remain in the selected partition.",
    );
  return rows;
}
export function addScoreColumns(
  table: DataTable,
  run: EfaRun,
  scores: (number | null)[][],
) {
  if (scores.length !== table.nRows)
    throw new EfaError("scores", "Score rows do not match the dataset.");
  const label =
    run.spec.label.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 60) || "efa";
  const data = { ...table.data },
    columns = table.columns.slice(),
    added: string[] = [];
  for (let f = 0; f < run.spec.nFactors; f++) {
    const base = `FA${f + 1}_${label}_r${run.revision}`;
    let name = base,
      suffix = 2;
    while (columns.includes(name)) name = `${base}_${suffix++}`;
    data[name] = scores.map((row) => row[f]);
    columns.push(name);
    added.push(name);
  }
  return { table: { columns, data, nRows: table.nRows }, columns: added };
}
export function serializeEfaCsv(run: EfaRun) {
  const se = run.result.weighted?.robust?.standardErrors;
  const headers = [
    "item",
    "extraction",
    ...run.result.rotation.pattern[0].map((_, i) => `pattern_F${i + 1}`),
    ...run.result.structure[0].map((_, i) => `structure_F${i + 1}`),
    "communality",
    "uniqueness",
    ...(se
      ? [
          ...se.pattern[0].map((_, i) => `pattern_SE_F${i + 1}`),
          ...se.structure[0].map((_, i) => `structure_SE_F${i + 1}`),
          "communality_SE",
          "uniqueness_SE",
        ]
      : []),
    "mv_correction", "mv_probes", "mv_seed", "trace_squared_mcse",
    "status",
    "note",
  ];
  return (
    CSV_BOM +
    [
      headers,
      ...run.spec.items.map((item, i) => [
        item.column,
        run.spec.extraction ?? "minres",
        ...run.result.rotation.pattern[i],
        ...run.result.structure[i],
        run.result.communalities[i],
        run.result.uniquenesses[i],
        ...(se
          ? [
              ...se.pattern[i],
              ...se.structure[i],
              se.communalities[i],
              se.uniquenesses[i],
            ]
          : []),
        run.result.weighted?.robust ? (run.result.weighted.robust.test.traceEstimation ? "estimated" : "exact") : "",
        run.result.weighted?.robust?.test.traceEstimation?.probes ?? "",
        run.result.weighted?.robust?.test.traceEstimation?.seed ?? "",
        run.result.weighted?.robust?.test.traceEstimation?.monteCarloSE ?? "",
        run.reviews[item.column]?.status ?? "retain",
        run.reviews[item.column]?.note ?? "",
      ]),
    ]
      .map((row) => row.map(csvCell).join(","))
      .join("\r\n")
  );
}
