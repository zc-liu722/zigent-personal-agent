import { randomUUID } from "node:crypto";
import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { SPEECH_ENDPOINT, SPEECH_PATH, parseSpeechFrame, speechFrame, speechRequest, type WebSpeechOptions } from "./speech-protocol.js";
import { createSpeechPrewarmer, type PreparedSpeechProvider } from "./speech-prewarm.js";

const SEGMENT_BYTES = 16000 * 2 * 120;
const MAX_PENDING_BYTES = 16000 * 2 * 30;
const RESUME_MS = 30000;
type Session = { device: string; connected(): boolean; attach(client: WebSocket, request: IncomingMessage): void; close(): void };
type Provider = { socket: WebSocket; text: string; bytes: number; initialized: boolean; draining: boolean; lastAudio: number;
  connectMs?: number; reused: boolean;
  startup?: ReturnType<typeof setTimeout>; final?: ReturnType<typeof setTimeout> };

/** One recording survives browser transport loss; provider segments finish independently. */
export function attachResumableSpeech(server: Server, options: WebSpeechOptions): { close(): void } {
  const path = options.path ?? SPEECH_PATH;
  const gateway = new WebSocketServer({ noServer: true, maxPayload: 12804, perMessageDeflate: false });
  const sessions = new Map<string, Session>();
  const connectProvider = () => (options.connect ?? ((url, settings) => new WebSocket(url, settings)))(SPEECH_ENDPOINT, {
    headers: { "X-Api-Key": options.config!.apiKey, "X-Api-Resource-Id": "volc.seedasr.sauc.duration", "X-Api-Request-Id": randomUUID() },
    handshakeTimeout: 12000, maxPayload: 256000, perMessageDeflate: false
  });
  const prewarmer = createSpeechPrewarmer(connectProvider, device => ![...sessions.values()].some(value => value.device === device));
  const reject = (socket: Duplex, status: number) => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!request.headers["sec-websocket-protocol"]?.split(",").some(value => value.trim() === "zigent-speech-v2")) return;
    if (request.url !== path || request.method !== "GET") { reject(socket, 400); return; }
    if (!options.config) { reject(socket, 503); return; }
    if (request.headers.origin !== options.origin || !options.authenticate(request)) { reject(socket, 403); return; }
    if (gateway.clients.size >= 8) { reject(socket, 429); return; }
    gateway.handleUpgrade(request, socket, head, client => {
      const startup = setTimeout(() => client.terminate(), 5000);
      client.once("close", () => clearTimeout(startup)); client.on("error", () => { clearTimeout(startup); client.terminate(); });
      const stop = (message: string) => {
        client.send(JSON.stringify({ type: "error", message })); client.close();
        const kill = setTimeout(() => client.terminate(), 1000); kill.unref();
      };
      const resume = (raw: WebSocket.RawData, binary: boolean, prepared?: PreparedSpeechProvider) => {
        clearTimeout(startup);
        // Rejected/resumed sessions must not retain an unused supplier connection.
        let adopted = false;
        try {
          if (!options.authenticate(request)) { stop("登录已失效，请重新登录。"); return; }
          let event: { type?: string; session?: string; after?: number };
          try {
            if (binary) throw new Error();
            const value: unknown = JSON.parse(raw.toString());
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
            event = value;
          }
          catch { stop("语音操作无效，请重新开启。"); return; }
          const id = event.session ?? "";
          if (event.type !== "resume" || typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id) || !Number.isInteger(event.after) || event.after! < 0) { stop("语音操作无效，请重新开启。"); return; }
          const device = options.device(request), existing = sessions.get(id);
          if (existing) {
            if (existing.device !== device) { stop("语音会话无法恢复，请重新开启。"); return; }
            existing.attach(client, request); return;
          }
          // A restarted service cannot recover previously acknowledged audio from RAM.
          if (event.after !== 0) { stop("语音会话已过期或服务已更新，已有文字已保留，请重新开启。"); return; }
          const previous = [...sessions.values()].find(value => value.device === device);
          if (previous?.connected() || sessions.size >= 4 && !previous) { stop("已有语音输入正在进行，请结束后重试。"); return; }
          // A user may explicitly start again after cancelling while offline.
          previous?.close(); adopted = true; create(id, device, client, request, prepared);
        } finally { if (!adopted) prepared?.socket.terminate(); }
      };
      client.once("message", (raw, binary) => {
        let preparing = false;
        try { preparing = !binary && JSON.parse(raw.toString())?.type === "prepare"; } catch { /* Resume reports malformed commands. */ }
        if (preparing) {
          clearTimeout(startup);
          if (!options.authenticate(request)) { stop("登录已失效，请重新登录。"); return; }
          prewarmer.prepare(client, options.device(request), resume);
        } else resume(raw, binary);
      });
    });
  };
  server.on("upgrade", upgrade);

  function create(id: string, device: string, initial: WebSocket, initialRequest: IncomingMessage, prepared?: PreparedSpeechProvider): void {
    let client: WebSocket | undefined, request = initialRequest, provider: Provider | undefined;
    let closed = false, ending = false, alive = true, sequence = 0, prefix = "", snapshot = "";
    let pending: Array<{ bytes: Buffer; receivedAt: number }> = [], pendingBytes = 0, lastProgress = Date.now(), lastPump = -Infinity;
    let detached: ReturnType<typeof setTimeout> | undefined;
    let captureStartup: ReturnType<typeof setTimeout> | undefined;
    let sendTimer: ReturnType<typeof setTimeout> | undefined;
    let lastQueueReport = -Infinity;
    const providerReady = (value: Provider) => ({ type: "provider-ready", connectMs: value.connectMs, reused: value.reused });
    const send = (event: object) => { if (client?.readyState === WebSocket.OPEN) client.send(JSON.stringify(event)); };
    const disposeProvider = (value: Provider) => { clearTimeout(value.startup); clearTimeout(value.final); value.socket.terminate(); };
    const close = () => {
      if (closed) return;
      closed = true; clearTimeout(detached); clearTimeout(captureStartup); clearTimeout(sendTimer); clearInterval(heartbeat); clearInterval(pumpTimer);
      sessions.delete(id); pending = []; pendingBytes = 0;
      if (provider) { const value = provider; provider = undefined; disposeProvider(value); }
      prepared?.socket.terminate(); prepared = undefined;
      if (client) { const peer = client; client = undefined; peer.close(); const kill = setTimeout(() => peer.terminate(), 1000); kill.unref(); }
    };
    const fail = (message: string) => { send({ type: "error", message }); close(); };
    const publish = (text: string) => {
      if (prefix + text === snapshot) return;
      snapshot = prefix + text;
      if (snapshot.length > 16000) { fail("转录已达到输入长度上限，已有文字已保留，请先发送。"); return; }
      send({ type: "transcript", text: snapshot });
    };
    const complete = () => { if (!closed && ending && !pending.length && !provider) { send({ type: "done" }); close(); } };
    const drain = (value: Provider) => {
      if (value.draining || !value.initialized || value.socket.readyState !== WebSocket.OPEN) return;
      value.draining = true;
      value.socket.send(speechFrame(Buffer.alloc(0), true, true));
      value.final = setTimeout(() => fail("最终转录超时，已有文字已保留，请重新开启。"), 15000);
    };
    const openProvider = () => {
      if (closed || provider) return;
      try {
        const warmed = prepared; prepared = undefined;
        const started = warmed?.started ?? performance.now(), socket = warmed?.socket ?? connectProvider();
        const value: Provider = { socket, text: "", bytes: 0, initialized: false, draining: false, lastAudio: Date.now(), reused: Boolean(warmed) };
        provider = value;
        value.startup = setTimeout(() => fail("语音识别连接超时，已有文字已保留，请重新开启。"), 15000);
        const opened = () => {
          if (closed || provider !== value) return;
          value.connectMs = (warmed?.connected ?? performance.now()) - started;
          clearTimeout(value.startup); send(providerReady(value)); pump();
        };
        socket.on("open", opened);
        socket.on("message", raw => {
          if (closed || provider !== value) return;
          try {
            const result = parseSpeechFrame(Buffer.from(raw as Buffer));
            if (result.text) { value.text = result.text; publish(value.text); }
            if (closed) return;
            if (result.final) {
              prefix += value.text; provider = undefined; disposeProvider(value);
              lastProgress = Date.now(); pump(); complete();
            }
          } catch { fail("豆包语音识别未完成，已有文字已保留，请重新开启。"); }
        });
        const lost = () => {
          if (closed || provider !== value) return;
          if (!value.initialized) {
            provider = undefined; disposeProvider(value);
            if (pending.length) {
              if (value.reused) pump(); // No request/audio reached this expired preparation; safely dial fresh.
              else fail("豆包语音连接失败，请重新开启。");
            }
          }
          else fail("语音识别服务连接中断，已有文字已保留，请重新开启。");
        };
        socket.on("error", lost); socket.on("close", lost);
        if (socket.readyState === WebSocket.OPEN) opened();
      } catch { fail("豆包语音连接失败，请重新开启。"); }
    };
    function pump(): void {
      if (closed) return;
      const now = performance.now();
      if (pending.length && !provider) openProvider();
      const value = provider;
      if (!value) { complete(); return; }
      if (value.socket.readyState !== WebSocket.OPEN || value.draining) return;
      // Catch up at at most 2x: 200 ms audio per 100 ms send, within the
      // supplier's recommended 100–200 ms packet size and interval.
      if (pending.length && value.socket.bufferedAmount < 64000) {
        const remaining = 100 - (now - lastPump);
        if (value.initialized && remaining > 0) {
          // Send at the deadline instead of quantizing to the maintenance poll,
          // which could turn a 100 ms cadence into 150 ms.
          sendTimer ??= setTimeout(() => { sendTimer = undefined; pump(); }, remaining);
          return;
        }
        if (!value.initialized) { value.socket.send(speechFrame(speechRequest("zigent-web"))); value.initialized = true; }
        const first = pending[0]!;
        let bytes = first.bytes;
        if (value.bytes + bytes.length > SEGMENT_BYTES) { drain(value); return; }
        pending.shift(); pendingBytes -= bytes.length;
        if (pending[0] && bytes.length + pending[0].bytes.length <= 6400 && value.bytes + bytes.length + pending[0].bytes.length <= SEGMENT_BYTES) {
          const next = pending.shift()!.bytes; pendingBytes -= next.length; bytes = Buffer.concat([bytes, next]);
        }
        value.socket.send(speechFrame(bytes, true)); value.bytes += bytes.length;
        if (now - lastQueueReport >= 5000) { send({ type: "audio-forwarded", queueMs: performance.now() - first.receivedAt }); lastQueueReport = now; }
        lastPump = now;
        if (pending.length) sendTimer ??= setTimeout(() => { sendTimer = undefined; pump(); }, 100);
        lastProgress = value.lastAudio = Date.now();
      }
      if (value.bytes >= SEGMENT_BYTES || ending && !pending.length || value.initialized && !pending.length && Date.now() - value.lastAudio >= 5000) drain(value);
      if (ending && !value.initialized && !pending.length) { provider = undefined; disposeProvider(value); complete(); }
    }
    const heartbeat = setInterval(() => {
      if (!options.authenticate(request)) { fail("登录已失效，已有文字已保留，请重新登录。"); return; }
      if (client) {
        if (!alive) { const peer = client; client = undefined; peer.terminate(); expire(); }
        else { alive = false; client.ping(); }
      }
    }, 10000); heartbeat.unref();
    const pumpTimer = setInterval(() => {
      pump();
      if (pending.length && Date.now() - lastProgress > 25000) fail("网络持续不可用，已有文字已保留，请联网后重新开启。");
    }, 250); pumpTimer.unref();
    const expire = () => { clearTimeout(detached); detached = setTimeout(close, RESUME_MS); };
    const session: Session = { device, close, connected: () => client?.readyState === WebSocket.OPEN, attach(peer, nextRequest) {
      if (closed) { peer.close(); return; }
      clearTimeout(detached); const previous = client; client = peer; request = nextRequest; alive = true;
      previous?.terminate();
      peer.on("pong", () => { if (client === peer) alive = true; });
      const lost = () => { if (client !== peer || closed) return; client = undefined; expire(); };
      peer.on("close", lost); peer.on("error", lost);
      peer.on("message", (raw, binary) => {
        if (closed || client !== peer) return;
        if (!options.authenticate(request)) { fail("登录已失效，已有文字已保留，请重新登录。"); return; }
        if (binary) {
          const packet = Buffer.from(raw as Buffer);
          if (packet.length <= 4 || packet.length % 2) { fail("录音数据无效，请重新开启。"); return; }
          const next = packet.readUInt32BE(0);
          if (next <= sequence) { send({ type: "ack", sequence }); return; }
          if (ending) { fail("录音已经结束，请重新开启。"); return; }
          if (next !== sequence + 1) { fail("录音片段不连续，已有文字已保留，请重新开启。"); return; }
          const bytes = packet.subarray(4);
          if (pendingBytes + bytes.length > MAX_PENDING_BYTES) { fail("网络持续过慢，已有文字已保留，请联网后重新开启。"); return; }
          if (!sequence) clearTimeout(captureStartup);
          if (!pending.length) lastProgress = Date.now();
          sequence = next; pending.push({ bytes, receivedAt: performance.now() }); pendingBytes += bytes.length;
          // Receipt ACK is retained with this server session through transport loss.
          send({ type: "ack", sequence }); pump();
        } else {
          try {
            const event = JSON.parse(raw.toString());
            if (event.type === "finish") { ending = true; clearTimeout(captureStartup); pump(); }
            else if (event.type === "cancel") close();
            else fail("语音操作无效，请重新开启。");
          } catch { fail("语音操作无效，请重新开启。"); }
        }
      });
      send({ type: "ready", sequence });
      if (provider?.socket.readyState === WebSocket.OPEN) send(providerReady(provider));
      if (snapshot) send({ type: "transcript", text: snapshot });
    } };
    sessions.set(id, session);
    captureStartup = setTimeout(() => fail("麦克风启动超时，请重新开启。"), 30000);
    session.attach(initial, initialRequest); openProvider();
  }
  return { close() { server.off("upgrade", upgrade); prewarmer.close(); for (const session of [...sessions.values()]) session.close(); gateway.close(); } };
}
