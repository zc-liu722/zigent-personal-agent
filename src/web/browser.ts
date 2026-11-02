import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { BrowserService } from "../browser/service.js";
import { browserControlSchema, browserStateMessage, type BrowserScope, type BrowserSession } from "../browser/types.js";
import type { WebStore } from "./store.js";
import type { WebInteraction } from "./interactions.js";

export function browserInteraction(session: BrowserSession, pending?: { id: string; label: string }): WebInteraction {
  return { id: "browser:" + session.id, kind: "browser", title: session.title, status: "pending", browserSession: { id: session.id },
    statusMessage: pending ? "等待确认：" + pending.label : session.error ?? browserStateMessage(session.mode, session.pauseReason), actions: [
      ...(pending ? [{ id: "confirm-submission:" + pending.id, kind: "submit" as const, label: "确认提交", value: { type: "browser-control" as const, browserId: session.id, revision: session.revision, action: "confirm_submission" as const, pendingId: pending.id } },
        { id: "cancel-submission:" + pending.id, kind: "submit" as const, label: "取消提交", value: { type: "browser-control" as const, browserId: session.id, revision: session.revision, action: "cancel_submission" as const, pendingId: pending.id } }] : []),
      { id: "view", kind: "submit", label: "打开浏览器", value: { type: "browser-control", browserId: session.id, revision: session.revision, action: "view" } },
      ...(session.mode !== "agent" ? [{ id: "resume:" + session.revision, kind: "submit" as const, label: session.mode === "user" ? "交还控制" : "继续浏览", value: { type: "browser-control" as const, browserId: session.id, revision: session.revision, action: "resume" as const } }] : []),
      ...(session.mode === "agent" ? [{ id: "pause:" + session.revision, kind: "submit" as const, label: "暂停", value: { type: "browser-control" as const, browserId: session.id, revision: session.revision, action: "pause" as const } }] : []),
      ...(session.mode !== "stopped" ? [{ id: "stop:" + session.revision, kind: "submit" as const, label: "停止", value: { type: "browser-control" as const, browserId: session.id, revision: session.revision, action: "stop" as const } }] : [])
    ] };
}
export class WebBrowser {
  constructor(readonly service: BrowserService, private readonly store: WebStore, private readonly agentId: string, private readonly owner: string) {}
  async summary(conversationId: string) {
    const scope = this.scope(conversationId);
    const session = this.service.sessions(scope).find(item => item.conversationId === scope.conversationId);
    if (!session) return null;
    const view = this.service.summary(scope, session.id);
    return { id: view.id, title: view.title, mode: view.mode, network: view.network ?? "direct", pauseReason: view.pauseReason,
      running: view.running, agentRunning: view.agentRunning, revision: view.revision };
  }
  scope(conversationId: string): BrowserScope {
    const id = this.store.resolveConversation(conversationId), info = id ? this.store.conversationInfo(id) : undefined;
    if (!info) throw new Error("对话不存在");
    return { agentId: this.agentId, userId: this.owner, conversationKind: "p2p", conversationId: info.chatId, sessionId: info.sessionId ?? undefined };
  }
  async handle(route: string, url: URL, req: IncomingMessage, res: ServerResponse,
    read: (req: IncomingMessage, limit?: number) => Promise<Buffer>, credential: string): Promise<boolean> {
    if (!route.startsWith("api/browser")) return false;
    const send = (code: number, result: unknown) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(result)); };
    try {
      const scope = this.scope(z.string().min(1).max(128).parse(url.searchParams.get("conversationId")));
      const id = url.searchParams.get("id"), identity = this.service.controlIdentity(credential);
      const view = async (sessionId: string) => ({ ...await this.service.view(scope, sessionId), canControl: this.service.canControl(scope, sessionId, credential), passwordField: await this.service.passwordField(scope, sessionId), editors: await this.service.editors(scope, sessionId, credential) });
      if (route === "api/browser" && req.method === "GET") {
        send(200, { sessions: this.service.sessions(scope).filter(item => item.conversationId === scope.conversationId) }); return true;
      }
      if (route === "api/browser/open" && req.method === "POST") {
        const existing = this.service.sessions(scope).find(item => item.conversationId === scope.conversationId);
        const session = existing ?? this.service.create(scope);
        if (!existing) await this.service.execute(scope, { action: "open" });
        send(200, await view(session.id)); return true;
      }
      if (!id || !z.string().uuid().safeParse(id).success) { send(400, { error: "浏览器不可用" }); return true; }
      if (route === "api/browser/state" && req.method === "GET") { send(200, await view(id)); return true; }
      if (route === "api/browser/frame" && req.method === "GET") {
        const frame = await this.service.screenshot(scope, id);
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store" }); res.end(frame); return true;
      }
      if (route === "api/browser/control" && req.method === "POST") {
        if (!req.headers["content-type"]?.startsWith("application/json")) throw new Error("请求格式不正确");
        const input = browserControlSchema.parse(JSON.parse((await read(req)).toString()));
        const next = await this.service.control(scope, id, input, identity);
        send(200, { ...next, canControl: this.service.canControl(scope, id, credential), passwordField: await this.service.passwordField(scope, id), editors: await this.service.editors(scope, id, credential) }); return true;
      }
      if (route === "api/browser/upload" && req.method === "POST") {
        const name = decodeURIComponent(String(req.headers["x-file-name"] ?? "文件"));
        send(200, await this.service.upload(scope, id, name, await read(req, 25 * 1024 * 1024), identity)); return true;
      }
      if (route === "api/browser/file" && req.method === "GET") {
        const fileId = z.string().uuid().parse(url.searchParams.get("file")), file = await this.service.file(scope, id, fileId);
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` }); res.end(file.data); return true;
      }
      send(404, { error: "浏览器接口不存在" });
    } catch (error) {
      const message = error instanceof Error && !error.message.includes("\n") && error.message.length < 160 ? error.message : "浏览器操作未完成，请重试";
      send(409, { error: message });
    }
    return true;
  }
  async interaction(conversationId: string, value: Extract<import("./interactions.js").WebInteractionValue, { type: "browser-control" }>, credential: string): Promise<void> {
    const scope = this.scope(conversationId);
    await this.service.view(scope, value.browserId);
    if (value.action !== "view") await this.service.control(scope, value.browserId, { id: randomUUID(), action: value.action, revision: value.revision, pendingId: value.pendingId }, this.service.controlIdentity(credential));
  }
}
