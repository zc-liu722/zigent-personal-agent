import { createServer, request as httpRequest, Agent, type IncomingMessage, type ServerResponse, type OutgoingHttpHeaders } from "node:http";
import { connect, isIP, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { lookup } from "node:dns/promises";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";
import { publicAddress } from "./network.js";
import type { Page, CDPSession } from "playwright-core";
import type { BrowserNetwork } from "./types.js";

const FIRST_PORT = 49152, LAST_PORT = 65535, MAX_HEADER = 16384;
type Options = { network: BrowserNetwork; upstreamProxyUrl?: string; testLocal?: boolean; timeoutMs?: number };
export type BrowserGateway = { proxy: { server: string }; args: string[]; authenticate(page: Page): Promise<void>; restrict(origin: string, until?: number): void; allowManual(origin: string): void; close(): Promise<void> };
const failure = () => new Error("浏览器网络连接失败");
const restrictionKey = (origin: string): string => {
  const target = new URL(origin);
  if (!["http:", "https:", "ws:", "wss:"].includes(target.protocol) || target.username || target.password) throw failure();
  return `${target.hostname.replace(/^\[|\]$/g, "").toLowerCase()}:${target.port || (["https:", "wss:"].includes(target.protocol) ? 443 : 80)}`;
};
const authority = (host: string, port: number) => `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;

/** Only a literal, explicitly named loopback target is permitted by the local test switch. */
async function destination(host: string, testLocal: boolean): Promise<string> {
  const explicitLocal = ["127.0.0.1", "::1", "localhost"].includes(host);
  if (testLocal && explicitLocal) return host === "localhost" ? "127.0.0.1" : host;
  if (host.includes("%") || !isIP(host) && (!host.includes(".") || /(?:^|\.)(?:localhost|local|internal|home|lan)$/i.test(host))) throw failure();
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  // Reject translation/tunnelling forms as well as private addresses. They can encode private IPv4 destinations.
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address) ||
    isIP(address) === 6 && (!/^[23]/i.test(address) || /^(?:2001:(?:0*:|db8:)|2002:)/i.test(address)))) throw failure();
  return addresses[0].address;
}

function upstream(value: string | undefined): URL {
  try {
    const url = new URL(value ?? "");
    if (!["http:", "https:", "socks5:"].includes(url.protocol) || url.search || url.hash || url.pathname && url.pathname !== "/" ||
      url.protocol === "socks5:" && (url.username || url.password)) throw failure();
    decodeURIComponent(url.username); decodeURIComponent(url.password);
    return url;
  } catch { throw failure(); }
}

/** An exact bounded reader leaves following bytes on the socket for the next protocol stage. */
function reader(socket: Socket, milliseconds: number) {
  return (complete: (buffer: Buffer) => number | undefined): Promise<Buffer> => new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0);
    const timer = setTimeout(() => finish(failure()), milliseconds);
    const cleanup = () => { clearTimeout(timer); socket.off("data", data); socket.off("error", error); socket.off("end", error); socket.off("close", error); socket.pause(); };
    const finish = (error?: Error, result?: Buffer) => { cleanup(); if (error) { socket.destroy(); reject(error); } else resolve(result!); };
    const error = () => finish(failure());
    const data = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      let length: number | undefined;
      try { length = complete(pending); } catch { finish(failure()); return; }
      if (length === undefined) { if (pending.length > MAX_HEADER) finish(failure()); return; }
      if (length > MAX_HEADER) { finish(failure()); return; }
      const result = pending.subarray(0, length), rest = pending.subarray(length);
      cleanup(); if (rest.length) socket.unshift(rest); resolve(result);
    };
    socket.on("data", data); socket.once("error", error); socket.once("end", error); socket.once("close", error); socket.resume();
  });
}
function ipv6Bytes(value: string): Buffer {
  const [left, right] = value.split("::"), a = left ? left.split(":") : [], b = right ? right.split(":") : [];
  const words = right === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill("0"), ...b];
  if (words.length !== 8) throw failure();
  const result = Buffer.alloc(16); words.forEach((word, i) => result.writeUInt16BE(parseInt(word, 16), i * 2)); return result;
}
function headers(request: IncomingMessage, target: URL, upgrade = false): OutgoingHttpHeaders {
  const result = { ...request.headers };
  const nominated = String(result.connection ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const key of [...nominated, "proxy-authorization", "proxy-authenticate", "proxy-connection", "connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"])
    delete result[key];
  result.host = target.host;
  if (upgrade) { result.connection = "Upgrade"; result.upgrade = request.headers.upgrade; }
  else result.connection = "close";
  return result;
}
function targetUrl(raw: string | undefined): URL {
  try {
    const target = new URL(raw ?? "");
    if (!["http:", "ws:"].includes(target.protocol) || target.username || target.password || target.hash) throw failure();
    return target;
  } catch { throw failure(); }
}

/** Authenticated per-session egress. The browser keeps its own HTTP cache and end-to-end TLS. */
export async function startBrowserGateway(options: Options): Promise<BrowserGateway> {
  const timeout = options.timeoutMs ?? 15000;
  const proxy = options.network === "proxy" ? upstream(options.upstreamProxyUrl) : undefined;
  if (!["direct", "proxy"].includes(options.network) || !Number.isFinite(timeout) || timeout < 1) throw failure();
  const username = randomBytes(18).toString("hex"), password = randomBytes(32).toString("hex");
  const authorization = Buffer.from("Basic " + Buffer.from(`${username}:${password}`).toString("base64"));
  const restrictions = new Map<string, number>(), destinations = new Map<Socket, string>();
  const sockets = new Set<Duplex>(); const sessions = new Set<CDPSession>(); let closed = false, closing: Promise<void> | undefined;
  const track = <T extends Duplex>(socket: T): T => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => {}); return socket; };
  const authentic = (req: IncomingMessage) => {
    const received = Buffer.from(req.headers["proxy-authorization"] ?? "");
    return received.length === authorization.length && timingSafeEqual(received, authorization);
  };
  const bounded = async <T>(work: Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(failure()), timeout); })]); }
    finally { clearTimeout(timer); }
  };
  const dial = async (host: string, port: number, encrypted = false): Promise<Socket> => {
    if (closed) throw failure();
    const socket = track(encrypted ? tlsConnect({ host, port, servername: isIP(host) ? undefined : host }) : connect({ host, port }));
    try {
      await bounded(new Promise<void>((resolve, reject) => { socket.once(encrypted ? "secureConnect" : "connect", resolve); socket.once("error", reject); socket.once("close", () => reject(failure())); }));
      if (closed) throw failure(); return socket;
    } catch { socket.destroy(); throw failure(); }
  };
  const blocked = (key: string): boolean => {
    const until = restrictions.get(key); if (until === undefined) return false;
    if (until <= Date.now()) { restrictions.delete(key); return false; } return true;
  };
  const tunnel = async (host: string, port: number): Promise<Socket> => {
    const key = `${host.toLowerCase()}:${port}`;
    const assertAllowed = () => { if (closed || blocked(key)) throw failure(); };
    const bindDestination = (socket: Socket): Socket => {
      try { assertAllowed(); } catch { socket.destroy(); throw failure(); }
      destinations.set(socket, key); socket.once("close", () => destinations.delete(socket)); return socket;
    };
    assertAllowed();
    const address = await bounded(destination(host, Boolean(options.testLocal)));
    assertAllowed();
    if (!proxy) return bindDestination(await dial(address, port));
    const proxyHost = proxy.hostname.replace(/^\[|\]$/g, ""), proxyPort = Number(proxy.port || (proxy.protocol === "https:" ? 443 : proxy.protocol === "socks5:" ? 1080 : 80));
    const socket = bindDestination(await dial(proxyHost, proxyPort, proxy.protocol === "https:"));
    const read = reader(socket, timeout);
    try {
      if (proxy.protocol === "socks5:") {
        socket.write(Buffer.from([5, 1, 0]));
        const hello = await read(b => b.length >= 2 ? 2 : undefined);
        if (hello[0] !== 5 || hello[1] !== 0) throw failure();
        const ip = isIP(address) === 4 ? Buffer.from(address.split(".").map(Number)) : ipv6Bytes(address);
        const request = Buffer.concat([Buffer.from([5, 1, 0, isIP(address) === 4 ? 1 : 4]), ip, Buffer.from([port >> 8, port & 255])]);
        socket.write(request);
        const reply = await read(b => {
          if (b.length < 5) return;
          const size = b[3] === 1 ? 10 : b[3] === 4 ? 22 : b[3] === 3 ? 7 + b[4] : -1;
          if (size < 0) throw failure();
          return b.length >= size ? size : undefined;
        });
        if (reply[0] !== 5 || reply[1] !== 0 || reply[2] !== 0) throw failure();
      } else {
        const auth = proxy.username || proxy.password ? "Proxy-Authorization: Basic " + Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64") + "\r\n" : "";
        socket.write(`CONNECT ${authority(address, port)} HTTP/1.1\r\nHost: ${authority(address, port)}\r\n${auth}\r\n`);
        const response = await read(b => { const end = b.indexOf("\r\n\r\n"); return end < 0 ? undefined : end + 4; });
        if (!/^HTTP\/1\.[01] 200(?: |\r)/.test(response.toString("latin1"))) throw failure();
      }
      assertAllowed(); return socket;
    } catch { socket.destroy(); throw failure(); }
  };
  const httpFailure = (response: ServerResponse, status = 502) => { if (!response.headersSent) response.writeHead(status, status === 407 ? { "Proxy-Authenticate": 'Basic realm="browser"', "Connection": "close" } : { "Connection": "close" }); response.end(); };
  const socketFailure = (socket: Duplex, status: number) => { if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${status === 407 ? "Proxy Authentication Required" : "Bad Gateway"}\r\n${status === 407 ? 'Proxy-Authenticate: Basic realm="browser"\r\n' : ""}Connection: close\r\nContent-Length: 0\r\n\r\n`); };
  const server = createServer({ maxHeaderSize: MAX_HEADER, requestTimeout: timeout, headersTimeout: timeout }, (req, res) => {
    if (!authentic(req)) { httpFailure(res, 407); return; }
    void (async () => {
      const target = targetUrl(req.url), socket = await tunnel(target.hostname.replace(/^\[|\]$/g, ""), Number(target.port || 80));
      if (req.destroyed || res.destroyed || closed) { socket.destroy(); return; }
      const agent = new Agent({ keepAlive: false }); agent.createConnection = () => socket;
      const outgoing = httpRequest({ hostname: target.hostname, port: target.port || 80, method: req.method, path: target.pathname + target.search, headers: headers(req, target), agent }, response => {
        res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
        response.once("error", () => res.destroy());
      });
      const headerTimer = setTimeout(() => outgoing.destroy(failure()), timeout);
      outgoing.once("response", () => clearTimeout(headerTimer)); outgoing.once("close", () => clearTimeout(headerTimer));
      outgoing.setTimeout(timeout, () => outgoing.destroy(failure()));
      outgoing.once("error", () => httpFailure(res));
      res.once("close", () => { outgoing.destroy(); socket.destroy(); agent.destroy(); });
      req.once("aborted", () => outgoing.destroy()); req.pipe(outgoing); socket.resume();
    })().catch(() => httpFailure(res));
  });
  server.on("connection", socket => { track(socket); if (closed) { socket.destroy(); return; } socket.setTimeout(timeout, () => socket.destroy()); });
  server.on("clientError", (_error, socket) => socketFailure(socket, 400));
  server.on("connect", (req, client, head) => {
    if (!authentic(req)) { socketFailure(client, 407); return; }
    void (async () => {
      const match = /^(\[[^\]]+\]|[^:\s/?#]+):(\d{1,5})$/.exec(req.url ?? "");
      if (!match) throw failure();
      const port = Number(match[2]); if (port < 1 || port > 65535) throw failure();
      const remote = await tunnel(match[1].replace(/^\[|\]$/g, ""), port);
      if (client.destroyed || closed) { remote.destroy(); return; }
      (client as Socket).setTimeout(0); client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) remote.write(head); client.pipe(remote); remote.pipe(client); remote.resume();
      client.once("close", () => remote.destroy()); remote.once("close", () => client.end());
    })().catch(() => socketFailure(client, 502));
  });
  server.on("upgrade", (req, client, head) => {
    if (!authentic(req)) { socketFailure(client, 407); return; }
    void (async () => {
      const target = targetUrl(req.url), remote = await tunnel(target.hostname.replace(/^\[|\]$/g, ""), Number(target.port || 80));
      if (client.destroyed || closed) { remote.destroy(); return; }
      const values = headers(req, target, true);
      remote.write(`${req.method} ${target.pathname + target.search} HTTP/1.1\r\n${Object.entries(values).map(([key, value]) => `${key}: ${value}\r\n`).join("")}\r\n`);
      if (head.length) remote.write(head);
      const response = await reader(remote, timeout)(b => { const end = b.indexOf("\r\n\r\n"); return end < 0 ? undefined : end + 4; });
      if (client.destroyed || closed) { remote.destroy(); return; }
      client.write(response); (client as Socket).setTimeout(0); client.pipe(remote); remote.pipe(client); remote.resume();
      client.once("close", () => remote.destroy()); remote.once("close", () => client.end());
    })().catch(() => socketFailure(client, 502));
  });
  try {
    let listening = false;
    for (let attempt = 0; attempt < 32; attempt++) {
      const port = randomInt(FIRST_PORT, LAST_PORT + 1);
      try {
        await new Promise<void>((resolve, reject) => {
          const error = (err: NodeJS.ErrnoException) => { server.off("listening", ready); reject(err); };
          const ready = () => { server.off("error", error); resolve(); };
          server.once("error", error); server.once("listening", ready); server.listen(port, "127.0.0.1");
        }); listening = true; break;
      } catch (error) { if (!["EADDRINUSE", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    }
    if (!listening) throw failure();
    server.on("error", () => {});
    const address = server.address(); if (!address || typeof address === "string") throw failure();
    const gatewayOrigin = `http://127.0.0.1:${address.port}`;
    return { proxy: { server: gatewayOrigin }, args: ["--proxy-bypass-list=<-loopback>"],
      restrict(origin: string, until = Date.now() + 10 * 60000) {
        const key = restrictionKey(origin);
        if (!Number.isFinite(until) || until <= Date.now()) { restrictions.delete(key); return; }
        restrictions.set(key, until);
        for (const [socket, destination] of destinations) if (destination === key) socket.destroy();
      },
      allowManual(origin: string) { restrictions.delete(restrictionKey(origin)); },
      async authenticate(page: Page) {
        if (closed) throw failure();
        const session = await page.context().newCDPSession(page);
        if (closed) { await session.detach().catch(() => {}); throw failure(); }
        sessions.add(session);
        const attempted = new Set<string>();
        session.on("Fetch.requestPaused", event => { void session.send("Fetch.continueRequest", { requestId: event.requestId }).catch(() => {}); });
        session.on("Fetch.authRequired", event => {
          let matching = false;
          try { matching = event.authChallenge.source === "Proxy" && new URL(event.authChallenge.origin).origin === gatewayOrigin; } catch { /* Never send credentials to unknown origins. */ }
          const provide = !closed && matching && !attempted.has(event.requestId);
          if (provide) { if (attempted.size >= 4096) attempted.delete(attempted.values().next().value!); attempted.add(event.requestId); }
          void session.send("Fetch.continueWithAuth", { requestId: event.requestId, authChallengeResponse: provide ? { response: "ProvideCredentials", username, password } : { response: matching ? "CancelAuth" : "Default" } }).catch(() => {});
        });
        session.on("Network.loadingFinished", event => attempted.delete(event.requestId));
        session.on("Network.loadingFailed", event => attempted.delete(event.requestId));
        session.on("close", () => { sessions.delete(session); attempted.clear(); });
        try { await bounded(session.send("Fetch.enable", { handleAuthRequests: true, patterns: [{ urlPattern: "*" }] }));
          if (closed) throw failure(); }
        catch { sessions.delete(session); await session.detach().catch(() => {}); throw failure(); }
      },
      close() { return closing ??= (async () => {
        closed = true;
        // Refuse new TCP connections before detaching Fetch: Chromium may retry
        // immediately when an existing proxy tunnel disappears.
        const stopped = new Promise<void>(resolve => server.close(() => resolve()));
        for (const socket of sockets) socket.destroy();
        // Detaching a CDP target can stall while Chromium itself is closing.
        // It must not hold the independently completed network quarantine open.
        void Promise.allSettled([...sessions].map(session => session.detach()));
        sessions.clear();
        await stopped;
      })(); } };
  } catch { closed = true; for (const socket of sockets) socket.destroy(); server.close(); throw failure(); }
}
