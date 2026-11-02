// AI Call's streaming resampler, adapted for the web composer. Actual device
// sampleRate is used; iPhone hardware need not honor a requested 16 kHz rate.
class ZigentPCM extends AudioWorkletProcessor {
  constructor() {
    super(); this.input = []; this.position = 0; this.pending = []; this.ratio = sampleRate / 16000;
    this.port.onmessage = event => { if (event.data === 'flush') { this.emit(); this.port.postMessage({ flushed: true }); } };
  }
  emit() {
    if (!this.pending.length) return;
    const pcm = new ArrayBuffer(this.pending.length * 2), view = new DataView(pcm);
    this.pending.forEach((sample, index) => view.setInt16(index * 2, Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), true));
    this.pending = []; this.port.postMessage({ pcm }, [pcm]);
  }
  process(inputs, outputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      this.input.push(...channel);
      while (this.position + 1 < this.input.length) {
        const left = Math.floor(this.position), part = this.position - left;
        this.pending.push(this.input[left] * (1 - part) + this.input[left + 1] * part);
        this.position += this.ratio;
        if (this.pending.length >= 1600) this.emit();
      }
      const used = Math.min(Math.floor(this.position), this.input.length);
      this.input.splice(0, used); this.position -= used;
    }
    for (const channel of outputs[0] || []) channel.fill(0);
    return true;
  }
}
registerProcessor('zigent-pcm', ZigentPCM);
