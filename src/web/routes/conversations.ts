import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentRuntime } from "../../runtime.js";
import type { ConversationCoordinator } from "../conversation-coordinator.js";
import type { WebStore } from "../store.js";

import { conditionalJson, data, json, type WebRoute } from "../http.js";

export function createConversationsRoutes({ store, runtime, owner, coordinator }: {
  store: WebStore;
  runtime: AgentRuntime;
  owner: string;
  coordinator: ConversationCoordinator;
}) {
  const branchRequests = new Map<string, { key: string; result: Promise<{ id: string }> }>();
  async function createConversation(): Promise<string> {
    const id = `web:${randomUUID()}`;
    store.draftConversation(id);
    return store.publicId(id);
  }
  const handle: WebRoute = async ({ req, res, url, route, credential }) => {
    if (route === "api/conversations" && req.method === "GET") {
      if (!url.search) { conditionalJson(req, res, store.conversations()); return true; }
      const input = z.object({ page: z.literal("1").optional(), q: z.string().trim().max(500).default(""),
        cursor: z.string().regex(/^\d{1,16}:\d{1,16}$/).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(200) }).strict().safeParse(Object.fromEntries(url.searchParams));
      if (!input.success) { json(res, 400, { error: "搜索或分页无效。" }); return true; }
      const parts = input.data.cursor?.split(":").map(Number);
      if (parts?.some(value => !Number.isSafeInteger(value) || value < 0)) { json(res, 400, { error: "分页无效。" }); return true; }
      conditionalJson(req, res, store.conversationPage(input.data.q, parts ? { updatedAt: parts[0]!, rowid: parts[1]! } : undefined, input.data.limit));
      return true;
    }
    if (route === "api/conversations" && req.method === "DELETE") {
      const input = z.object({ conversationId: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(await data(req));
      const id = store.resolveConversation(input.conversationId), conversation = id && store.conversationInfo(id);
      if (conversation && (coordinator.changing(conversation.chatId) || store.pendingEdit(conversation.chatId))) {
        json(res, 409, { error: "正在处理，请稍后重试删除。" }); return true;
      }
      const stop = conversation && coordinator.activeConversation(conversation.chatId) === id;
      if (conversation) coordinator.beginChange(conversation.chatId);
      try {
        // Hold queue admission until all owned programs are confirmed stopped.
        if (stop) await coordinator.stopReply(conversation.chatId);
        if (conversation && conversation.sessionId) await runtime.fileWorkbench?.execution.cancelSession(conversation.sessionId);
        if (!store.deleteConversation(input.conversationId)) { json(res, 404, { error: "对话不存在。" }); return true; }
      } catch { json(res, 503, { error: "程序尚未确认停止，系统正在重试，请稍后重试删除。" }); return true; }
      finally { if (conversation) { coordinator.endChange(conversation.chatId); store.emit("change"); } }
      json(res, 200, { ok: true }); return true;
    }
    if (route === "api/conversations" && req.method === "POST") {
      const id = await createConversation();
      json(res, 201, { id, greeting: store.conversationGreeting(store.resolveConversation(id)!) }); return true;
    }
    if (route === "api/conversations/retain" && req.method === "POST") {
      const input = z.object({ conversationId: z.string().regex(/^[a-f0-9]{64}$/), title: z.string().max(60) }).strict().parse(await data(req));
      const id = store.resolveConversation(input.conversationId);
      if (!id) { json(res, 404, { error: "对话不存在。" }); return true; }
      // A submitted image message may remain in the browser outbox for minutes.
      // Keep its new conversation address valid across a service restart.
      if (store.isDraft(id)) store.conversation(id, input.title || "图片消息");
      json(res, 200, { ok: true }); return true;
    }
    if (route === "api/branches" && req.method === "POST") {
      const input = z.object({ id: z.string().uuid(), conversationId: z.string().regex(/^[a-f0-9]{64}$/),
        messageId: z.string().min(1).max(128), mode: z.literal("reply").default("reply") }).strict().parse(await data(req));
      const id = store.resolveConversation(input.conversationId), target = store.message(input.messageId);
      if (!id || target?.conversationId !== id || target.role !== "assistant") { json(res, 404, { error: "这条消息不存在。" }); return true; }
      const existing = store.branchRequest(input.id);
      if (existing) {
        if (existing.source_id !== id || existing.message_id !== target.id) { json(res, 409, { error: "操作编号已使用，请重试。" }); return true; }
        json(res, 200, { id: store.publicId(existing.target_id) }); return true;
      }
      // Concurrent retries of the same operation share one durable result.
      const pending = branchRequests.get(input.id);
      const key = JSON.stringify([id,target.id,input.mode]);
      if (pending) {
        if (pending.key !== key) { json(res, 409, { error: "操作编号已使用，请重试。" }); return true; }
        try { json(res, 200, await pending.result); } catch { json(res, 409, { error: "暂时无法创建分支，请重试。" }); } return true;
      }
      const conversation = store.conversationInfo(id)!;
      if (target.snapshot && target.snapshot.status !== "completed") {
        json(res, 409, { error: "请等待完整回复后再创建分支。" }); return true;
      }
      if (!conversation.sessionId) { json(res, 409, { error: "这条回复的上下文暂不可用。" }); return true; }
      const operation = (async () => {
        const history = store.messagesThrough(id, target.id), session = await runtime.memory.getSession(conversation.sessionId!);
        const sourceUser = target.replyTo ? history.find(message => message.id === target.replyTo && message.role === "user")
          : [...history].reverse().find(message => message.role === "user");
        const userTurn = sourceUser && session.messages.find(message => message.role === "user" &&
          (message.messageId === sourceUser.id || `history:${store.publicId(message.id)}` === sourceUser.id));
        const boundary = session.messages.find(message => message.role === "assistant" &&
          (`history:${store.publicId(message.id)}` === target.id || message.messageId === target.id ||
            userTurn && message.turnId === userTurn.turnId && message.content === target.text));
        if (!boundary) throw new Error("Branch point unavailable");
        const prefix = history;
        const messageIds = Object.fromEntries(prefix.map(message => [message.id, randomUUID()]));
        const targetId = `web:${randomUUID()}`;
        const fork = await runtime.memory.branchSession(owner, session.id, boundary.id, targetId, messageIds);
        try { store.saveBranch(input.id,id,target.id,targetId,fork.id,prefix,messageIds); }
        catch (error) { await runtime.memory.deleteSession(targetId,fork.id,owner); throw error; }
        return { id: store.publicId(targetId) };
      })();
      branchRequests.set(input.id, { key, result: operation });
      try { json(res, 201, await operation); }
      catch { json(res, 409, { error: "暂时无法创建分支，请刷新后重试。" }); }
      finally { branchRequests.delete(input.id); store.emit("change"); }
      return true;
    }
    return false;
  };
  return { handle, createConversation };
}
