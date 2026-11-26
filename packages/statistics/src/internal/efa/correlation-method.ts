import type { EfaCorrelationMethod, EfaSpec, EfaPreparedData } from './types';

/** Legacy saved analyses retain their original preprocessing and correlation. */
export const correlationMethod = (spec: Pick<EfaSpec, 'correlation' | 'missing'>): EfaCorrelationMethod | 'auto' =>
  spec.correlation ?? (spec.missing === 'mean' || spec.missing === 'median' ? 'pearson' : 'polychoric');

export const preparedCorrelation = (data: EfaPreparedData): EfaCorrelationMethod => data.numeric ? 'pearson' : 'polychoric';
export const fittingMask = (data: EfaPreparedData) => data.fittingObserved ?? data.observed;

export const correlationDescription = (data: EfaPreparedData) => data.numeric
  ? `Pearson; numeric values; ${data.imputation ? `column ${data.imputation.method} imputation on fitting rows` : 'observed values with pair-specific complete observations'}; original observed support retained; no smoothing`
  : `two-step polychoric; pair margins; maxcor=.9999; no smoothing${data.imputation ? `; column ${data.imputation.method} imputation within declared categories${data.imputation.method === 'median' ? ' (empirical lower category median)' : ''}; original observed support retained` : ''}`;
