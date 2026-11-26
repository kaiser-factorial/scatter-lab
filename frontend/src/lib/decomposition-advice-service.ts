import { analyzeDecompositionItems, type DecompositionAdvice, type DecompositionAdviceOptions } from './decomposition-advice';
import type { DataTable } from './table';

/** Selected input stays in a local worker. Abort terminates ongoing profiling. */
export function analyzeItemsAsync(table: DataTable, columns: string[], options: DecompositionAdviceOptions, signal?: AbortSignal): Promise<DecompositionAdvice> {
  if (signal?.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
  if (typeof Worker === 'undefined') return Promise.resolve().then(() => {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const result = analyzeDecompositionItems(table, columns, options);
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    return result;
  });
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./decomposition-advice.worker.ts', import.meta.url));
    const clean = () => { worker.terminate(); signal?.removeEventListener('abort', abort); };
    const abort = () => { clean(); reject(new DOMException('Cancelled', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ result?: DecompositionAdvice; error?: string }>) => {
      clean();
      if (event.data.result) resolve(event.data.result);
      else reject(new Error(event.data.error ?? 'Item analysis failed.'));
    };
    worker.onerror = () => { clean(); reject(new Error('The item-analysis worker failed.')); };
    try {
      worker.postMessage({ table: { columns, data: Object.fromEntries(columns.map(c => [c, table.data[c]])), nRows: table.nRows }, columns, options });
    } catch { clean(); reject(new Error('The selected items could not be sent to the local analysis worker.')); }
  });
}
