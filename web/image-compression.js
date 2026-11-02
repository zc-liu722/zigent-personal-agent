import { assetUrl } from './lazy-assets.js';

const MIN_BYTES = 512 * 1024;
const MAX_COMPRESSION_MS = 1500;
let pending = Promise.resolve();

/** One worker at a time bounds decoded-image memory and keeps the composer responsive. */
export function compressImage(file, signal) {
  // Lossless PNG re-encoding is often slow and saves little; start its upload immediately.
  if (file.size < MIN_BYTES || file.type !== 'image/jpeg'
    || typeof Worker === 'undefined' || signal.aborted) return Promise.resolve(file);
  const operation = pending.then(() => {
    if (signal.aborted) return file;
    return new Promise(resolve => {
      let worker, timer;
      const finish = result => {
        clearTimeout(timer); worker?.terminate(); signal.removeEventListener('abort', cancel);
        resolve(result);
      };
      const cancel = () => finish(file);
      try {
        const workerUrl = assetUrl('./image-compression-worker.js');
        worker = new Worker(workerUrl, { type: 'module' });
        worker.onmessage = event => {
          const result = event.data;
          // Re-encoding must save both meaningful bandwidth and at least ten percent.
          finish(result instanceof Blob && result.size > 0 && result.size <= file.size * .9
            && file.size - result.size >= 64 * 1024 ? result : file);
        };
        worker.onerror = event => { event.preventDefault(); finish(file); };
        worker.onmessageerror = cancel;
        signal.addEventListener('abort', cancel, { once: true });
        timer = setTimeout(cancel, MAX_COMPRESSION_MS);
        worker.postMessage(file);
      } catch { finish(file); }
    });
  });
  pending = operation.catch(() => {});
  return operation;
}
