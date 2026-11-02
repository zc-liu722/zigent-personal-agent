import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import type { WebBrowser } from "./browser.js";

const PROTOCOL = "zigent-browser-v1";
const MAX_BUFFERED_BYTES = 768 * 1024;

type StreamOptions = {
  browser: WebBrowser;
  path: string;
  origin: string;
  authenticate: (request: IncomingMessage) => boolean;
  device: (request: IncomingMessage) => string;
};

/** Authenticated, low-overhead frame delivery. JPEG pixels never enter logs or SSE history. */
export function attachBrowserStream(server: Server, options: StreamOptions): { close(): void } {
  const gateway = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const sessions = new Map<WebSocket, () => void>();
  const reject = (socket: Duplex, status: number) => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (request.url?.split("?")[0] !== options.path) return;
    if (request.method !== "GET" || request.headers.origin !== options.origin || !options.authenticate(request)) { reject(socket, 403); return; }
    if (!request.headers["sec-websocket-protocol"]?.split(",").some(value => value.trim() === PROTOCOL)) { reject(socket, 400); return; }
    if (gateway.clients.size >= 6) { reject(socket, 429); return; }
    gateway.handleUpgrade(request, socket, head, client => start(client, request));
  };
  server.on("upgrade", upgrade);

  function start(client: WebSocket, request: IncomingMessage): void {
    let closed = false, visible = true, activeInput = false, alive = true, pumping = false;
    let timer: NodeJS.Timeout | undefined, previous: Buffer | undefined, lastError = "";
    const url = new URL(request.url ?? "/", "http://localhost");
    const conversationId = url.searchParams.get("conversationId") ?? "", id = url.searchParams.get("id") ?? "";
    let scope: ReturnType<WebBrowser["scope"]>;
    try { scope = options.browser.scope(conversationId); options.browser.service.summary(scope, id); }
    catch { client.close(1008, "浏览器不可用"); return; }
    const send = (value: object | Buffer): boolean => {
      if (closed || client.readyState !== WebSocket.OPEN || client.bufferedAmount > MAX_BUFFERED_BYTES) return false;
      client.send(Buffer.isBuffer(value) ? value : JSON.stringify(value)); return true;
    };
    const schedule = (delay: number) => {
      if (closed) return;
      clearTimeout(timer);
      timer = setTimeout(() => { void pump(); }, delay);
      timer.unref();
    };
    const pump = async (): Promise<void> => {
      if (closed || pumping) return;
      if (!visible || documentFullyBuffered(client)) { schedule(visible ? 160 : 750); return; }
      pumping = true;
      const started = Date.now();
      try {
        if (!options.authenticate(request)) { close(1008, "登录已失效"); return; }
        const state = options.browser.service.summary(scope, id);
        if (state.running) {
          const frame = await options.browser.service.screenshot(scope, id);
          if (closed) return;
          // Static pages do not consume downstream bandwidth. Capture still continues
          // at a bounded rate so DOM-only changes and animations are picked up.
          if ((!previous || !previous.equals(frame)) && send(frame)) previous = frame;
          lastError = "";
        }
        schedule(Math.max(activeInput ? 70 : 140, Date.now() - started));
      } catch {
        if (closed) return;
        if (!lastError) { send({ type: "status", state: "reconnecting" }); lastError = "unavailable"; }
        schedule(900);
      } finally { pumping = false; }
    };
    const heartbeat = setInterval(() => {
      if (closed) return;
      if (!options.authenticate(request)) { close(1008, "登录已失效"); return; }
      if (!alive) { close(1001, "连接超时"); return; }
      alive = false;
      if (client.readyState === WebSocket.OPEN) client.ping();
    }, 15000);
    heartbeat.unref();
    const close = (code = 1000, reason = "") => {
      if (closed) return;
      closed = true; clearTimeout(timer); clearInterval(heartbeat); sessions.delete(client);
      if (client.readyState === WebSocket.OPEN) client.close(code, reason);
      else client.terminate();
    };
    sessions.set(client, () => close());
    client.on("pong", () => { alive = true; });
    client.on("close", () => close()); client.on("error", () => close());
    client.on("message", (raw, binary) => {
      if (binary || closed) return;
      try {
        const event = JSON.parse(raw.toString()) as { type?: string; visible?: boolean; active?: boolean };
        if (event.type === "visibility" && typeof event.visible === "boolean") {
          visible = event.visible;
          if (visible) schedule(0);
        } else if (event.type === "input" && typeof event.active === "boolean") {
          activeInput = event.active;
          if (activeInput) schedule(0);
        }
      } catch { /* Small malformed control messages do not affect the browser. */ }
    });
    send({ type: "ready", protocol: 1 });
    schedule(0);
  }

  return { close() {
    server.off("upgrade", upgrade);
    for (const close of [...sessions.values()]) close();
    gateway.close();
  } };
}

function documentFullyBuffered(client: WebSocket): boolean {
  return client.readyState !== WebSocket.OPEN || client.bufferedAmount > MAX_BUFFERED_BYTES;
}
