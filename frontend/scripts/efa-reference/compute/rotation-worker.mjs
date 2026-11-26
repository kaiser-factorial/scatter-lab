import { rotationDerivativeBatch } from '../../../src/lib/efa/weighted-rotation.ts';
let context;
export function dispatch(data, post) {
  try {
    if (data.op === 'initialize') { context = data.context; post({ id: data.id, value: true }); }
    else if (data.op === 'batch' && context) {
      const value = rotationDerivativeBatch(context, data.start, data.count);
      post({ id: data.id, value }, [value.values.buffer]);
    } else throw new Error('Uninitialized or invalid rotation worker request');
  } catch (error) { post({ id: data.id, error: String(error) }); }
}
if (typeof self !== 'undefined') self.onmessage = ({ data }) => dispatch(data, (value, transfer = []) => self.postMessage(value, transfer));
