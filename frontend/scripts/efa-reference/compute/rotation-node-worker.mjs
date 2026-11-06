import { parentPort } from 'node:worker_threads';
import { dispatch } from './rotation-worker.mjs';
parentPort.on('message', data => dispatch(data, (value, transfer = []) => parentPort.postMessage(value, transfer)));
