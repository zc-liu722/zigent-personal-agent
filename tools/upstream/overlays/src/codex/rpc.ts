import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import WebSocket from "ws";

type Message = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
/** Desktop WebSocket or the component studio's local stdio; never exposed through ZigentLink. */
export class CodexRpc extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private socket?: WebSocket;
  private sequence = 0;
  private buffer = "";
  private starting?: Promise<void>;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(readonly command: string, readonly args: string[] = ["app-server", "proxy"], readonly cwd?: string, readonly desktopEndpoint?: string,
    readonly desktopCodexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex")) { super(); }
  get connected() { return Boolean(this.child || this.socket?.readyState === WebSocket.OPEN); }
  async start() {
    if (this.starting) return this.starting; if (this.connected) return;
    this.starting = this.connect().finally(() => { this.starting = undefined; }); return this.starting;
  }
  private receive(line: string) {
    let message: Message; try { message = JSON.parse(line) as Message; } catch { this.close(); return; }
    if (typeof message.id === "number" && !message.method) {
      const entry = this.pending.get(message.id); if (!entry) return;
      clearTimeout(entry.timer); this.pending.delete(message.id);
      if (message.error) entry.reject(new Error("Codex request failed: " + (message.error.message ?? "unknown").slice(0, 300)));
      else entry.resolve(message.result);
    } else if (message.method && message.id !== undefined) this.emit("request", message);
    else if (message.method) this.emit("notification", message);
  }
  private async connect() {
    try {
      if (this.desktopEndpoint || this.args[0] === "app-server" && this.args[1] === "proxy") {
        const index = this.args.indexOf("--sock"), path = index >= 0 ? this.args[index + 1]! : join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "app-server-control/app-server-control.sock");
        const socket = new WebSocket(this.desktopEndpoint ?? "ws+unix://" + path + ":/rpc", { handshakeTimeout: 10000, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false }); this.socket = socket;
        socket.on("message", bytes => this.receive(bytes.toString()));
        socket.on("close", () => { if (this.socket === socket) this.close(); });
        socket.on("error", () => { if (this.socket === socket) this.close(); });
        await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", () => reject(new Error("Codex managed socket unavailable"))); });
      } else {
        const child = spawn(this.command, this.args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], shell: false }); this.child = child; this.buffer = "";
        child.stderr.resume(); child.stdin.on("error", () => { if (this.child === child) this.close(); });
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", bytes => {
          this.buffer += bytes;
          if (this.buffer.length > 16 * 1024 * 1024) { this.close(); return; }
          while (this.buffer.includes("\n")) { const end = this.buffer.indexOf("\n"), line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1); this.receive(line); }
        });
        child.on("close", () => { if (this.child === child) this.close(); }); child.on("error", () => { if (this.child === child) this.close(); });
      }
      const identity = await this.call<{ codexHome?: string; platformFamily?: string }>("initialize", { clientInfo: { name: "zigent-worker", title: "Zigent desktop connector", version: "0.1.0" }, capabilities: { experimentalApi: true } });
      if (this.desktopEndpoint) {
        const normalizeHome = (value: string) => win32.normalize(value).replace(/[\\/]+$/, "").toLowerCase();
        if (identity.platformFamily !== "windows" || !identity.codexHome || !win32.isAbsolute(identity.codexHome)
          || !win32.isAbsolute(this.desktopCodexHome) || normalizeHome(identity.codexHome) !== normalizeHome(this.desktopCodexHome))
          throw new Error("The endpoint does not match the configured Windows desktop Codex home");
      }
      this.notify("initialized", {});
    } catch (error) { this.close(); throw error; }
  }
  private write(value: unknown) { const line = JSON.stringify(value); if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(line); else this.child?.stdin.write(line + "\n"); }
  call<T = Record<string, unknown>>(method: string, params: unknown, timeoutMs = 30000): Promise<T> {
    if (!this.connected) return Promise.reject(new Error("Codex is disconnected"));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Codex request timed out: " + method)); }, timeoutMs);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer }); this.write({ id, method, params });
    });
  }
  notify(method: string, params: unknown) { this.write({ method, params }); }
  respond(id: number | string, result: unknown) { this.write({ id, result }); }
  reject(id: number | string) { this.write({ id, error: { code: -32601, message: "This request needs a supported explicit user action" } }); }
  close() {
    const child = this.child, socket = this.socket; this.child = undefined; this.socket = undefined;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Codex connection closed")); }
    this.pending.clear(); if (child || socket) this.emit("closed");
    if (child) { child.stdin.end(); child.kill(); } socket?.terminate();
  }
}
