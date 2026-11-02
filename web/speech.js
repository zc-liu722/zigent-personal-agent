'use strict';
// Keep ASR-owned characters separate from keyboard edits. Empty, locked source
// cells remember deletions so a later provider revision cannot restore them.
window.ZigentSpeechDraft = class {
  constructor(input) {
    const start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start;
    this.text = ''; this.value = input.value;
    this.parts = input.value.split('').map((text, index) => ({ text, source: index >= start && index < end ? -1 : null }));
    this.tail = { text: '', source: Infinity };
    this.parts.splice(end, 0, this.tail);
  }
  edit(value) {
    let start = 0, end = this.value.length, nextEnd = value.length;
    while (start < end && start < nextEnd && this.value[start] === value[start]) start++;
    while (end > start && nextEnd > start && this.value[end - 1] === value[nextEnd - 1]) { end--; nextEnd--; }
    if (start === end && start === nextEnd) return;
    let position = 0, insertion;
    const parts = [];
    for (const part of this.parts) {
      if (insertion === undefined && position >= start) insertion = parts.length;
      const removed = position >= start && position < end && part.text;
      position += part.text.length;
      if (removed && part.source === null) continue;
      if (removed) { part.text = ''; part.locked = true; }
      parts.push(part);
    }
    parts.splice(insertion ?? parts.length, 0, ...value.slice(start, nextEnd).split('').map(text => ({ text, source: null })));
    this.parts = parts; this.value = value;
  }
  anchor(position) {
    let offset = 0;
    const index = this.parts.findIndex(part => { const found = offset >= position; offset += part.text.length; return found; });
    return index < 0 ? [] : this.parts.slice(index);
  }
  position(anchor) {
    const retained = new Set(this.parts), boundary = anchor.find(part => retained.has(part));
    let position = 0;
    for (const part of this.parts) { if (part === boundary) break; position += part.text.length; }
    return position;
  }
  get insertionEnd() { return this.position([this.tail]); }
  update(text) {
    let start = 0, end = this.text.length, nextEnd = text.length;
    while (start < end && start < nextEnd && this.text[start] === text[start]) start++;
    while (end > start && nextEnd > start && this.text[end - 1] === text[nextEnd - 1]) { end--; nextEnd--; }
    const replacement = text.slice(start, nextEnd), delta = nextEnd - end;
    const boundary = this.parts.find(part => part.source !== null && part.source >= end);
    this.parts = this.parts.filter(part => part.source !== -1);
    this.parts = this.parts.filter(part => {
      if (part.source === null || part === this.tail) return true;
      if (part.source >= end) { part.source += delta; return true; }
      if (part.source < start) return true;
      const offset = part.source - start;
      if (offset >= replacement.length) return false;
      if (!part.locked) part.text = replacement[offset];
      return true;
    });
    const extra = replacement.slice(end - start).split('').map((text, index) => ({ text, source: end + index }));
    this.parts.splice(this.parts.indexOf(boundary), 0, ...extra);
    let available = Math.max(0, 16000 - this.parts.reduce((sum, part) => sum + (part.source === null ? part.text.length : 0), 0));
    for (const part of this.parts) if (part.source !== null && part.text) {
      if (available) available--; else part.text = '';
    }
    this.text = text; this.value = this.parts.map(part => part.text).join('');
    return this.value;
  }
};
// Capture outlives a transport connection. Only unacknowledged PCM is retained,
// in this tab, for at most 30 seconds of audio; receipt ACKs prevent replay duplicates.
window.ZigentSpeechInput = class {
  constructor({ onState, onText }) { this.onState = onState; this.onText = onText; this.state = 'idle'; this.lastWarmAt = -Infinity; }
  static supported() { return Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.AudioContext && window.AudioWorkletNode && window.WebSocket); }
  createCapture() {
    const context = new AudioContext({ latencyHint: 'interactive' });
    try {
      const module = context.audioWorklet.addModule(document.getElementById('speech-worklet')?.href || new URL('./pcm-worklet.js', location.href).href);
      return { context, module };
    } catch (error) { void context.close().catch(() => {}); throw error; }
  }
  // Prepare processing on composer intent, without opening or requesting a microphone.
  // The prepared context is consumed by the next click or expires after 30 seconds.
  prepare() {
    if (this.session || document.hidden || !window.ZigentSpeechInput.supported()) return;
    if (!this.prepared) try {
      const prepared = this.createCapture(); this.prepared = prepared;
      prepared.timer = setTimeout(() => { if (this.prepared === prepared) this.discardPrepared(); }, 30000);
      prepared.module.catch(() => { if (this.prepared === prepared) this.discardPrepared(); });
    } catch { this.discardPrepared(); }
    this.prepareTransport();
  }
  speechUrl() {
    const url = new URL('./api/speech', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.href;
  }
  prepareTransport() {
    if (this.warmTransport || navigator.onLine === false || performance.now() - this.lastWarmAt < 15000) return;
    this.lastWarmAt = performance.now();
    try {
      const socket = new WebSocket(this.speechUrl(), 'zigent-speech-v2');
      const warm = { socket }; this.warmTransport = warm;
      warm.timer = setTimeout(() => { if (this.warmTransport === warm) this.discardTransport(); }, 7000);
      socket.onopen = () => socket.send(JSON.stringify({ type: 'prepare' }));
      const lost = () => { if (this.warmTransport === warm) this.discardTransport(); };
      socket.onerror = socket.onclose = lost;
    } catch { this.discardTransport(); }
  }
  discardTransport() {
    const warm = this.warmTransport; this.warmTransport = undefined;
    if (warm) {
      clearTimeout(warm.timer); warm.socket.onopen = warm.socket.onmessage = warm.socket.onerror = warm.socket.onclose = null;
      warm.socket.close();
    }
  }
  discardPrepared() {
    this.discardTransport();
    const prepared = this.prepared; this.prepared = undefined;
    if (prepared) { clearTimeout(prepared.timer); void prepared.context.close().catch(() => {}); }
  }
  setState(state, message = '') { if (state !== this.state) { this.state = state; this.onState(state, message); } }
  async start() {
    if (this.session) return;
    const session = { id: crypto.randomUUID(), queue: [], bytes: 0, sequence: 0, acknowledged: 0, sent: 0,
      ready: false, capturing: false, ending: false, closed: false, started: performance.now(), timings: {} };
    this.lastTimings = session.timings;
    session.mark = stage => { session.timings[stage] ??= Math.round(performance.now() - session.started); };
    session.completed = new Promise(resolve => { session.resolve = resolve; });
    this.session = session; this.setState('starting');
    const fail = message => { if (this.session === session) this.end(message); };
    const captureFailed = error => fail(error?.name === 'NotAllowedError' ? '请允许此网站使用麦克风，然后点重试。' : error?.name === 'NotFoundError' ? '未找到可用麦克风，请检查设备后重试。' : '无法启动语音输入，请检查麦克风后重试。');
    try {
      const prepared = this.prepared?.context.state !== 'closed' ? this.prepared : undefined;
      this.prepared = undefined; clearTimeout(prepared?.timer);
      const capture = prepared || this.createCapture(); session.context = capture.context;
      const resumed = session.context.resume();
      resumed.catch(captureFailed);
      const acquired = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(stream => {
        if (session.closed) stream.getTracks().forEach(track => track.stop());
        else { session.stream = stream; session.mark('microphoneMs'); }
      });
      acquired.catch(captureFailed);
      const module = capture.module.then(() => session.mark('workletMs'));
      const captureReady = Promise.all([acquired, module]); captureReady.catch(captureFailed);
      session.timer = setTimeout(() => fail('语音连接超时，请重试。'), 25000);
      session.pump = setInterval(() => this.pump(session), 20);
      this.connect(session);
      await captureReady;
      if (session.closed) return;
      session.node = new AudioWorkletNode(session.context, 'zigent-pcm');
      session.node.port.onmessage = event => {
        if (session.closed) return;
        if (event.data.flushed) { session.flushed?.(); return; }
        const pcm = event.data.pcm;
        if (!pcm || session.ending) return;
        if (session.timings.firstAudioMs === undefined) {
          session.mark('firstAudioMs');
          window.ZigentTelemetry?.record('web.speech_capture', performance.now() - session.started);
        }
        session.queue.push({ sequence: ++session.sequence, pcm }); session.bytes += pcm.byteLength;
        if (session.bytes > 16000 * 2 * 30) { fail('网络持续不可用，录音缓存已满，已有文字已保留，请联网后重新开启。'); return; }
        this.pump(session);
      };
      session.source = session.context.createMediaStreamSource(session.stream);
      session.source.connect(session.node); session.node.connect(session.context.destination);
      // Connect the capture graph before waiting for resume; never wait for the network.
      await resumed;
      if (session.closed) return;
      session.capturing = true; session.mark('captureMs');
      session.context.onstatechange = () => this.captureStatus(session);
      for (const track of session.stream.getTracks()) {
        track.onended = () => fail('麦克风已断开，已有文字已保留，请重新开启语音输入。');
        track.onmute = track.onunmute = () => this.captureStatus(session);
      }
      this.captureStatus(session); this.status(session);
    } catch (error) { captureFailed(error); }
  }
  status(session) {
    if (session.closed) return;
    if (session.ready && session.capturing && !session.finishing) { clearTimeout(session.timer); session.mark('listeningMs'); }
    this.setState(session.finishing ? 'finishing' : session.paused ? 'paused' : !session.capturing ? 'starting' : !session.ready ? 'reconnecting' : 'listening');
  }
  connect(session) {
    if (session.closed || session.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(session.socket.readyState)) return;
    clearTimeout(session.reconnect);
    const connectStarted = performance.now();
    const warm = this.warmTransport;
    this.warmTransport = undefined; clearTimeout(warm?.timer);
    const warmed = Boolean(warm && [WebSocket.OPEN, WebSocket.CONNECTING].includes(warm.socket.readyState));
    if (warm && !warmed) { warm.socket.onopen = warm.socket.onmessage = warm.socket.onerror = warm.socket.onclose = null; warm.socket.close(); }
    let socket;
    try { socket = warmed ? warm.socket : new WebSocket(this.speechUrl(), 'zigent-speech-v2'); }
    catch { this.retry(session); return; }
    session.socket = socket; session.ready = false;
    let resumeSentAt;
    socket.onopen = () => {
      session.mark('gatewayMs');
      session.sent = session.acknowledged; session.finishSent = false;
      resumeSentAt = performance.now();
      socket.send(JSON.stringify({ type: 'resume', session: session.id, after: session.acknowledged }));
      window.ZigentTelemetry?.record('web.speech_socket', performance.now() - connectStarted, warmed ? 'warm' : 'cold');
      // WebSocket preserves ordering: audio follows resume without waiting for ready.
      this.pump(session);
    };
    socket.onmessage = event => {
      if (session.closed || session.socket !== socket) return;
      let data;
      try {
        data = JSON.parse(event.data);
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
      }
      catch { this.end('识别结果异常，已有文字已保留，请重新开启。'); return; }
      if (data.type === 'ready' || data.type === 'ack') {
        const sequence = data.sequence;
        if (!Number.isInteger(sequence) || sequence < session.acknowledged || sequence > session.sequence) {
          this.end('语音会话无法恢复，已有文字已保留，请重新开启。'); return;
        }
        session.acknowledged = sequence;
        const first = session.queue[0];
        if (data.type === 'ack' && (session.lastAckReport === undefined || performance.now() - session.lastAckReport >= 5000) && first?.sentAt !== undefined && sequence >= first.sequence) {
          session.lastAckReport = performance.now();
          window.ZigentTelemetry?.record('web.speech_audio_ack', performance.now() - first.sentAt);
        }
        while (session.queue[0]?.sequence <= sequence) session.bytes -= session.queue.shift().pcm.byteLength;
        if (data.type === 'ready') {
          window.ZigentTelemetry?.record('web.speech_connect', performance.now() - connectStarted);
          if (resumeSentAt !== undefined) window.ZigentTelemetry?.record('web.speech_resume', performance.now() - resumeSentAt);
          session.ready = true; session.sent = Math.max(session.sent, sequence);
          session.retryStarted = undefined; session.attempts = 0; clearTimeout(session.recoveryTimer);
          session.mark('sessionMs'); this.status(session);
        }
        this.pump(session);
      } else if (data.type === 'provider-ready') {
        if (session.timings.providerMs === undefined) window.ZigentTelemetry?.record('web.speech_provider', performance.now() - session.started);
        session.mark('providerMs');
        if (!session.upstreamRecorded && Number.isFinite(data.connectMs) && data.connectMs >= 0) {
          session.upstreamRecorded = true;
          window.ZigentTelemetry?.record('web.speech_upstream', data.connectMs, data.reused ? 'warm' : 'cold');
        }
      } else if (data.type === 'audio-forwarded') {
        if (Number.isFinite(data.queueMs) && data.queueMs >= 0) window.ZigentTelemetry?.record('web.speech_queue', data.queueMs);
      }
      else if (data.type === 'transcript' && typeof data.text === 'string') {
        if (data.text === session.lastText && session.pendingText === undefined) return;
        session.mark('firstTextMs');
        if (!session.firstTextRecorded && data.text && session.timings.firstAudioMs !== undefined) {
          session.firstTextRecorded = true;
          window.ZigentTelemetry?.record('web.speech_first_text', performance.now() - session.started - session.timings.firstAudioMs);
        }
        session.textReceived = performance.now();
        session.pendingText = data.text; this.renderText(session);
      } else if (data.type === 'done') {
        this.renderText(session);
        if (session.pendingText !== undefined) this.end('转录文字显示异常，请先确认输入内容。');
        else this.end('', true);
      }
      else if (data.type === 'error') {
        if (warmed && !session.ready) lost();
        else this.end(data.message || '识别失败，已有文字已保留，请重新开启。');
      }
    };
    const lost = () => {
      if (session.closed || session.socket !== socket) return;
      const wasReady = session.ready;
      session.socket = undefined; session.ready = false;
      socket.onmessage = null; socket.onerror = null; socket.onclose = null; socket.close();
      this.status(session);
      if (warmed && !wasReady && !session.warmFallback) { session.warmFallback = true; this.connect(session); }
      else this.retry(session);
    };
    socket.onerror = socket.onclose = lost;
    if (socket.readyState === WebSocket.OPEN) socket.onopen();
  }
  retry(session) {
    if (session.closed) return;
    if (session.retryStarted === undefined) {
      session.retryStarted = performance.now();
      session.recoveryTimer = setTimeout(() => {
        if (!session.closed && session.retryStarted !== undefined) this.end('网络持续不可用，已有文字已保留，请联网后重新开启。');
      }, 20000);
    }
    clearTimeout(session.reconnect);
    session.timings.reconnects = (session.timings.reconnects || 0) + 1;
    session.reconnect = setTimeout(() => this.connect(session), Math.min(4000, 250 * 2 ** Math.min(session.attempts || 0, 4)));
    session.attempts = (session.attempts || 0) + 1;
  }
  pump(session) {
    if (session.pendingText !== undefined && performance.now() - session.lastRender >= 250) this.renderText(session);
    const socket = session.socket;
    if (session.closed || socket?.readyState !== WebSocket.OPEN) return;
    for (const frame of session.queue) {
      if (frame.sequence <= session.sent) continue;
      if (socket.bufferedAmount >= 16000) break;
      const packet = new ArrayBuffer(4 + frame.pcm.byteLength);
      new DataView(packet).setUint32(0, frame.sequence);
      new Uint8Array(packet, 4).set(new Uint8Array(frame.pcm));
      try { socket.send(packet); frame.sentAt = performance.now(); session.sent = frame.sequence; }
      catch { socket.close(); break; }
    }
    if (session.ending && session.sent === session.sequence && !session.finishSent) {
      try { socket.send(JSON.stringify({ type: 'finish' })); session.finishSent = true; }
      catch { socket.close(); }
    }
  }
  renderText(session) {
    if (session.pendingText === undefined || session.closed) return;
    session.lastRender = performance.now();
    // Retry the latest snapshot without tearing down a healthy recording.
    try {
      this.onText(session.pendingText); session.lastText = session.pendingText; session.pendingText = undefined;
      window.ZigentTelemetry?.record('web.speech_render', performance.now() - session.textReceived);
    }
    catch { session.timings.displayErrors = (session.timings.displayErrors || 0) + 1; }
  }
  captureStatus(session) {
    if (session.closed || session.finishing || !session.capturing) return;
    const paused = session.context.state !== 'running' || session.stream.getAudioTracks().some(track => track.muted);
    if (paused && !session.paused) {
      session.paused = true; session.mark('firstPauseMs');
      session.pauseTimer = setTimeout(() => {
        if (!session.closed && session.paused) this.end('麦克风持续暂停，已有文字已保留，请重新开启语音输入。');
      }, 15000);
    } else if (!paused) { session.paused = false; clearTimeout(session.pauseTimer); }
    this.status(session);
  }
  async resumeCapture() {
    const session = this.session;
    if (!session || session.closed || session.finishing) return;
    if (session.context?.state !== 'running') {
      try { await session.context.resume(); } catch { /* Keep the bounded pause window for another user gesture. */ }
    }
    if (!session.closed) this.captureStatus(session);
    if (!session.closed && !session.socket) this.connect(session);
  }
  networkChanged() {
    if (navigator.onLine === false) this.discardTransport();
    const session = this.session;
    if (session && !session.socket) this.connect(session);
  }
  async finish() {
    const session = this.session;
    if (!session) return;
    if (session.ending || session.finishing) return session.completed;
    if (!session.capturing) { this.end('', true); return session.completed; }
    session.finishing = true; session.finishStarted = performance.now();
    this.setState('finishing'); clearTimeout(session.timer); clearTimeout(session.pauseTimer);
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 250);
      session.flushed = () => { clearTimeout(timer); resolve(); };
      session.node.port.postMessage('flush');
    });
    if (session.closed) return session.completed;
    session.ending = true; this.releaseCapture(session);
    this.pump(session);
    session.timer = setTimeout(() => this.end('最终转录超时，已有文字已保留，请确认后发送。'), 40000);
    return session.completed;
  }
  releaseCapture(session) {
    session.source?.disconnect(); session.node?.disconnect();
    session.stream?.getTracks().forEach(track => { track.onended = null; track.onmute = null; track.onunmute = null; track.stop(); });
    if (session.context) { session.context.onstatechange = null; void session.context.close().catch(() => {}); }
  }
  end(message = '', completed = false) {
    this.discardPrepared();
    const session = this.session;
    if (!session) return;
    session.closed = true;
    for (const timer of [session.timer, session.reconnect, session.recoveryTimer, session.pauseTimer]) clearTimeout(timer);
    clearInterval(session.pump); this.releaseCapture(session);
    session.timings.stopReason = message ? 'error' : completed ? 'finished' : 'cancelled';
    if (session.finishStarted !== undefined) {
      const ms = performance.now() - session.finishStarted;
      window.ZigentTelemetry?.record('web.speech_finish', ms, '', message ? 'error' : completed ? 'ok' : 'cancelled');
      if (completed) session.timings.finishMs = Math.round(ms);
    }
    session.queue = []; session.bytes = 0;
    if (session.socket) {
      session.socket.onmessage = null; session.socket.onerror = null; session.socket.onclose = null;
      if (!completed && session.socket.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify({ type: 'cancel' }));
      session.socket.close();
    }
    this.session = undefined; this.setState(message ? 'error' : 'idle', message);
    session.resolve(completed && !message);
  }
};
