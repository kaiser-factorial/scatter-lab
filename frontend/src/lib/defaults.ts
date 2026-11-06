import { isNumericColumn, type DataTable } from './table';
import { BASE_PC_COLUMNS } from './pca';

export type DefaultAxes = { x: string; y: string; z: string | null };

// Match unambiguous identifier conventions without guessing from uniqueness:
// measurements can quite reasonably be unique in a small dataset.
//
// The bare `/ID$/` this used to carry matched any name ending in capital I-D,
// so VALID, HYBRID, RAPID and GRID were all excluded from default axes and from
// the assistant's default PCA variables (finding E5). Requiring a boundary —
// a non-uppercase-letter before the ID, or the whole name being ID — keeps
// respondentID and subjID while letting VALID through.
export { isIdentifierColumn } from '@scatterlab/stats/internal/identifiers';
import { isIdentifierColumn } from '@scatterlab/stats/internal/identifiers';

/**
 * How many rows a value must cover before naming it describes a group rather
 * than a person.
 *
 * The app's privacy contract is that the assistant sees aggregates, never rows,
 * and the column profile it sends carries each categorical column's most
 * frequent values. On a genuine category ("Species": setosa/versicolor/…) those
 * strings ARE the aggregate, and are what makes the assistant useful. On an
 * email address or a free-text answer every value is unique, so "most frequent
 * values" is just a handful of rows (finding D8).
 *
 * The test is deliberately per-VALUE, not per-column. A column-level cardinality
 * rule gets the easy cases right and then withholds a perfectly ordinary
 * `school` variable with 60 levels and 80 rows each — a real loss of context for
 * no privacy gain, because nothing in that list identifies anyone. What actually
 * matters is how many people stand behind each value: 80 is a group, 1 is a
 * person, and the boundary belongs there.
 *
 * Five is the usual small-cell threshold in statistical disclosure control.
 */
export const MIN_AGGREGATE_COUNT = 5;

/** True when naming this value would describe too few rows to be an aggregate. */
export const valueIsTooRare = (count: number): boolean => count < MIN_AGGREGATE_COUNT;

const uniqueNonNull = (values: unknown[]) =>
  Array.from(new Set(values.filter(v => v != null)));

// The table normalizer represents booleans as 0/1, so this intentionally also
// treats binary 0/1 flags as boolean-like for automatic colour selection.
export const isBooleanLike = (values: unknown[]) => {
  const valuesPresent = uniqueNonNull(values);
  return valuesPresent.length > 0 && valuesPresent.every(v =>
    v === 0 || v === 1 || v === true || v === false || v === 'true' || v === 'false'
  );
};

const numericColumns = (table: DataTable) =>
  table.columns.filter(c => isNumericColumn(table.data[c] ?? []));

// PC columns (from a components run) win. Otherwise, avoid identifiers when
// there are at least two measured variables to form a meaningful plot.
export const pickDefaultAxes = (table: DataTable): DefaultAxes => {
  // Take whichever PCs exist rather than demanding all three: since C10 stopped
  // zero-padding, a two-component components file legitimately yields PC1/PC2
  // only, and requiring PC3 sent those datasets down the raw-variable path.
  const pcs = BASE_PC_COLUMNS.filter(c => table.columns.includes(c));
  if (pcs.length >= 2) {
    return { x: pcs[0], y: pcs[1], z: pcs[2] ?? null };
  }
  const numeric = numericColumns(table);
  const nonIdentifiers = numeric.filter(c => !isIdentifierColumn(c));
  const chosen = nonIdentifiers.length >= 2 ? nonIdentifiers : numeric;
  return { x: chosen[0], y: chosen[1], z: chosen[2] ?? null };
};

// A short categorical legend is usually the most legible first colour channel.
// Twenty is the app's boundary between discrete and continuous numeric colour.
const MAX_DEFAULT_COLOR_CATEGORIES = 20;

/**
 * One capped scan per candidate column (finding F18).
 *
 * What this replaces did five to six full passes per column: `uniqueNonNull`
 * ran BEFORE the name guard, so a column disqualified by its name still paid a
 * complete scan and a full-cardinality Set; `isBooleanLike` scanned again; and
 * the sort comparator called `uniqueNonNull` on *both operands of every
 * comparison*. On 200k × 30 that was 1,194 ms and a 200,000-element Set per
 * numeric column.
 *
 * Three changes, no behaviour change: the name guard runs first; one pass counts
 * distinct values and boolean-likeness together and bails as soon as the count
 * passes the ceiling (nothing above it can win, so the exact figure is never
 * needed); and the sort reads the cached count.
 */
const scanForColorBy = (values: unknown[]) => {
  const seen = new Set<unknown>();
  let boolLike = true;
  for (const v of values) {
    if (v == null) continue;
    if (boolLike && !(v === 0 || v === 1 || v === true || v === false || v === 'true' || v === 'false')) {
      boolLike = false;
    }
    if (seen.size <= MAX_DEFAULT_COLOR_CATEGORIES) seen.add(v);
    // Past the ceiling the column cannot qualify, and boolean-likeness is
    // already decided (>21 distinct values is not two-valued), so stop.
    else if (!boolLike) break;
  }
  return { count: seen.size, boolLike: boolLike && seen.size > 0 };
};

export const pickDefaultColorBy = (table: DataTable, current: string) => {
  // A current selection may be deliberate, so preserve it on a dataset switch.
  if (current && table.columns.includes(current)) return current;
  if (table.columns.includes('Cluster')) return 'Cluster';

  const candidates = table.columns
    .map((name, index) => ({ name, index }))
    // Name guard FIRST — a disqualified column should never be scanned at all.
    .filter(({ name }) => !isIdentifierColumn(name))
    .map(c => ({ ...c, ...scanForColorBy(table.data[c.name] ?? []) }))
    .filter(({ count, boolLike }) =>
      count >= 2 && count <= MAX_DEFAULT_COLOR_CATEGORIES && !boolLike)
    .sort((a, b) => a.count - b.count || a.index - b.index);

  return candidates[0]?.name
    ?? table.columns.find(c => !isIdentifierColumn(c))
    ?? table.columns[0]
    ?? '';
};
