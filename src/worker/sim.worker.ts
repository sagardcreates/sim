/** Web Worker entry: forwards messages to the sim host. */
import { handleMessage } from './host';
import type { ToWorker } from './protocol';

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  handleMessage(ev.data, (msg, transfer = []) => (self as unknown as Worker).postMessage(msg, transfer));
};
