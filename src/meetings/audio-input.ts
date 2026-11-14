// The AudioWorklet is the media clock: every incoming frame already represents
// 20 ms of live PCM. Re-clocking it here makes gaps in TCP delivery permanent
// latency. Like Volcengine's web demo, relay live frames as they arrive; queue
// only while the actual supplier socket is backpressured.
const FRAME_MS = 20;
const MAX_QUEUE_MS = 1200;
const STARVATION_MS = 500;
const HIGH_WATER_BYTES = 16 * 1024;
const MAX_BLOCKED_MS = 1000;
export type InputFailure = 'queue_limit' | 'queue_age' | 'upstream_backpressure';

export class MeetingAudioInput {
  private queue: Array<{ pcm: Buffer; at: number }> = [];
  private timer?: NodeJS.Timeout;
  private closed = false;
  private draining = false;
  private requestedMute = true;
  private muted = true;
  private lastSent = -Infinity;
  private lastReceived?: number;
  private blockedAt?: number;
  readonly stats = { receivedFrames: 0, frames: 0, maxQueuedFrames: 0, maxQueueMs: 0,
    maxReceiveGapMs: 0, maxSendGapMs: 0, maxBufferedBytes: 0, backpressureWaits: 0, starvationMutes: 0 };

  constructor(private send: (event: object) => void, private buffered: () => number,
    private fail: (reason: InputFailure) => void) {
    this.send({ type: 'input_audio_mute.commit' });
  }

  mute(value: boolean) {
    if (this.closed) return;
    this.requestedMute = value;
    if (value) {
      this.queue = []; clearTimeout(this.timer); this.timer = undefined;
      this.lastSent = -Infinity; this.lastReceived = undefined; this.blockedAt = undefined;
      this.setMuted(true);
    }
  }

  enqueue(pcm: Buffer, at = performance.now()) {
    if (this.closed || this.requestedMute) return;
    if (this.lastReceived !== undefined) this.stats.maxReceiveGapMs = Math.max(this.stats.maxReceiveGapMs, Math.round(at - this.lastReceived));
    this.lastReceived = at; this.stats.receivedFrames++;
    if (this.queue.length >= MAX_QUEUE_MS / FRAME_MS) { this.stop('queue_limit'); return; }
    this.queue.push({ pcm, at });
    this.stats.maxQueuedFrames = Math.max(this.stats.maxQueuedFrames, this.queue.length);
    this.drain();
  }

  private stop(reason: InputFailure) { this.close(); this.fail(reason); }
  private setMuted(value: boolean) {
    if (this.muted === value) return;
    this.muted = value;
    this.send({ type: value ? 'input_audio_mute.commit' : 'input_audio_unmute.commit' });
  }
  private arm(delay: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; this.drain(); }, Math.max(1, Math.ceil(delay)));
  }

  // Called on arrival and socket write completion, never by a second audio
  // cadence. The timer is only a backpressure / microphone-idle watchdog.
  drain() {
    if (this.closed || this.requestedMute || this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const now = performance.now(), frame = this.queue[0]!;
        const age = Math.max(0, now - frame.at);
        this.stats.maxQueueMs = Math.max(this.stats.maxQueueMs, Math.round(age));
        if (age > MAX_QUEUE_MS) { this.stop('queue_age'); return; }
        const buffered = this.buffered();
        this.stats.maxBufferedBytes = Math.max(this.stats.maxBufferedBytes, buffered);
        if (buffered > HIGH_WATER_BYTES) {
          this.blockedAt ??= now; this.stats.backpressureWaits++;
          if (now - this.blockedAt >= MAX_BLOCKED_MS) { this.stop('upstream_backpressure'); return; }
          this.arm(FRAME_MS); return;
        }
        this.blockedAt = undefined;
        this.queue.shift(); this.setMuted(false);
        this.send({ type: 'input_audio_buffer.append', audio: frame.pcm.toString('base64') });
        if (Number.isFinite(this.lastSent)) this.stats.maxSendGapMs = Math.max(this.stats.maxSendGapMs, Math.round(now - this.lastSent));
        this.lastSent = now; this.stats.frames++;
      }
      const idle = performance.now() - this.lastSent;
      if (idle >= STARVATION_MS) {
        if (!this.muted) this.stats.starvationMutes++;
        this.setMuted(true); this.lastSent = -Infinity;
        clearTimeout(this.timer); this.timer = undefined;
      } else this.arm(STARVATION_MS - idle);
    } finally { this.draining = false; }
  }
  close() { this.closed = true; clearTimeout(this.timer); this.timer = undefined; this.queue = []; }
}
