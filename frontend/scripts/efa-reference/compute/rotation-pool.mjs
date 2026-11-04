import { rotationDerivativeBatch } from '../../../src/lib/efa/weighted-rotation.ts';
/** The coordinator computes slot zero; at most three peers, four workers total.
 * Yield after its batch so replies, progress and cancellation can be serviced. */
export function createRotationPool(factory, concurrency) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('Invalid rotation concurrency');
  const peers = Array.from({ length: concurrency - 1 }, () => {
    const worker = factory();
    const client = { worker, next: 0, pending: new Map(), context: undefined };
    worker.onmessage = ({ data }) => {
      const callback = client.pending.get(data.id);
      if (!callback) return;
      client.pending.delete(data.id);
      if (data.error) callback.reject(new Error(data.error)); else callback.resolve(data.value);
    };
    worker.onerror = event => { for (const callback of client.pending.values()) callback.reject(new Error(event.message)); client.pending.clear(); };
    return client;
  });
  let closed = false;
  function request(client, data) {
    return new Promise((resolve, reject) => {
      const id = ++client.next;
      client.pending.set(id, { resolve, reject });
      try { client.worker.postMessage({ ...data, id }); }
      catch (error) { client.pending.delete(id); reject(error); }
    });
  }
  return {
    concurrency,
    metadata: { concurrency, peerWorkers: peers.length, batchSize: 8, scheduling: 'Coordinator plus bounded peer workers; same four perturbations and seeded rotation checks' },
    async execute(context, start, count, slot) {
      if (closed) throw new Error('Rotation pool closed');
      if (slot === 0) {
        const batch = rotationDerivativeBatch(context, start, count);
        await new Promise(resolve => setTimeout(resolve, 0));
        if (closed) throw new Error('Rotation pool closed');
        return batch;
      }
      const client = peers[slot - 1];
      if (client.context !== context) { await request(client, { op: 'initialize', context }); client.context = context; }
      return request(client, { op: 'batch', start, count });
    },
    destroy() {
      closed = true;
      for (const client of peers) {
        client.worker.terminate();
        for (const callback of client.pending.values()) callback.reject(new Error('Rotation pool closed'));
        client.pending.clear();
      }
    },
  };
}
