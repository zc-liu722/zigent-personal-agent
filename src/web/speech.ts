import { randomUUID } from "node:crypto";
import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { attachResumableSpeech } from "./speech-stream.js";
import { SPEECH_ENDPOINT, SPEECH_PATH, parseSpeechFrame, speechFrame, speechRequest, type WebSpeechOptions } from "./speech-protocol.js";

export { SPEECH_PATH } from "./speech-protocol.js";
export type { SpeechSocketFactory, WebSpeechOptions } from "./speech-protocol.js";

const MAX_AUDIO_BYTES = 16000 * 2 * 120;
export function attachWebSpeech(server: Server, options: WebSpeechOptions): { close(): void } {
  const stream = attachResumableSpeech(server, options);
  const legacy = attachLegacySpeech(server, options);
  return { close() { stream.close(); legacy.close(); } };
}
// Keep already-open pages compatible until they refresh to the resumable client.
function attachLegacySpeech(server: Server, options: WebSpeechOptions): { close(): void } {
  const gateway = new WebSocketServer({ noServer: true, maxPayload: 12800, perMessageDeflate: false });
  const sessions = new Map<WebSocket, { device: string; close(): void }>();
  const reject = (socket: Duplex, status: number) => { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (request.headers["sec-websocket-protocol"]?.split(",").some(value => ["zigent-speech-v2", "zigent-browser-v1"].includes(value.trim()))) return;
    if (request.url !== (options.path ?? SPEECH_PATH) || request.method !== "GET") { reject(socket, 404); return; }
    if (request.headers.origin !== options.origin || !options.authenticate(request)) { reject(socket, 403); return; }
    if (!options.config) { reject(socket, 503); return; }
    const device = options.device(request);
    if (sessions.size >= 4 || [...sessions.values()].some(session => session.device === device)) { reject(socket, 429); return; }
    gateway.handleUpgrade(request, socket, head, client => start(client, request, device));
  };
  server.on("upgrade", upgrade);
  function start(client: WebSocket, request: IncomingMessage, device: string): void {
    let upstream: WebSocket | undefined, ready = false, ending = false, closed = false, audioBytes = 0;
    let lastAudio = Date.now(), alive = true;
    let finalTimer: ReturnType<typeof setTimeout> | undefined;
    let captureStartup: ReturnType<typeof setTimeout> | undefined;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const send = (event: object) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event)); };
    const close = () => {
      if (closed) return;
      closed = true; timers.forEach(clearTimeout); clearTimeout(finalTimer); clearInterval(heartbeat);
      sessions.delete(client);
      upstream?.terminate();
      if (client.readyState === WebSocket.OPEN) client.close();
      // Ensure a peer that never completes the closing handshake cannot block shutdown.
      const kill = setTimeout(() => client.terminate(), 1000); kill.unref();
    };
    const fail = (message: string) => { if (!closed) send({ type: "error", message }); close(); };
    const finish = () => {
      if (ending || closed) return;
      ending = true;
      if (!ready || !upstream) { fail("语音连接尚未就绪，请重试。"); return; }
      upstream.send(speechFrame(Buffer.alloc(0), true, true));
      finalTimer = setTimeout(() => fail("最终转录超时，已有文字已保留，请确认后发送。"), 15000);
    };
    const heartbeat = setInterval(() => {
      if (!options.authenticate(request)) { fail("登录已失效，已有文字已保留，请重新登录。"); return; }
      if (!alive) { close(); return; }
      alive = false; client.ping();
      if (audioBytes > 0 && !ending && Date.now() - lastAudio > 15000) fail("麦克风已暂停，已有文字已保留，请重试。");
    }, 10000);
    heartbeat.unref();
    sessions.set(client, { device, close });
    client.on("pong", () => { alive = true; });
    client.on("close", close); client.on("error", close);
    client.on("message", (raw, binary) => {
      if (closed) return;
      if (!options.authenticate(request)) { fail("登录已失效，请重新登录。"); return; }
      if (binary) {
        const bytes = Buffer.from(raw as Buffer);
        if (!ready || ending || !bytes.length || bytes.length % 2) { fail("录音数据无效，请重试。"); return; }
        if (audioBytes === 0) {
          clearTimeout(captureStartup);
          timers.push(setTimeout(() => fail("本次语音输入已到两分钟，已有文字已保留，请分段输入。"), 125000));
        }
        audioBytes += bytes.length; lastAudio = Date.now();
        if (audioBytes > MAX_AUDIO_BYTES || !upstream || upstream.bufferedAmount > 128000) { fail("录音过长或网络过慢，已有文字已保留，请分段输入。"); return; }
        upstream.send(speechFrame(bytes, true));
      } else {
        try {
          const event = JSON.parse(raw.toString());
          if (event.type === "finish") finish();
          else if (event.type === "cancel") close();
          else fail("语音操作无效，请重试。");
        } catch { fail("语音操作无效，请重试。"); }
      }
    });
    try {
      upstream = (options.connect ?? ((url, settings) => new WebSocket(url, settings)))(SPEECH_ENDPOINT, {
        headers: { "X-Api-Key": options.config!.apiKey, "X-Api-Resource-Id": "volc.seedasr.sauc.duration", "X-Api-Request-Id": randomUUID() },
        handshakeTimeout: 12000, maxPayload: 256000, perMessageDeflate: false
      });
      const startup = setTimeout(() => fail("语音识别连接超时，请重试。"), 15000); timers.push(startup);
      // Connection now overlaps the browser permission prompt. Allow its bounded
      // startup window, then count the recording limit from actual incoming audio.
      captureStartup = setTimeout(() => fail("麦克风启动超时，请重试。"), 30000); timers.push(captureStartup);
      upstream.on("open", () => {
        if (closed) return;
        upstream!.send(speechFrame(speechRequest("zigent-web")));
        ready = true; clearTimeout(startup); send({ type: "ready", maxSeconds: 120 });
      });
      upstream.on("message", raw => {
        if (closed) return;
        try {
          const result = parseSpeechFrame(Buffer.from(raw as Buffer));
          if (result.text) send({ type: "transcript", ...result });
          if (result.final) { send({ type: "done" }); close(); }
        } catch { fail("豆包语音识别未完成，已有文字已保留，请重试。"); }
      });
      upstream.on("error", () => fail("豆包语音连接失败，请稍后重试。"));
      upstream.on("close", () => { if (!closed) fail("语音连接已断开，已有文字已保留，请重试。"); });
    } catch { fail("豆包语音连接失败，请稍后重试。"); }
  }
  return { close() { server.off("upgrade", upgrade); for (const session of [...sessions.values()]) session.close(); gateway.close(); } };
}
