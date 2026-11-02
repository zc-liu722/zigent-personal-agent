import { createHash } from "node:crypto";
import { z } from "zod";
import { parseAgentCommand } from "../../agent/commands.js";
import type { ReferenceImage } from "../../image-generation.js";
import type { AgentRuntime } from "../../runtime.js";
import type { WebBrowser } from "../browser.js";
import { WebAssetPreviews } from "../asset-previews.js";
import { sendAsset } from "../asset-downloads.js";
import { WebAssetUploads } from "../asset-uploads.js";
import { activityIdentity } from "../message-activity.js";
import type { ConversationCoordinator } from "../conversation-coordinator.js";
import type { WebMessage, WebStore } from "../store.js";
import { queuedMessageView, type QueuedWebMessage } from "../store.js";
import { isNotionAuthorizationRequest, type WebAuthorizationInteractions } from "../authorization.js";

import { conditionalJson, data, json, type WebRoute } from "../http.js";

export function createMessagesRoutes({ store, runtime, owner, coordinator, browsers, authorizations, createConversation, messageView }: {
  store: WebStore;
  runtime: AgentRuntime;
  owner: string;
  coordinator: ConversationCoordinator;
  browsers: WebBrowser | undefined;
  authorizations: WebAuthorizationInteractions;
  createConversation: () => Promise<string>;
  messageView: (message: WebMessage, info: NonNullable<ReturnType<WebStore["conversationInfo"]>>) => unknown;
}) {
  const sendSchema = z.object({ id: z.string().uuid(), conversationId: z.string().regex(/^[a-f0-9]{64}$/), text: z.string().max(16000), assets: z.array(z.string().uuid()).max(4).default([]), editMessageId: z.string().min(1).max(128).optional() });

  const newSessionCommands = new Map<string, Promise<string>>();
  const previews = new WebAssetPreviews(store);
  const uploads = new WebAssetUploads(store, async id => {
    if (!runtime.fileWorkbench) return;
    const metadata = store.documentMetadata([id])[id];
    if (!metadata) return;
    const file = store.asset(id);
    if (!file) return;
    await runtime.fileWorkbench.retainUpload({ id, ...metadata, bytes: Buffer.from(file.bytes), sha256: createHash("sha256").update(file.bytes).digest("hex") });
  });
  async function page(conversationId: string, before = Number.MAX_SAFE_INTEGER, limit = 20, compact = false) {
    const id = store.resolveConversation(conversationId);
    if (!id) return undefined;
    const browser = await browsers?.summary(conversationId) ?? null;
    // Browser lookup may yield; a conversation deleted meanwhile must not be returned.
    if (store.resolveConversation(conversationId) !== id) return undefined;
    const info = store.conversationInfo(id)!;
    const messages = store.messages(id, before, limit, compact);
    const busy = coordinator.activeConversation(info.chatId) === id;
    return { hasOlder: messages.length > 0 && store.hasMessagesBefore(id, messages[0]!.seq), busy,
      activeMessageId: busy ? coordinator.activeMessage(info.chatId) : undefined,
      queued: store.queuedMessages(id).map(queuedMessageView), revision: store.conversationRevision(id),
      selectedModel: coordinator.selectedModel(id), branch: store.branchOrigin(id),
      greeting: store.conversationGreeting(id), browser, assetDimensions: previews.dimensions(messages.flatMap(message => message.assets ?? [])),
      messages: messages.map(message => messageView(message, info)) };
  }
  const handle: WebRoute = async ({ req, res, url, route, credential }) => {
    if (route === "api/messages" && req.method === "GET") {
      const before = Number(url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER);
      if (!Number.isSafeInteger(before) || before < 1) { json(res, 400, { error: "分页无效。" }); return true; }
      const limit = Number(url.searchParams.get("limit") ?? 100);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) { json(res, 400, { error: "分页无效。" }); return true; }
      const result = await page(url.searchParams.get("conversationId") ?? "", before, limit, url.searchParams.get("compact") === "1");
      if (!result) { json(res, 404, { error: "对话不存在。" }); return true; }
      conditionalJson(req, res, result); return true;
    }
    if (route === "api/messages/activity" && req.method === "GET") {
      const input = z.object({ conversationId: z.string().regex(/^[a-f0-9]{64}$/), messageId: z.string().min(1).max(128) }).parse(Object.fromEntries(url.searchParams));
      const id = store.resolveConversation(input.conversationId);
      const message = id ? store.message(input.messageId) : undefined;
      if (!id || message?.conversationId !== id || !message.snapshot) { json(res, 404, { error: "过程记录不存在。" }); return true; }
      const sessionId = store.conversationInfo(id)?.sessionId;
      const snapshot = sessionId && message.snapshot.status !== "running"
        ? runtime.subagents.restoreActivity(message.snapshot, owner, sessionId) : message.snapshot;
      // The durable message remains the revision anchor; legacy audit reports are read-only enrichment.
      conditionalJson(req, res, { ...activityIdentity(message.snapshot), bytes: Buffer.byteLength(JSON.stringify(snapshot)), snapshot }); return true;
    }
    if (route === "api/assets" && req.method === "POST") {
      await uploads.receive(req, res); return true;
    }
    if (route.startsWith("api/assets/uploads/") && ["GET", "DELETE"].includes(req.method ?? "")) {
      const id = z.string().uuid().parse(route.slice("api/assets/uploads/".length));
      if (req.method === "GET") { await uploads.status(id, res); return true; }
      uploads.discard(id); json(res, 200, { ok: true }); return true;
    }
    if (route.startsWith("api/assets/") && ["GET", "HEAD"].includes(req.method ?? "")) {
      const id = route.slice("api/assets/".length);
      const metadata = /^[a-f0-9-]{36}$/.test(id) ? store.assetMetadata(id) : undefined;
      if (!metadata) { json(res, 404, { error: "附件不存在。" }); return true; }
      const document = store.documentMetadata([id])[id];
      const variant = url.searchParams.get("preview") === "display" ? "display" : "thumbnail";
      const preview = !document && ["1", "display"].includes(url.searchParams.get("preview") ?? "") ? await previews.prepare(id, variant) : undefined;
      // Edited text attachments retain their ID; revalidate against their current content version.
      const etag = `"${id}${document ? "-" + document.sha256 : preview?.available ? variant === "display" ? "-display-v1" : "-preview-v1" : ""}"`;
      const derived = preview?.available ? previews.read(id, variant) : undefined;
      sendAsset(req, res, { mime: derived?.mime ?? metadata.mime, size: derived?.bytes.length ?? metadata.size,
        etag, immutable: !document && metadata.mime.startsWith("image/"), name: document?.name },
      (start, length) => derived ? derived.bytes.subarray(start, start + length) : store.assetBytes(id, start, length));
      return true;
    }
    if (route === "api/messages/stop" && req.method === "POST") {
      const input = z.object({ conversationId: z.string().regex(/^[a-f0-9]{64}$/), messageId: z.string().min(1).max(128) }).strict().parse(await data(req));
      const id = store.resolveConversation(input.conversationId);
      if (!id) { json(res, 404, { error: "对话不存在。" }); return true; }
      const chatId = store.conversationInfo(id)!.chatId;
      // An old page or a lost acknowledgement must never stop the next reply.
      if (coordinator.activeConversation(chatId) !== id || coordinator.activeMessage(chatId) !== input.messageId) { json(res, 200, { ok: true }); return true; }
      if (coordinator.changing(chatId)) { json(res, 409, { error: "正在处理，请稍后重试。" }); return true; }
      coordinator.beginChange(chatId);
      try { await coordinator.stopReply(chatId); }
      catch { json(res, 503, { error: "程序尚未确认停止，系统正在重试。" }); return true; }
      finally { coordinator.endChange(chatId); store.emit("change"); }
      json(res, 200, { ok: true }); return true;
    }
    if (route === "api/messages/queue" && req.method === "POST") {
      const input = z.object({ conversationId: z.string().regex(/^[a-f0-9]{64}$/), id: z.string().uuid(), action: z.enum(["steer", "cancel", "retry"]) }).parse(await data(req));
      const id = store.resolveConversation(input.conversationId), message = store.queuedMessage(input.id);
      if (!id || message?.conversationId !== id) { json(res, 404, { error: "等待消息不存在。" }); return true; }
      if (coordinator.changing(store.conversationInfo(id)!.chatId)) { json(res, 409, { error: "正在处理，请稍后重试。" }); return true; }
      if (input.action === "cancel") {
        if (message.status === "dispatched") { json(res, 409, { error: "消息已开始处理。" }); return true; }
        if (message.status !== "cancelled") store.saveQueuedMessage({ ...message, status: "cancelled" });
      } else if (message.status === "queued" || message.status === "failed") {
        const chatId = store.conversationInfo(id)!.chatId;
        if (input.action === "steer") {
          if (store.pendingEdit(chatId) || coordinator.hasActive(chatId) && (coordinator.activeConversation(chatId) !== id || !coordinator.hasTask(chatId)) || !coordinator.hasActive(chatId) && coordinator.atCapacity()) {
            json(res, 409, { error: "暂时无法插入，请稍后重试。" }); return true;
          }
          store.recordDiagnostic(id, message.id, { phase: "steer_requested", model: message.model });
          coordinator.dispatchQueuedMessage(message);
        } else store.saveQueuedMessage({ ...message, status: "queued", error: undefined });
      }
      json(res, 200, { ok: true, queued: store.queuedMessages(id).map(queuedMessageView) }); return true;
    }
    if (route === "api/messages" && req.method === "POST") {
      const input = sendSchema.parse(await data(req));
      const id = store.resolveConversation(input.conversationId);
      if (!id) { json(res, 404, { error: "对话不存在。" }); return true; }
      if (!input.text.trim() && !input.assets.length) { json(res, 400, { error: "请输入消息或添加附件。" }); return true; }
      const payloadKey = createHash("sha256").update(JSON.stringify([input.text.trim(), input.assets])).digest("hex");
      let editRequest = store.editRequest(input.id);
      if (editRequest) {
        if (editRequest.conversation_id !== id || editRequest.message_id !== input.editMessageId || editRequest.completed && editRequest.payload_key !== payloadKey) {
          json(res, 409, { error: "操作编号已使用，请刷新后重试。" }); return true;
        }
        if (editRequest.completed) { json(res, 200, { ok: true, duplicate: true, conversationId: input.conversationId }); return true; }
      }
      const rewound = store.rewoundMessage(input.id);
      if (rewound) {
        if (rewound.conversation_id !== id) { json(res, 409, { error: "操作编号已使用，请重试。" }); return true; }
        json(res, 200, { ok: true, duplicate: true, conversationId: input.conversationId }); return true;
      }
      const previous = store.message(input.id);
      if (previous) {
        if (previous.conversationId !== id || input.editMessageId) { json(res, 409, { error: "操作编号已使用，请重试。" }); return true; }
        const action = previous.action as { type?: string; conversationId?: string } | undefined;
        json(res, 200, { ok: true, duplicate: true, conversationId: action?.type === "new-session" ? action.conversationId : input.conversationId }); return true;
      }
      const queued = store.queuedMessage(input.id);
      if (queued) {
        if (queued.conversationId !== id || input.editMessageId) { json(res, 409, { error: "操作编号已使用，请重试。" }); return true; }
        json(res, 200, { ok: true, duplicate: true, queued: queued.status === "queued" || queued.status === "failed", conversationId: input.conversationId }); return true;
      }
      const editTarget = input.editMessageId ? store.message(input.editMessageId) : undefined;
      if (input.editMessageId && (editTarget?.conversationId !== id || editTarget.role !== "user")) {
        json(res, 404, { error: "要编辑的消息不存在，请刷新后重试。" }); return true;
      }
      if (!input.editMessageId && parseAgentCommand(input.text)?.type === "new-session") {
        let command = newSessionCommands.get(input.id);
        if (!command) {
          const draft = store.isDraft(id);
          command = createConversation().then(conversationId => {
            if (!draft) store.save({ id: input.id, conversationId: id, role: "notice", text: "已开启新会话。", createdAt: Date.now(), action: { type: "new-session", conversationId } });
            return conversationId;
          }).finally(() => { if (!draft) newSessionCommands.delete(input.id); });
          newSessionCommands.set(input.id, command);
        }
        const conversationId = await command;
        json(res, 201, { ok: true, conversationId }); return true;
      }
      if (!input.editMessageId && !input.assets.length && isNotionAuthorizationRequest(input.text, "notion")) {
        // Resolve an omitted service only for a connection command, using compact history.
        const previousService = /notion/i.test(input.text) ? "notion" : store.messages(id, Number.MAX_SAFE_INTEGER, 100, true)
          .flatMap(message => message.interactions ?? []).filter(item => item.kind === "authorization").at(-1)?.service;
        if (isNotionAuthorizationRequest(input.text, previousService)) {
          store.save({ id: input.id, conversationId: id, role: "user", text: input.text.trim(), assets: [], createdAt: Date.now() });
          authorizations.redisplay("notion", id);
          json(res, 202, { ok: true, conversationId: input.conversationId }); return true;
        }
      }
      const conversation = store.conversationInfo(id)!;
      const chatId = conversation.chatId;
      const model = coordinator.selectedModel(id);
      const reasoningEfforts = coordinator.currentReasoningEfforts();
      const pendingEdit = store.pendingEdit(chatId);
      const recoverEdit = pendingEdit?.conversation_id === id && pendingEdit.message_id === input.editMessageId;
      const replacingQuestion = !input.editMessageId && coordinator.activeConversation(chatId) === id && store.hasPendingQuestion(id);
      if (coordinator.changing(chatId) || input.editMessageId && (coordinator.hasActive(chatId) ? coordinator.activeConversation(chatId) !== id : coordinator.atCapacity()) || pendingEdit && pendingEdit.request_id !== input.id && !recoverEdit) {
        json(res, 409, { error: pendingEdit ? "请先重试刚才编辑的消息。" : "正在处理消息，请等回复完成后再发送。" }); return true;
      }
      const images: ReferenceImage[] = input.assets.flatMap(imageKey => {
        const mime = store.assetMime(imageKey);
        if (mime === undefined) throw new Error("FILE_NOT_FOUND");
        if (!mime.startsWith("image/")) {
          if (!store.documentMetadata([imageKey])[imageKey]) throw new Error("FILE_NOT_FOUND");
          return [];
        }
        // Ordinary queued messages load images once at dispatch, not during admission.
        if (!input.editMessageId) return [];
        const asset = store.asset(imageKey);
        if (!asset) throw new Error("FILE_NOT_FOUND");
        return [{ data: Buffer.from(asset.bytes), mimeType: asset.mime, source: { provider: "web" as const, messageId: input.id, imageKey } }];
      });
      if (!input.editMessageId) {
        if (store.queuedMessages(id).length >= 20) { json(res, 429, { error: "等待消息已满，请处理后再发送。" }); return true; }
        const message: QueuedWebMessage = { id: input.id, conversationId: id, text: input.text.trim(), assets: input.assets,
          createdAt: Date.now(), model, reasoningEfforts, status: "queued" };
        store.saveQueuedMessage(message);
        if (replacingQuestion || !coordinator.isBusy(chatId) && !coordinator.atCapacity() && store.queuedMessages(id)[0]?.id === message.id) coordinator.dispatchQueuedMessage(message);
        json(res, 202, { ok: true, queued: store.queuedMessage(input.id)?.status === "queued", conversationId: input.conversationId }); return true;
      }
      coordinator.beginChange(chatId);
      try {
        // Keep the queue blocked until cancellation and both history rewinds finish.
        await coordinator.stopReply(chatId);
        coordinator.reserve(chatId, id, input.id);
        if (input.editMessageId) {
          if (!conversation.sessionId) throw new Error("Edit context unavailable");
          if (!editRequest && recoverEdit) {
            // A refreshed page can retry the same edit without retaining its original request ID.
            store.updatePendingEdit(pendingEdit!.request_id,payloadKey,input.id);
            editRequest = store.editRequest(input.id)!;
          }
          if (!editRequest) {
            const session = await runtime.memory.getSession(conversation.sessionId);
            const boundary = session.messages.find(message => message.role === "user" &&
              (message.messageId === input.editMessageId || `history:${store.publicId(message.id)}` === input.editMessageId));
            if (!boundary) throw new Error("Edit point unavailable");
            store.prepareEdit(input.id, id, input.editMessageId, session.id, boundary.turnId, payloadKey);
            editRequest = store.editRequest(input.id)!;
          }
          store.updatePendingEdit(input.id,payloadKey);
          await runtime.memory.rewindSession(owner, editRequest.session_id, editRequest.from_turn);
        }
        const message = { id: input.id, conversationId: id, role: "user" as const, text: input.text.trim(), assets: input.assets, createdAt: Date.now() };
        if (input.editMessageId) store.saveEdit(message); else store.save(message);
      } catch {
        coordinator.release(chatId); coordinator.endChange(chatId); store.emit("change");
        json(res, 409, { error: "这次修改未完成，请保留内容并重试发送。" }); return true;
      }
      coordinator.startEditedReply({ conversationId: id, messageId: input.id, text: input.text.trim(), images, model, reasoningEfforts }, conversation);
      json(res, 202, { ok: true, conversationId: input.conversationId }); return true;
    }
    return false;
  };
  return Object.assign(handle, { page });
}
