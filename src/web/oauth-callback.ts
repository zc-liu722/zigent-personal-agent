import { createHash, timingSafeEqual } from "node:crypto";
import type { ProductivityIntegration } from "../productivity/config.js";

export function webNotionCallbackUrl(publicUrl: string): string {
  return new URL("oauth/notion/callback", publicUrl).toString();
}

export function webProductivityCallbackPaths(publicUrl: string): Record<ProductivityIntegration, string> {
  const base = new URL(publicUrl).pathname;
  return Object.fromEntries(["google_calendar", "google_drive", "todoist"].map(service => [service, `${base}oauth/${service}/callback`])) as Record<ProductivityIntegration, string>;
}
export const WEB_PRODUCTIVITY_CALLBACK_PATHS = webProductivityCallbackPaths("https://localhost/deepmind/");
export function webProductivityCallbackUrl(publicUrl: string, service: ProductivityIntegration): string {
  return new URL(webProductivityCallbackPaths(publicUrl)[service], publicUrl).toString();
}
export const WEB_TODOIST_CALLBACK_PATH = WEB_PRODUCTIVITY_CALLBACK_PATHS.todoist;
export function webTodoistCallbackUrl(publicUrl: string): string { return webProductivityCallbackUrl(publicUrl, "todoist"); }
type Result = { code: string } | { error: "cancelled" | "failed" };
type Pending = { stateHash: Buffer; expiresAt: number; timer: NodeJS.Timeout; result?: Result; settle?: (result: Result) => void };

/** Single-process OAuth rendezvous for the existing public web origin. No device cookie is required. */
export class WebOAuthCallback {
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  constructor(readonly callbackUrl: string) {}

  async register(id: string, state: string, expiresAt: number): Promise<void> {
    if (this.closed || !/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(state) || state.split(".")[0] !== id
      || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 15 * 60_000 || this.pending.has(id)) throw new Error("Invalid web authorization request");
    const timer = setTimeout(() => this.expire(id), Math.max(1, expiresAt - Date.now())); timer.unref();
    this.pending.set(id, { stateHash: createHash("sha256").update(state).digest(), expiresAt, timer });
  }

  async waitForCode(id: string, expiresAt: number, signal?: AbortSignal): Promise<string> {
    const entry = this.pending.get(id);
    if (!entry || entry.expiresAt !== expiresAt || entry.expiresAt <= Date.now() || entry.settle) throw new Error("Web authorization request expired");
    return new Promise<string>((resolve, reject) => {
      const finish = (result: Result) => {
        clearTimeout(entry.timer); this.pending.delete(id); signal?.removeEventListener("abort", aborted);
        if ("code" in result) resolve(result.code);
        else reject(new Error(result.error === "cancelled" ? "Account authorization was cancelled" : "Web authorization request expired or failed"));
      };
      const aborted = () => finish({error:"failed"});
      entry.settle = finish;
      if (signal?.aborted) aborted();
      else if (entry.result) finish(entry.result);
      else signal?.addEventListener("abort", aborted, {once:true});
    });
  }

  receive(url: URL): boolean {
    if (this.closed || url.pathname !== new URL(this.callbackUrl).pathname) return false;
    const state = url.searchParams.get("state") ?? "", code = url.searchParams.get("code"), error = url.searchParams.get("error");
    if (state.length > 512 || url.searchParams.getAll("state").length !== 1 || url.searchParams.getAll("code").length > 1
      || url.searchParams.getAll("error").length > 1 || Boolean(code) === Boolean(error)
      || code && (code.length > 4096 || /[\x00-\x1f]/.test(code)) || error && error.length > 200) return false;
    const id = state.split(".")[0]!, entry = this.pending.get(id);
    if (!entry || entry.result || entry.expiresAt <= Date.now() || !timingSafeEqual(entry.stateHash, createHash("sha256").update(state).digest())) return false;
    const result: Result = code ? {code} : {error:error === "access_denied" ? "cancelled" : "failed"};
    entry.result = result;
    entry.settle?.(result);
    return true;
  }
  private expire(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer); this.pending.delete(id); entry.settle?.({error:"failed"});
  }
  close(): void { this.closed = true; for (const id of this.pending.keys()) this.expire(id); }
}

export function webOAuthCallbackPage(received: boolean, basePath = "/deepmind/"): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>账号连接</title><link rel="stylesheet" href="${basePath}style.css"><main class="login-content"><h1>${received ? "已收到授权结果" : "授权链接已失效"}</h1><p>${received ? "回到对话查看连接状态；账号验证完成后，操作区会自动更新。" : "请回到对话重新连接账号。"}</p><a class="primary" href="${basePath}">返回对话</a></main></html>`;
}
