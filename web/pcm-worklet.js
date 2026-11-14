// AI Call's streaming resampler, adapted for the web composer. Actual device
// sampleRate is used; iPhone hardware need not honor a requested 16 kHz rate.
class ZigentPCM extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frameSamples = options?.processorOptions?.frameSamples === 320 ? 320 : 1600; this.input = []; this.position = 0; this.pending = []; this.ratio = sampleRate / 16000;
    this.port.onmessage = event => { if (event.data === 'flush') { this.emit(); this.port.postMessage({ flushed: true }); } };
  }
  emit() {
    if (!this.pending.length) return;
    const pcm = new ArrayBuffer(this.pending.length * 2), view = new DataView(pcm);
    this.pending.forEach((sample, index) => view.setInt16(index * 2, Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), true));
    this.pending = []; this.port.postMessage({ pcm, audioTime: currentTime }, [pcm]);
  }
  process(inputs, outputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      this.input.push(...channel);
      while (this.position + 1 < this.input.length) {
        const left = Math.floor(this.position), part = this.position - left;
        this.pending.push(this.input[left] * (1 - part) + this.input[left + 1] * part);
        this.position += this.ratio;
        if (this.pending.length >= this.frameSamples) this.emit();
      }
      const used = Math.min(Math.floor(this.position), this.input.length);
      this.input.splice(0, used); this.position -= used;
    }
    for (const channel of outputs[0] || []) channel.fill(0);
    return true;
  }
}
registerProcessor('zigent-pcm', ZigentPCM);

// One continuous sample clock, with a bounded render window fed by actual
// consumption credit. Packet boundaries never reset interpolation or gain.
class ZigentPlayback extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = new Float32Array(24000 * 2);
    this.read = this.write = 0; this.started = this.done = this.blocked = false;
    this.target = 24000 * .32; this.epoch = 0; this.spoken = this.reported = false;
    this.gain = this.lastSample = this.fadeSample = this.fadeRemaining = 0;
    this.nextReport = 0; this.maxQueueMs = 0; this.jitterMs = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'clear') {
        this.fade();
        this.read = this.write = 0; this.started = this.done = this.blocked = false;
        this.gain = 0; this.epoch = data.epoch; this.spoken = this.reported = false;
        this.lastArrival = undefined; this.nextReport = 0;
        // Keep the learned jitter target across natural turn boundaries. Only
        // a turn with no starvation may gradually reduce the extra latency.
        if (!this.starved) this.target = Math.max(24000 * .32, this.target - 24000 * .02);
        this.starved = false;
      } else if (data.epoch === this.epoch && data.type === 'pcm' && !this.blocked) {
        const samples = new Float32Array(data.samples);
        if (data.offset !== this.write) { this.recover('playback_sequence'); return; }
        if (this.write - Math.floor(this.read) + samples.length > this.queue.length) {
          this.recover('playback_capacity'); return;
        }
        if (this.lastArrival !== undefined) {
          const late = Math.max(0, (currentTime - this.lastArrival) * 1000 - this.lastDurationMs);
          this.jitterMs = Math.max(late, this.jitterMs * .98);
          this.target = Math.max(this.target, Math.min(24000 * .8, 24 * (this.jitterMs + 120)));
        }
        this.lastArrival = currentTime; this.lastDurationMs = samples.length / 24;
        for (let i = 0; i < samples.length; i++) this.queue[this.write++ % this.queue.length] = samples[i];
        this.maxQueueMs = Math.max(this.maxQueueMs, (this.write - this.read) / 24);
      } else if (data.epoch === this.epoch && data.type === 'end' && !this.blocked) {
        this.done = true;
      }
    };
  }
  fade() {
    // Preserve an in-progress fade when multiple clears arrive before the next
    // render quantum; restarting it at full amplitude creates a click.
    if (!this.fadeRemaining) {
      this.fadeSample = this.lastSample; this.fadeRemaining = Math.ceil(sampleRate * .005);
    }
  }
  recover(cause) {
    this.blocked = true; this.started = false; this.fade();
    this.port.postMessage({ type: 'recover', cause, epoch: this.epoch });
  }
  progress(type = 'progress') {
    this.port.postMessage({ type, epoch: this.epoch, consumedSamples: Math.min(this.write, Math.floor(this.read)),
      queueMs: Math.round(Math.max(0, this.write - this.read) / 24), maxQueueMs: Math.round(this.maxQueueMs),
      targetMs: Math.round(this.target / 24), jitterMs: Math.round(this.jitterMs) });
  }
  process(inputs, outputs) {
    const output = outputs[0]?.[0]; if (!output) return true;
    const step = 24000 / sampleRate, ramp = Math.max(1, sampleRate * .005);
    const available = this.write - this.read;
    if (!this.blocked && !this.started && (available >= this.target || this.done && available > 0)) {
      this.started = true; this.gain = 0;
      if (!this.spoken) { this.spoken = true; this.port.postMessage({ type: 'started', epoch: this.epoch }); }
    }
    for (let i = 0; i < output.length; i++) {
      let value = 0;
      if (this.started) {
        const remaining = this.write - this.read;
        if (remaining < (this.done ? 1 : Math.max(2, step))) {
          this.started = false; this.gain = 0; this.fade();
          if (!this.done) {
            this.starved = true;
            this.target = Math.min(24000 * .8, Math.max(this.target + 24000 * .12, 24 * (this.jitterMs + 120)));
            this.port.postMessage({ type: 'underrun', epoch: this.epoch });
          }
        } else {
          const left = Math.floor(this.read), part = this.read - left;
          const a = this.queue[left % this.queue.length], b = this.queue[Math.min(left + 1, this.write - 1) % this.queue.length];
          // Fade toward a possible gap; if new PCM arrives, restore gain over
          // five milliseconds instead of stepping back to full amplitude.
          const tail = Math.min(1, remaining / (step * ramp));
          this.gain = Math.min(1, this.gain + 1 / ramp, tail);
          value = (a + (b - a) * part) * this.gain; this.read = Math.min(this.write, this.read + step);
        }
      }
      if (this.fadeRemaining > 0) {
        const weight = (1 - Math.cos(Math.PI * this.fadeRemaining-- / Math.ceil(sampleRate * .005))) / 2;
        value = value * (1 - weight) + this.fadeSample * weight;
      }
      output[i] = value; this.lastSample = value;
    }
    if (this.done && this.write - this.read < 1 && !this.fadeRemaining && !this.reported) {
      this.read = this.write; this.reported = true; this.started = false; this.progress('drained');
    } else if (currentTime >= this.nextReport) {
      this.nextReport = currentTime + .1; this.progress();
    }
    return true;
  }
}
registerProcessor('zigent-playback', ZigentPlayback);
