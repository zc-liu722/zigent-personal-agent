import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { NativeProcessPool, type NativeProcessTarget } from "../native-process-pool.js";
import { AcpClient, AcpError } from "./client.js";
import { object, type AcpSession } from "./session.js";

export type AcpLaunch = {
  key: string;
  identity?(): Promise<string>;
  launch(workspace: string, signal: AbortSignal): Promise<ChildProcessWithoutNullStreams>;
};

export type PreparedAcpProcess = {
  workspace: string;
  client: AcpClient;
  initialization: Awaited<ReturnType<AcpClient["initialize"]>>;
  sessions: Map<string, AcpSession>;
  openedSessions: number;
  changedConfigurations: Set<string>;
  identity?: string;
  initializeMs: number;
};

export class AcpWarmPool extends NativeProcessPool<PreparedAcpProcess> {
  constructor(private readonly label: string) {
    super(process => process.client.available, async process => {
      await process.client.close();
      await Promise.all([...process.sessions.values()].map(session => session.closeBridge()));
      await rm(process.workspace, { recursive: true, force: true, maxRetries: 3 });
    });
  }

  target(process: AcpLaunch, timeoutMs: number, expiresAt?: number): NativeProcessTarget<PreparedAcpProcess> {
    return { key: process.key, expiresAt, create: signal => this.prepare(process, timeoutMs, signal) };
  }

  private async prepare(process: AcpLaunch, timeoutMs: number, signal: AbortSignal): Promise<PreparedAcpProcess> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const workspace = await mkdtemp(join(tmpdir(), "zigent-acp-"));
    let client: AcpClient | undefined;
    const started = performance.now();
    try {
      deadline.throwIfAborted();
      const identity = await process.identity?.();
      client = new AcpClient(await process.launch(workspace, deadline), this.label);
      const initializing = client.initialize();
      const abort = () => { void client!.close(); };
      deadline.addEventListener("abort", abort, { once: true });
      if (deadline.aborted) abort();
      try {
        const initialization = await initializing;
        deadline.throwIfAborted();
        if (initialization.protocolVersion !== 1) throw new AcpError("configuration", `${this.label} CLI 不支持 ACP 版本 1。`);
        const sessions = new Map<string, AcpSession>();
        const changedConfigurations = new Set<string>();
        client.onIdleMessage = message => {
          const params = object(message.params);
          if (message.method === "session/update" && typeof params.sessionId === "string"
            && object(params.update).sessionUpdate === "config_option_update" && sessions.has(params.sessionId)) {
            changedConfigurations.add(params.sessionId);
          }
        };
        return { workspace, client, initialization, sessions, openedSessions: 0, identity, changedConfigurations,
          initializeMs: performance.now() - started };
      } finally { deadline.removeEventListener("abort", abort); }
    } catch (error) {
      await client?.close();
      await rm(workspace, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
      if (deadline.aborted && !signal.aborted) throw new AcpError("connection", `${this.label} CLI 初始化超时。`);
      throw error;
    }
  }
}
