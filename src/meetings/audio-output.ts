const SAMPLE_RATE = 24000;
const FRAME_BYTES = SAMPLE_RATE * 2 * .04;
const WINDOW_BYTES = SAMPLE_RATE * 2 * 1.6;
// The original twelve-second ceiling now covers queued AND unplayed audio,
// rather than allowing a second unbounded queue in front of the worklet.
const MAX_BYTES = SAMPLE_RATE * 2 * 12;
const PROGRESS_TIMEOUT_MS = 10000;

export type OutputFailure = 'output_capacity' | 'output_format' | 'playback_stall';
type Output = { generation: number; chunks: Buffer[]; offset: number; queued: number;
  sent: number; consumed: number; done: boolean; announced: boolean; endSent: boolean; heard: boolean };

// Credit comes from samples actually rendered by the browser, not WebSocket
// receipt or a timer. A completed synthesis can still have audible work left.
export class MeetingAudioOutput {
  private outputs: Output[] = [];
  private buffered = 0;
  private timer?: NodeJS.Timeout;
  private lastProgress = 0;
  readonly stats = { receivedSamples: 0, renderedSamples: 0, maxBufferedMs: 0, maxInFlightMs: 0,
    creditWaits: 0, completed: 0, recoveries: 0, failure: undefined as OutputFailure | undefined };

  constructor(private callbacks: { send: (event: object) => void; failed: (reason: OutputFailure) => void;
    drained: (generation: number) => void }) {}

  start(generation: number) {
    if (this.outputs.length >= 32) { this.fail('output_capacity'); return; }
    this.outputs.push({ generation, chunks: [], offset: 0, queued: 0, sent: 0, consumed: 0,
      done: false, announced: false, endSent: false, heard: false });
    this.flush();
  }

  append(generation: number, audio: unknown) {
    const output = this.outputs.find(item => item.generation === generation);
    if (!output || output.done) return;
    if (typeof audio !== 'string' || !audio.length) return;
    if (audio.length > Math.ceil(MAX_BYTES / 3) * 4) { this.fail('output_capacity'); return; }
    const pcm = Buffer.from(audio, 'base64');
    if (!pcm.length) return;
    if (this.buffered + pcm.length > MAX_BYTES || output.chunks.length >= 1024) { this.fail('output_capacity'); return; }
    output.chunks.push(pcm); output.queued += pcm.length; this.buffered += pcm.length;
    this.stats.receivedSamples += pcm.length / 2;
    this.stats.maxBufferedMs = Math.max(this.stats.maxBufferedMs, Math.ceil(this.buffered / 48));
    this.flush();
  }

  end(generation: number) {
    const output = this.outputs.find(item => item.generation === generation);
    if (!output) return;
    output.done = true;
    // Odd packet boundaries are fine; an incomplete final PCM sample is not.
    if (output.queued % 2) { this.fail('output_format'); return; }
    this.flush();
  }

  heard(generation: unknown) {
    const output = this.outputs[0];
    if (!output || generation !== output.generation || !output.announced || output.heard) return false;
    output.heard = true; return true;
  }

  owns(generation: unknown) { return typeof generation === 'number' && this.outputs[0]?.generation === generation; }

  acknowledge(generation: unknown, samples: unknown, drained: boolean) {
    const output = this.outputs[0];
    if (!output || output.generation !== generation || typeof samples !== 'number' || !Number.isSafeInteger(samples)) return;
    const bytes = samples * 2;
    if (bytes < output.consumed || bytes > output.sent) return;
    if (bytes > output.consumed) {
      this.buffered -= bytes - output.consumed;
      this.stats.renderedSamples += (bytes - output.consumed) / 2;
      output.consumed = bytes; this.lastProgress = performance.now();
    }
    if (drained && output.done && output.endSent && !output.queued && bytes === output.sent) {
      this.outputs.shift(); clearTimeout(this.timer); this.timer = undefined; this.stats.completed++;
      this.callbacks.drained(output.generation);
    }
    this.flush();
  }

  private flush() {
    const output = this.outputs[0];
    if (!output) return;
    if (!output.announced) {
      output.announced = true; this.lastProgress = performance.now();
      this.callbacks.send({ type: 'audio_start', generation: output.generation });
    }
    // Each browser message is at most 40 ms. The worklet never has to accept an
    // arbitrarily large supplier packet, even after a burst in TCP delivery.
    while (this.outputs[0] === output) {
      const credit = WINDOW_BYTES - (output.sent - output.consumed);
      const bytes = Math.min(FRAME_BYTES, Math.floor(output.queued / 2) * 2, Math.floor(credit / 2) * 2);
      if (!bytes || bytes < FRAME_BYTES && !output.done) break;
      const frame = Buffer.allocUnsafe(bytes);
      let written = 0;
      while (written < bytes) {
        const chunk = output.chunks[0]!, count = Math.min(bytes - written, chunk.length - output.offset);
        chunk.copy(frame, written, output.offset, output.offset + count);
        written += count; output.offset += count;
        if (output.offset === chunk.length) { output.chunks.shift(); output.offset = 0; }
      }
      const offset = output.sent / 2;
      if (output.sent === output.consumed) this.lastProgress = performance.now();
      output.queued -= bytes; output.sent += bytes;
      this.stats.maxInFlightMs = Math.max(this.stats.maxInFlightMs, Math.ceil((output.sent - output.consumed) / 48));
      this.callbacks.send({ type: 'audio', generation: output.generation, offset, audio: frame.toString('base64') });
    }
    if (this.outputs[0] !== output) return;
    if (output.queued && output.sent - output.consumed >= WINDOW_BYTES - FRAME_BYTES) this.stats.creditWaits++;
    if (output.done && !output.queued && !output.endSent) {
      output.endSent = true;
      this.callbacks.send({ type: 'audio_done', generation: output.generation });
    }
    if (output.sent === output.consumed) { clearTimeout(this.timer); this.timer = undefined; }
    else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (performance.now() - this.lastProgress >= PROGRESS_TIMEOUT_MS) this.fail('playback_stall');
        else this.flush();
      }, Math.max(1, PROGRESS_TIMEOUT_MS - (performance.now() - this.lastProgress)));
      this.timer.unref();
    }
  }

  private fail(reason: OutputFailure) {
    this.stats.failure = reason; this.stats.recoveries++; this.clear(); this.callbacks.failed(reason);
  }
  clear() { clearTimeout(this.timer); this.timer = undefined; this.outputs = []; this.buffered = 0; }
}
