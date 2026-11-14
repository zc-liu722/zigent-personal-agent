import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
export type Failure = "configuration" | "authentication" | "connection" | "model" | "unknown";
export class AcpError extends Error {
  constructor(readonly acpFailure: Failure, message: string, readonly rpcCode?: number) { super(message); }
}

const networkError = /\b(?:proxyconnect tcp|dial tcp|i\/o timeout|context deadline exceeded|connection (?:refused|reset|timed out)|network is unreachable|no route to host|TLS handshake timeout|transport is closing)\b/i;

export function acpProcessEnvironment(proxy?: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|LANG|LC_ALL)$/i.test(key)));
  return { ...env, ...(proxy ? { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy,
    NO_PROXY: "localhost,127.0.0.1,::1" } : {}) };
}

type RpcMessage = { id?: number | string; method?: string; params?: unknown; result?: unknown;
  error?: { code?: number; message?: string } };

type AcpInitialization = { protocolVersion: number; agentCapabilities?: {
  mcpCapabilities?: { http?: boolean }; promptCapabilities?: { image?: boolean };
  loadSession?: boolean; sessionCapabilities?: { close?: object; resume?: object; load?: object };
} };

export class AcpClient {
  private id = 0;
  private closed = false;
  private buffer = "";
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; detach(): void; beforeResolve?(): void }>();
  private readonly exited: Promise<void>;
  private stopping?: Promise<void>;
  onIdleMessage?: (message: RpcMessage) => void;
  onMessage?: (message: RpcMessage) => void;

  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly label: string) {
    this.exited = new Promise(resolve => child.once("close", () => { this.disconnect(); resolve(); }));
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.closed) return;
      this.buffer += chunk;
      if (this.buffer.length > 8 * 1024 * 1024) { this.disconnect(); return; }
      let newline: number;
      while (!this.closed && (newline = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as RpcMessage;
          const pending = !message.method && typeof message.id === "number" && this.pending.get(message.id);
          if (pending && typeof message.id === "number") {
            this.pending.delete(message.id);
            pending.detach();
            if (message.error) {
              const detail = String(message.error.message ?? "");
              const connection = this.label === "Antigravity" && networkError.test(detail);
              const auth = (this.label === "Cursor" && message.error.code === -32000) || /auth|login|sign.?in/i.test(detail);
              pending.reject(connection
                ? new AcpError("connection", `${this.label} CLI 网络连接失败。`, message.error.code)
                : new AcpError(auth ? "authentication" : "model", auth
                  ? `${this.label} 服务端凭据未获授权。` : `${this.label} 拒绝了请求，请检查模型权限和额度。`, message.error.code));
            } else { pending.beforeResolve?.(); pending.resolve(message.result); }
          } else if (this.onMessage) this.onMessage(message);
          else if (message.method && message.id !== undefined) {
            this.send(message.method === "session/request_permission"
              ? { jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } }
              : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "No active client request handler" } });
          } else this.onIdleMessage?.(message);
        } catch { this.disconnect(); }
      }
    });
    child.stdin.on("error", () => this.disconnect());
    child.on("error", () => this.disconnect());
  }

  send(message: object): void {
    if (!this.closed && !this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  get available(): boolean { return !this.closed && !this.child.stdin.destroyed; }
  initialize(): Promise<AcpInitialization> {
    return this.request("initialize", { protocolVersion: 1, clientInfo: { name: "zigent", version: "0.1.0" },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  }
  request<T>(method: string, params: object, signal?: AbortSignal, beforeResolve?: () => void): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!this.available) return Promise.reject(new AcpError("connection", `${this.label} CLI 连接已关闭。`));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const detach = () => signal?.removeEventListener("abort", abort);
      const abort = () => { this.pending.delete(id); detach(); reject(signal?.reason); };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { resolve: value => resolve(value as T), reject, detach, beforeResolve });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  private disconnect(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.detach();
      pending.reject(new AcpError("connection", `${this.label} CLI 未完成连接。`));
    }
    this.pending.clear();
  }
  close(): Promise<void> { return this.stopping ??= this.stop(); }

  private async stop(): Promise<void> {
    this.disconnect();
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null && this.child.pid) {
      if (process.platform === "win32") {
        await new Promise<void>(resolve => {
          const killer = spawn("taskkill.exe", ["/pid", String(this.child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
          killer.once("error", () => { this.child.kill(); resolve(); });
          killer.once("close", code => { if (code) this.child.kill(); resolve(); });
        });
      } else this.child.kill();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 2_000); })]); }
    finally { clearTimeout(timer); }
  }
}
