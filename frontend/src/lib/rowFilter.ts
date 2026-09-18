import { asNumber, type DataTable } from './table';

// A row filter is a conjunction of simple conditions on columns of the active
// table: "show only rows where Q7 = 'A' and age >= 30". It is a DISPLAY filter
// — pure, policy-free, and computed entirely in the browser, so it is available
// in both data modes. Whether anything downstream (clustering, tests) also
// honours it is decided by the callers, not here.

export type FilterOp = 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'contains';

export const FILTER_OPS: FilterOp[] = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in', 'contains'];

export type FilterCondition = {
  column: string;
  op: FilterOp;
  value: string | number | (string | number)[];
};

const OP_SYMBOL: Record<FilterOp, string> = {
  eq: '=', neq: '≠', lt: '<', lte: '≤', gt: '>', gte: '≥', in: 'in', contains: 'contains',
};

/** Does one cell satisfy one condition? Missing cells never match, in either direction. */
export const cellMatches = (v: unknown, op: FilterOp, value: FilterCondition['value']): boolean => {
  if (v == null) return false;
  switch (op) {
    case 'eq':
    case 'neq': {
      const one = Array.isArray(value) ? value[0] : value;
      const num = typeof one === 'number' ? one : asNumber(one);
      const nv = asNumber(v);
      const same = (num !== null && nv !== null) ? nv === num : String(v) === String(one);
      return op === 'eq' ? same : !same;
    }
    case 'lt': case 'lte': case 'gt': case 'gte': {
      const one = Array.isArray(value) ? value[0] : value;
      const num = typeof one === 'number' ? one : asNumber(one);
      const nv = asNumber(v);
      if (num === null || nv === null) return false;
      if (op === 'lt') return nv < num;
      if (op === 'lte') return nv <= num;
      if (op === 'gt') return nv > num;
      return nv >= num;
    }
    case 'in': {
      const list = Array.isArray(value) ? value : [value];
      const nv = asNumber(v);
      const sv = String(v);
      return list.some(item => {
        const num = typeof item === 'number' ? item : asNumber(item);
        return (num !== null && nv !== null) ? nv === num : sv === String(item);
      });
    }
    case 'contains': {
      const one = Array.isArray(value) ? value[0] : value;
      return String(v).toLowerCase().includes(String(one).toLowerCase());
    }
    default:
      return false;
  }
};

/**
 * Structural check before anything is applied: every column must exist and
 * every op must be one of FILTER_OPS. Returns the problems, empty = valid.
 */
export const validateConditions = (t: DataTable, conds: unknown): string[] => {
  if (!Array.isArray(conds)) return ['conditions must be an array.'];
  const problems: string[] = [];
  conds.forEach((c, i) => {
    if (!c || typeof c !== 'object') { problems.push(`condition ${i + 1} is not an object.`); return; }
    const { column, op, value } = c as Partial<FilterCondition>;
    if (typeof column !== 'string' || !t.columns.includes(column)) problems.push(`"${String(column)}" is not a column.`);
    if (!FILTER_OPS.includes(op as FilterOp)) problems.push(`"${String(op)}" is not an op (use ${FILTER_OPS.join(', ')}).`);
    if (value == null || (Array.isArray(value) && value.length === 0)) problems.push(`condition ${i + 1} has no value.`);
    if (['lt', 'lte', 'gt', 'gte'].includes(String(op))) {
      const one = Array.isArray(value) ? value[0] : value;
      if (asNumber(one) === null) problems.push(`op "${op}" needs a numeric value, got ${JSON.stringify(one)}.`);
    }
  });
  return problems;
};

/** AND of all conditions, one boolean per row. An empty condition list keeps everything. */
export const buildRowMask = (t: DataTable, conds: FilterCondition[]): boolean[] => {
  const mask = new Array<boolean>(t.nRows).fill(true);
  for (const { column, op, value } of conds) {
    const vals = t.data[column] ?? [];
    for (let i = 0; i < t.nRows; i++) {
      if (mask[i] && !cellMatches(vals[i], op, value)) mask[i] = false;
    }
  }
  return mask;
};

export const countMask = (mask: boolean[] | null | undefined): number => {
  if (!mask) return 0;
  let n = 0;
  for (const m of mask) if (m) n++;
  return n;
};

/** Human-readable form, e.g. `Q7 = A · age ≥ 30`. */
export const describeConditions = (conds: FilterCondition[]): string =>
  conds.map(({ column, op, value }) => {
    const shown = Array.isArray(value)
      ? (op === 'in' ? `{${value.join(', ')}}` : String(value[0]))
      : String(value);
    return `${column} ${OP_SYMBOL[op]} ${shown}`;
  }).join(' · ');
