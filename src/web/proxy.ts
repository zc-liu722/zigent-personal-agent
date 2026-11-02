import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { SPEECH_PATH } from "./speech.js";

/** Forward only authenticated speech and browser upgrades to the fixed web service. */
export function proxyWebUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, port: number, speechPath = SPEECH_PATH): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const speech = url.pathname === speechPath && !url.search;
  const browser = url.pathname === speechPath.replace(/api\/speech$/, "api/browser/stream");
  if (!speech && !browser || req.method !== "GET") { socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return; }
  req.socket.setNoDelay(true);
  const headers = { ...req.headers }; delete headers.authorization; delete headers["proxy-authorization"];
  const request = httpRequest({ hostname: "127.0.0.1", port, method: "GET", path: req.url, headers });
  request.on("socket", connection => connection.setNoDelay(true));
  request.on("upgrade", (reply, upstream, pending) => {
    if (socket.destroyed) { upstream.destroy(); return; }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(reply.headers).map(([key, value]) => `${key}: ${value}\r\n`).join("")}\r\n`);
    if (pending.length) socket.write(pending);
    if (head.length) upstream.write(head);
    upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy());
    upstream.on("close", () => socket.destroy()); socket.on("close", () => upstream.destroy());
    upstream.pipe(socket); socket.pipe(upstream);
    upstream.setTimeout(35000, () => upstream.destroy());
  });
  request.on("response", reply => { socket.end(`HTTP/1.1 ${reply.statusCode ?? 502} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); reply.resume(); });
  request.on("error", () => socket.destroy()); socket.on("error", () => request.destroy());
  socket.on("close", () => request.destroy());
  request.setTimeout(15000, () => request.destroy()); request.end();
}

/** Fixed loopback upstream; never use a URL or port supplied by the caller. */
export function proxyWebRequest(req: IncomingMessage, res: ServerResponse, port: number): void {
  const headers = { ...req.headers };
  // Only device-event endpoints (including the old URL) accept the independent source credential.
  if (!/^\/[a-z][a-z0-9-]{0,63}\/api\/(external-events|task-events)$/.test(new URL(req.url ?? "/", "http://localhost").pathname)) delete headers.authorization;
  delete headers["proxy-authorization"];
  delete headers.connection;
  const upstream = httpRequest({ hostname: "127.0.0.1", port, method: req.method, path: req.url, headers }, reply => {
    res.writeHead(reply.statusCode ?? 502, reply.headers);
    reply.pipe(res);
    reply.on("error", () => res.destroy());
  });
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end('{"error":"聊天服务正在更新，请稍后重试。"}');
  });
  upstream.setTimeout(35_000, () => upstream.destroy());
  req.on("aborted", () => upstream.destroy());
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}
