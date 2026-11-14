import { parentPort, workerData } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { MeetingAudioInput } from './audio-input.js';
import type { MeetingTransportFailure, MeetingTransportStats } from './transport.js';

const port = parentPort!;
const socket = new WebSocket('wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue', {
  headers: { 'X-Api-Key': workerData.apiKey }, maxPayload: 2 * 1024 * 1024,
  handshakeTimeout: 15000, perMessageDeflate: false
});
let input: MeetingAudioInput | undefined;
let closing = false, downlinkBytes = 0;
let closeTimer: NodeJS.Timeout | undefined;
const stats: MeetingTransportStats = {};
const snapshot = () => ({ ...stats, input: input?.stats });
const send = (event: object) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ ...event, event_id: randomUUID() }), error => {
    if (error) fail('socket');
    else input?.drain();
  });
};
function close() {
  if (closing) return;
  closing = true; input?.close(); clearInterval(reportTimer);
  // Wait for session.closed before the WebSocket close handshake.
  closeTimer = setTimeout(() => socket.terminate(), 2000);
  if (socket.readyState === WebSocket.OPEN) send({ type: 'session.close' });
  else socket.terminate();
}
function fail(reason: MeetingTransportFailure) {
  if (closing) return;
  stats.failure = reason; port.postMessage({ type: 'failure', reason, stats: snapshot() }); close();
}
const reportTimer = setInterval(() => port.postMessage({ type: 'stats', stats: snapshot() }), 1000);
socket.on('upgrade', response => {
  const id = response.headers['x-tt-logid'];
  if (typeof id === 'string' && /^[\w-]{1,128}$/.test(id)) stats.logId = id;
});
socket.on('open', () => { if (closing) socket.close(); else port.postMessage({ type: 'open' }); });
socket.on('message', raw => {
  try {
    const event = JSON.parse(raw.toString());
    if (closing) { if (event.type === 'session.closed') socket.close(); return; }
    if (typeof event.type !== 'string') { fail('protocol'); return; }
    if (event.type === 'session.created') {
      input?.close(); input = new MeetingAudioInput(send, () => socket.bufferedAmount, fail);
    }
    if (event.type === 'error') {
      const code = String(event.error?.code ?? event.code ?? event.status_code ?? '');
      if (/^[\w.-]{1,80}$/.test(code)) stats.providerCode = code;
    }
    const bytes = Buffer.byteLength(raw.toString());
    if (downlinkBytes + bytes > 2 * 1024 * 1024) { fail('output_handoff'); return; }
    downlinkBytes += bytes;
    port.postMessage({ type: 'event', event, bytes, ...(event.type === 'error' ? { stats: snapshot() } : {}) });
  } catch { fail('protocol'); }
});
socket.on('error', () => fail(socket.readyState === WebSocket.CONNECTING ? 'connect' : 'socket'));
socket.on('close', code => {
  stats.closeCode = code;
  if (!closing) fail('closed');
  clearTimeout(closeTimer); clearInterval(reportTimer); input?.close();
  port.postMessage({ type: 'closed', stats: snapshot() }); port.close();
});
port.on('message', message => {
  if (message.type === 'close') { close(); return; }
  if (closing) return;
  if (message.type === 'send') send(message.event);
  if (message.type === 'mute') input?.mute(message.muted);
  if (message.type === 'received') downlinkBytes = Math.max(0, downlinkBytes - message.bytes);
  if (message.type === 'audio') {
    stats.maxHandoffMs = Math.max(stats.maxHandoffMs ?? 0, Math.round(performance.now() - message.at));
    input?.enqueue(Buffer.from(message.frame), message.at);
    port.postMessage({ type: 'accepted' });
  }
});
