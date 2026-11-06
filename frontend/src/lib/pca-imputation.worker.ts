/// <reference lib="webworker" />
import type { DataTable } from './table';
import type { EfaPreparedData } from './efa/types';
import { runPcaMiceChain, type PcaMiceSettings } from './pca-imputation-core';

let context: { table: DataTable; source: EfaPreparedData; settings: PcaMiceSettings } | undefined;
self.onmessage = (event: MessageEvent) => {
  try {
    if (event.data.op === 'initialize') {
      context = event.data.context;
      self.postMessage({ kind: 'ready' });
      return;
    }
    if (!context || event.data.op !== 'chain') throw new Error('Initialize the PCA imputation worker before running a chain.');
    const result = runPcaMiceChain(context.table, context.source, context.settings, event.data.index,
      progress => self.postMessage({ kind: 'progress', progress }));
    // Do not clone all original inputs back for each fit; the caller owns them.
    if (result.result) result.result.table = { nRows: context.table.nRows, columns: result.result.columns,
      data: Object.fromEntries(result.result.columns.map(c => [c, result.result!.table.data[c]])) };
    self.postMessage({ kind: 'chain', result });
  } catch (error) {
    self.postMessage({ kind: 'error', error: error instanceof Error ? error.message : String(error) });
  }
};
