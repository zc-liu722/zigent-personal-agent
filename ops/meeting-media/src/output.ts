import { AudioFrame, AudioSource, LocalAudioTrack, Room, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';
import { PcmSpool } from './pcm-spool.js';

// A byte quota protects the host, independent of reply duration or playout latency.
const STORAGE_QUOTA = 64 * 1024 * 1024;
const SAMPLE_RATE = 24000;
const NATIVE_QUANTUM_SAMPLES = SAMPLE_RATE / 100;
type Channel = { publishing?: boolean; source: AudioSource; sid?: string; abort: AbortController; retired?: Promise<void> };
type Output = { generation: number; responseId?: string; itemId?: string; spool: PcmSpool;
  bytes: number; stored: number; done: boolean; drained: boolean; samples: number;
  timer?: NodeJS.Timeout; attached: boolean; announced: boolean; buffering: boolean;
  publishedAt?: number; lastPacketAt?: number };

/** One native media clock and one persistent track between genuine interruptions. */
export class BridgeOutput {
  private queue: Output[] = [];
  private channel?: Channel;
  private buffered = 0;
  private storage = 0;
  private writing = false;
  private epoch = 0;
  generation = 0;
  readonly stats = { generatedSamples: 0, sentSamples: 0, maxBufferedMs: 0, recoveries: 0,
    sourceStarvations: 0, maxPacketGapMs: 0, maxAttachMs: 0, clearedSamples: 0,
    trackPublications: 0, trackReuses: 0, maxNativeCaptureMs: 0, maxSpoolReadMs: 0, tailPaddingSamples: 0 };
  constructor(private room: Room, private emit: (event: object) => void, private failed: (code: string) => void) {}
  private fail(code: string) { this.stats.recoveries++; this.failed(code); }
  snapshot() {
    const o = this.queue[0];
    return { ...this.stats, storageBytes: this.storage, storageQuotaBytes: STORAGE_QUOTA,
      pendingWriteBytes: this.queue.reduce((n, item) => n + item.spool.pendingBytes, 0),
      generation: o?.generation ?? this.generation, queuedMs: this.buffered / 48,
      nativeQueuedMs: this.channel?.source.queuedDuration ?? 0, waitingForAttach: o && !o.attached ? 1 : 0 };
  }
  start(responseId?: string, itemId?: string) {
    if (this.queue.length >= 32) { this.fail('output_capacity'); return; }
    if (this.queue.some(o => !o.done && (itemId ? o.itemId === itemId : responseId && o.responseId === responseId))) return;
    const o: Output = { generation: ++this.generation, responseId, itemId, spool: new PcmSpool(),
      bytes: 0, stored: 0, done: false, drained: false, samples: 0, attached: false, announced: false, buffering: true };
    this.queue.push(o);
    this.emit({ type: 'output_created', generation: o.generation, itemId, responseId });
  }
  private matching(e: any) {
    return [...this.queue].reverse().find(o => !o.done && (!e.response_id || !o.responseId || e.response_id === o.responseId)
      && (!e.item_id || !o.itemId || e.item_id === o.itemId));
  }
  append(e: any) {
    const o = this.matching(e), audio = e.delta ?? e.audio;
    if (!o || typeof audio !== 'string') return;
    if (audio.length > 3 * 1024 * 1024) { this.fail('output_format'); return; }
    const pcm = Buffer.from(audio, 'base64'); if (!pcm.length) return;
    const now = performance.now();
    if (o.lastPacketAt !== undefined) this.stats.maxPacketGapMs = Math.max(this.stats.maxPacketGapMs, now - o.lastPacketAt);
    o.lastPacketAt = now;
    if (this.storage + pcm.length > STORAGE_QUOTA) { this.fail('output_storage_capacity'); return; }
    if (this.queue.reduce((n, item) => n + item.spool.pendingBytes, 0) + pcm.length > 4 * 1024 * 1024) { this.fail('output_storage_backpressure'); return; }
    if (!o.spool.append(pcm)) { this.fail('output_storage_backpressure'); return; }
    o.bytes += pcm.length; o.stored += pcm.length; this.storage += pcm.length; this.buffered += pcm.length;
    this.stats.generatedSamples += pcm.length / 2;
    this.stats.maxBufferedMs = Math.max(this.stats.maxBufferedMs, this.buffered / 48);
    void this.pump();
  }
  end(e: any) {
    const o = this.matching(e); if (!o) return;
    o.done = true;
    this.emit({ type: 'generation_complete', generation: o.generation });
    void this.pump();
  }
  private async pump() {
    if (this.writing) return;
    this.writing = true; const epoch = this.epoch;
    let io = false;
    try {
      while (this.queue.length && epoch === this.epoch) {
        const o = this.queue[0]!; if (o.drained) return;
        if (!this.channel) {
          const channel: Channel = this.channel = { publishing: true, source: new AudioSource(SAMPLE_RATE, 1, 320), abort: new AbortController() };
          const track = LocalAudioTrack.createAudioTrack('zigent-output', channel.source);
          const options = new TrackPublishOptions(); options.source = TrackSource.SOURCE_MICROPHONE; options.red = true; options.dtx = false;
          const publication = await this.room.localParticipant!.publishTrack(track, options).finally(() => { channel.publishing = false; });
          channel.sid = publication.sid; this.stats.trackPublications++;
          if (epoch !== this.epoch) { await this.retire(channel); return; }
          this.announce(o, channel);
          await this.bounded(publication.waitForSubscription(), channel.abort.signal);
          if (epoch !== this.epoch) return;
        }
        const channel = this.channel!;
        if (!o.announced) { this.stats.trackReuses++; this.announce(o, channel); }
        if (!o.attached) return;
        if (o.samples > 0 && !o.done && !o.buffering && channel.source.queuedDuration === 0) {
          o.buffering = true; this.stats.sourceStarvations++;
        }
        if (o.buffering) { if (!o.done && o.bytes < 24000 * 2 * .24) return; o.buffering = false; }
        if (o.bytes < 1920 && !o.done) return;
        if (o.bytes) {
          if (o.done && o.bytes % 2) { this.fail('output_format'); return; }
          const size = Math.min(960, Math.floor(o.bytes / 2) * 2);
          io = true; const readAt = performance.now(); const pcm = await o.spool.read(size); io = false;
          this.stats.maxSpoolReadMs = Math.max(this.stats.maxSpoolReadMs, performance.now() - readAt);
          if (epoch !== this.epoch) return;
          if (pcm.length !== size) throw new Error('spool_size');
          o.bytes -= size; this.buffered -= size;
          const contentSamples = size / 2;
          // rtc-ffi 0.13.1 consumes only whole 10 ms quanta. It retains a
          // shorter tail while emitting silence, even after waitForPlayout().
          // Flush the faded tail with zero padding so it cannot be stranded
          // at the end of this utterance or prefixed to the next one.
          const paddingSamples = o.done && o.bytes === 0 ? (NATIVE_QUANTUM_SAMPLES - contentSamples % NATIVE_QUANTUM_SAMPLES) % NATIVE_QUANTUM_SAMPLES : 0;
          const data = new Int16Array(contentSamples + paddingSamples);
          for (let i = 0; i < contentSamples; i++) {
            const head = Math.min(1, (o.samples + i) / 120), tail = o.done ? Math.min(1, (o.bytes / 2 + contentSamples - 1 - i) / 120) : 1;
            data[i] = Math.round(pcm.readInt16LE(i * 2) * Math.min(head, tail));
          }
          const at = performance.now();
          await this.bounded(channel.source.captureFrame(new AudioFrame(data, SAMPLE_RATE, 1, data.length)), channel.abort.signal);
          if (epoch !== this.epoch) return;
          this.stats.maxNativeCaptureMs = Math.max(this.stats.maxNativeCaptureMs, performance.now() - at);
          o.samples += contentSamples; this.stats.sentSamples += contentSamples;
          this.stats.tailPaddingSamples += paddingSamples;
          continue;
        }
        if (!o.done) return;
        await this.bounded(channel.source.waitForPlayout(), channel.abort.signal);
        if (epoch !== this.epoch) return;
        o.drained = true;
        o.timer = setTimeout(() => this.fail('client_playback_stall'), 10000);
        this.emit({ type: 'source_drained', generation: o.generation, trackSid: channel.sid, samples: o.samples, clientPlaybackConfirmed: false });
        return;
      }
    } catch { if (epoch === this.epoch) this.fail(io ? 'output_storage_io' : 'output_native'); }
    finally { this.writing = false; if (epoch !== this.epoch && this.queue.length) void this.pump(); }
  }
  private announce(o: Output, channel: Channel) {
    o.announced = true; o.publishedAt = performance.now();
    o.timer = setTimeout(() => this.fail('client_attach_timeout'), 10000);
    this.emit({ type: 'track_published', generation: o.generation, trackSid: channel.sid });
  }
  clientAttached(generation: number, sid: string) {
    const o = this.queue[0]; if (!o || o.generation !== generation || this.channel?.sid !== sid || o.attached) return;
    clearTimeout(o.timer); o.attached = true;
    const attachMs = performance.now() - (o.publishedAt ?? performance.now());
    this.stats.maxAttachMs = Math.max(this.stats.maxAttachMs, attachMs);
    this.emit({ type: 'track_attached', generation, attachMs }); void this.pump();
  }
  clientProgress(generation: number, sid: string, samples: number) {
    const o = this.queue[0]; if (!o || o.generation !== generation || this.channel?.sid !== sid) return;
    this.emit({ type: 'playback_progress', generation, playedSamples: Math.min(samples, o.samples), sentSamples: o.samples, evidence: 'estimated' });
  }
  async clientEnded(generation: number, sid: string) {
    const o = this.queue[0];
    if (!o || o.generation !== generation || this.channel?.sid !== sid || !o.done || !o.drained || o.bytes) return false;
    clearTimeout(o.timer); this.queue.shift(); this.storage -= o.stored;
    await o.spool.close(); void this.pump(); return true;
  }
  userStarted() {
    // Ordinary turn-taking after a completed segment keeps the warm track.
    // Only speech overlapping pending output is an output interruption.
    if (this.queue.length) this.clear();
  }
  clear() {
    this.stats.clearedSamples += this.buffered / 2;
    this.epoch++; this.generation++;
    const old = this.queue, channel = this.channel;
    this.queue = []; this.buffered = 0; this.storage = 0; this.channel = undefined;
    // Tell the phone to fade/detach before retiring the old native sender.
    this.emit({ type: 'output_invalidated', generation: this.generation });
    channel?.abort.abort(); channel?.source.clearQueue();
    for (const o of old) { clearTimeout(o.timer); void o.spool.close().catch(() => {}); }
    if (channel) void this.retire(channel).catch(() => {});
  }
  private async bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    let timer: NodeJS.Timeout | undefined, abort: (() => void) | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        abort = () => reject(new Error('output_cleared'));
        if (signal.aborted) { abort(); return; }
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => reject(new Error('native_timeout')), 10000);
      })]);
    } finally { clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort); }
  }
  private retire(channel: Channel) {
    // publishTrack may still be pending on interruption; the late publication
    // is retired by pump's epoch check when its SID becomes available.
    if (channel.publishing) return Promise.resolve();
    return channel.retired ??= (async () => {
      try { if (channel.sid) await this.room.localParticipant?.unpublishTrack(channel.sid); }
      finally { await channel.source.close(); }
    })();
  }
}
