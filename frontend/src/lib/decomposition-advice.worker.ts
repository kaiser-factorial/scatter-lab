import { analyzeDecompositionItems, type DecompositionAdviceOptions } from './decomposition-advice';
import type { DataTable } from './table';

self.onmessage = (event: MessageEvent<{ table: DataTable; columns: string[]; options: DecompositionAdviceOptions }>) => {
  try {
    const { table, columns, options } = event.data;
    self.postMessage({ result: analyzeDecompositionItems(table, columns, options) });
  } catch {
    self.postMessage({ error: 'The selected items could not be assessed. Check the item types and declared category orders.' });
  }
};
