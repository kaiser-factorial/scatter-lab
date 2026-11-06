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
