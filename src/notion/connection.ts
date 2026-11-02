import { mkdir, open, unlink, access } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createXmindAuthBridgeFetch } from "../xmind/auth-bridge.js";

/** Serialize MCP sessions and OAuth for one Agent/owner grant so refresh rotation cannot race. */
export async function withNotionConnection<T>(storagePath: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const path = `${storagePath}.connection-lock`;
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + 60_000;
  while (true) {
    signal?.throwIfAborted();
    try {
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(String(process.pid)); }
      catch (error) { await handle.close(); await unlink(path); throw error; }
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Never steal a lock: another process may already have replaced a stale lock.
      // A crashed owner must be recovered while all agents are stopped.
      if (Date.now() >= deadline) throw new Error("Notion 连接正忙，请稍后重试；不要重复提交可能已完成的修改。");
      await delay(100, undefined, { signal });
    }
  }
  try { return await action(); } finally { await unlink(path); }
}

export async function notionAuthorizationInProgress(storagePath: string): Promise<boolean> {
  try { await access(`${storagePath}.authorizing`); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Use the same explicitly configured proxy for MCP, discovery, token exchange and bridge. */
export function notionFetch(proxyUrl?: string): typeof fetch {
  const request = createXmindAuthBridgeFetch(proxyUrl);
  return (input, init) => request(input, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000)
  });
}
