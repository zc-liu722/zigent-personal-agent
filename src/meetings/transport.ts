import { Worker } from 'node:worker_threads';
import type { MeetingAudioInput } from './audio-input.js';

export type MeetingTransportFailure = 'connect' | 'socket' | 'closed' | 'protocol' | 'worker'
  | 'input_handoff' | 'output_handoff' | 'queue_limit' | 'queue_age' | 'upstream_backpressure';
export type MeetingTransportStats = { input?: MeetingAudioInput['stats']; failure?: MeetingTransportFailure;
  providerCode?: string; logId?: string; closeCode?: number; maxHandoffMs?: number };

// Owns the worker lifecycle, with bounded handoff in both directions. No model
// context, database, or credentials are logged by the media worker.
export class MeetingTransport {
  private worker: Worker;
  private closing = false;
  private pendingFrames = 0;
  stats: MeetingTransportStats = {};
  constructor(apiKey: string, private callbacks: {
    open: () => void; event: (event: any) => void; fail: (reason: MeetingTransportFailure) => void;
    report: (stats: MeetingTransportStats) => void;
  }) {
    const development = import.meta.url.endsWith('.ts');
    const module = new URL(development ? './transport-worker.ts' : './transport-worker.js', import.meta.url).href;
    this.worker = development
      ? new Worker(`import('tsx/esm/api').then(({tsImport}) => tsImport(require('node:worker_threads').workerData.module, require('node:worker_threads').workerData.parent))`,
        { eval: true, workerData: { apiKey, module, parent: import.meta.url } })
      : new Worker(new URL(module), { workerData: { apiKey } });
    this.worker.on('message', message => {
      if (message.stats) this.stats = { ...this.stats, ...message.stats };
      if (message.type === 'closed') { this.callbacks.report(this.stats); return; }
      if (this.closing) return;
      if (message.type === 'accepted') { this.pendingFrames = Math.max(0, this.pendingFrames - 1); return; }
      if (message.type === 'open') this.callbacks.open();
      if (message.type === 'event') {
        try { this.callbacks.event(message.event); }
        catch { this.failed('protocol'); }
        finally { this.worker.postMessage({ type: 'received', bytes: message.bytes }); }
      }
      if (message.type === 'failure') this.failed(message.reason);
    });
    this.worker.on('error', () => this.failed('worker'));
    this.worker.on('exit', () => { if (!this.closing) this.failed('worker'); });
  }
  private failed(reason: MeetingTransportFailure) {
    if (this.closing) return;
    this.stats.failure = reason; this.callbacks.fail(reason); this.close();
  }
  send(event: object) { if (!this.closing) this.worker.postMessage({ type: 'send', event }); }
  enqueue(frame: Buffer) {
    if (this.closing) return;
    if (++this.pendingFrames > 60) { this.failed('input_handoff'); return; }
    // Buffer slices may share Node's pool: copy only 640 bytes, never transfer it.
    this.worker.postMessage({ type: 'audio', frame: Uint8Array.from(frame), at: performance.now() });
  }
  mute(muted: boolean) { if (!this.closing) this.worker.postMessage({ type: 'mute', muted }); }
  close() {
    if (this.closing) return;
    this.closing = true; this.worker.postMessage({ type: 'close' });
    const timer = setTimeout(() => { void this.worker.terminate(); }, 2500); timer.unref();
    this.worker.once('exit', () => clearTimeout(timer));
  }
}
