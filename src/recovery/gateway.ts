import { createServer, request as requestHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { cookie, deviceCookie, recoveryCookie, RecoveryAuth } from "./auth.js";
import { RecoveryError, RecoveryService, type RecoveryConfig } from "./service.js";

const json = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new RecoveryError(400, "请求格式不正确。");
  const parts: Buffer[] = []; let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 4096) throw new RecoveryError(413, "请求内容过大。");
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new RecoveryError(400, "请求格式不正确。"); }
}
function sameOrigin(req: IncomingMessage, config: RecoveryConfig, required: boolean): boolean {
  return (!required && !req.headers.origin || req.headers.origin === config.publicOrigin)
    && (!req.headers["sec-fetch-site"] || req.headers["sec-fetch-site"] === "same-origin" || !required && req.headers["sec-fetch-site"] === "none");
}
export async function startRecoveryGateway(config: RecoveryConfig, options: {
  service?: RecoveryService; assetsDirectory?: string; port?: number;
} = {}) {
  const service = options.service ?? await RecoveryService.open(config);
  const auth = new RecoveryAuth(config.webDatabasePath, service.db);
  const assets = options.assetsDirectory ?? join(config.root, "shared", "recovery", "control", "web");
  const staticFiles = new Map<string, { data: Buffer; contentType: string }>();
  for (const [name, contentType] of [["recovery.html", "text/html; charset=utf-8"], ["recovery.js", "text/javascript; charset=utf-8"], ["recovery.css", "text/css; charset=utf-8"]])
    staticFiles.set(`${config.basePath}${name}`, { data: await readFile(join(assets, name!)), contentType: contentType! });
  const fallback = (res: ServerResponse) => {
    const page = staticFiles.get(`${config.basePath}recovery.html`)!;
    res.writeHead(200, { "Content-Type": page.contentType, "Cache-Control": "no-store" }); res.end(page.data);
  };
  const server = createServer((req, res) => {
    void handle(req, res).catch(error => {
      if (res.headersSent) { res.destroy(); return; }
      json(res, error instanceof RecoveryError ? error.status : 503, { error: error instanceof RecoveryError ? error.message : "恢复服务暂时无法完成此操作。" });
    });
  });
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const file = req.method === "GET" ? staticFiles.get(path) : undefined;
    if (file) { res.writeHead(200, { "Content-Type": file.contentType, "Cache-Control": "no-store" }); res.end(file.data); return; }
    if (req.method === "GET" && path === "/_recovery/healthz") { json(res, 200, { status: "ok", component: "recovery" }); return; }
    if (path === `${config.basePath}api/recovery` || path === `${config.basePath}api/recovery/rollback`) {
      if (!sameOrigin(req, config, req.method !== "GET")) throw new RecoveryError(403, "请在网页内操作。");
      const identity = auth.authenticate(req.headers.cookie);
      if (!identity) throw new RecoveryError(401, "请先登录。");
      if (req.method === "GET" && path.endsWith("/recovery")) { json(res, 200, await service.report(identity)); return; }
      if (req.method === "POST" && path.endsWith("/rollback")) { json(res, 202, await service.rollback(identity, await body(req))); return; }
      throw new RecoveryError(405, "此操作不支持该请求方式。");
    }
    if (req.method === "POST" && path === `${config.basePath}api/login`) {
      if (!sameOrigin(req, config, true)) throw new RecoveryError(403, "请在网页内操作。");
      const input = await body(req) as { password?: unknown };
      if (!input || typeof input !== "object" || Object.keys(input).some(key => key !== "password")) throw new RecoveryError(400, "请求格式不正确。");
      // Prefer the ordinary login while the core is healthy; preserve its normal device lifecycle.
      // The independent login is only needed when the backend cannot answer.
      try {
        const reply = await fetch(`http://127.0.0.1:${config.backendPort}${config.basePath}api/login`, {
          method: "POST", headers: { "Content-Type": "application/json", Origin: config.publicOrigin, "Sec-Fetch-Site": "same-origin", "CF-Connecting-IP": String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "local") },
          body: JSON.stringify(input), signal: AbortSignal.timeout(2500)
        });
        if (reply.status < 500) {
          const responseCookies = reply.headers.getSetCookie(); if (responseCookies.length) res.setHeader("Set-Cookie", responseCookies);
          res.writeHead(reply.status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(await reply.text()); return;
        }
      } catch { /* The independent password login stays available with the backend stopped. */ }
      let credential: string | undefined;
      try { credential = await auth.login(input.password, String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "local")); }
      catch { throw new RecoveryError(429, "尝试次数过多，请稍后再试。"); }
      if (!credential) throw new RecoveryError(401, "密码不正确。");
      res.setHeader("Set-Cookie", cookie(recoveryCookie, credential, config.basePath)); json(res, 200, { ok: true }); return;
    }
    if (req.method === "POST" && path === `${config.basePath}api/logout`) {
      if (!sameOrigin(req, config, true)) throw new RecoveryError(403, "请在网页内操作。");
      auth.logout(req.headers.cookie);
      // Revoke recovery access immediately even if the Agent process is down.
      res.setHeader("Set-Cookie", [cookie(recoveryCookie, "", config.basePath, true), cookie(deviceCookie, "", config.basePath, true)]);
      try { await fetch(`http://127.0.0.1:${config.backendPort}${config.basePath}api/logout`, { method: "POST", headers: { Origin: config.publicOrigin, Cookie: req.headers.cookie ?? "" }, signal: AbortSignal.timeout(2500) }); } catch { /* Local revocation remains effective. */ }
      json(res, 200, { ok: true }); return;
    }
    proxy(req, res, config.backendPort, req.method === "GET" && path === config.basePath ? fallback : undefined);
  }
  server.on("upgrade", (req, socket, head) => proxyUpgrade(req, socket, head, config));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? config.listenPort, config.listenHost, resolve); });
  return { port: (server.address() as { port: number }).port,
    async close(): Promise<void> { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await service.close(); } };
}
function proxy(req: IncomingMessage, res: ServerResponse, port: number, fallback?: (res: ServerResponse) => void): void {
  const headers = { ...req.headers }; delete headers["proxy-authorization"]; delete headers.connection;
  if (!/^\/deepmind\/api\/(external-events|task-events)(?:\?|$)/.test(req.url ?? "")) delete headers.authorization;
  const upstream = requestHttp({ hostname: "127.0.0.1", port, method: req.method, path: req.url, headers }, response => {
    res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); response.on("error", () => res.destroy());
  });
  upstream.on("error", () => {
    if (res.headersSent) { res.destroy(); return; }
    if (fallback) fallback(res); else json(res, 502, { error: "聊天服务暂时不可用，可打开服务回退。" });
  });
  upstream.setTimeout(35000, () => upstream.destroy()); req.on("aborted", () => upstream.destroy()); res.on("close", () => upstream.destroy()); req.pipe(upstream);
}
function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, config: RecoveryConfig): void {
  if (req.method !== "GET" || req.url !== `${config.basePath}api/speech` || !sameOrigin(req, config, true)) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return; }
  req.socket.setNoDelay(true);
  const headers = { ...req.headers }; delete headers.authorization; delete headers["proxy-authorization"];
  const upstream = requestHttp({ hostname: "127.0.0.1", port: config.backendPort, method: "GET", path: req.url, headers });
  upstream.on("socket", connection => connection.setNoDelay(true));
  upstream.on("upgrade", (response, connection, pending) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}\r\n`).join("")}\r\n`);
    if (head.length) connection.write(head); if (pending.length) socket.write(pending);
    connection.on("error", () => socket.destroy()); socket.on("error", () => connection.destroy());
    connection.on("close", () => socket.destroy()); socket.on("close", () => connection.destroy()); connection.pipe(socket); socket.pipe(connection);
  });
  upstream.on("response", response => { socket.end(`HTTP/1.1 ${response.statusCode ?? 502} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); response.resume(); });
  upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy()); socket.on("close", () => upstream.destroy()); upstream.setTimeout(15000, () => upstream.destroy()); upstream.end();
}
