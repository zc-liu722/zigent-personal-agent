import { prepareSql } from "../sqlite.js";
import { createHash, randomUUID } from "node:crypto";
import { MemoryConflictError, previewMemoryChanges, type MemoryChangeRequest, type EditableMemory } from "../memory/changes.js";
import { memoryDocuments, documentContent, documentDefinition, validateMemoryDocument, archiveDocumentId, type MemoryDocumentTarget } from "../memory/documents.js";
import type { WebDocument, DocumentResult } from "./documents.js";
import type { AgentRuntime } from "../runtime.js";
import type { WebInteraction } from "./interactions.js";
import type { WebStore } from "./store.js";

type SavedProposal = { request: MemoryChangeRequest; userId: string; principalId: string; expiresAt: number; viewOnly?: boolean };
type ProposalRow = { id: string; conversation_id: string; message_id: string; payload: string };

/** The model can offer a draft; only the authenticated UI action can call the repository writer. */
export class WebMemoryProposals {
  private readonly inFlight = new Set<string>();
  constructor(private readonly store: WebStore, private readonly runtime: Pick<AgentRuntime, "config" | "tools" | "longTermMemory">) {}

  private available(): boolean {
    return this.runtime.config.channel === "web"
      && this.runtime.config.web?.ownerUserId === this.store.owner && Boolean(this.runtime.config.web.ownerPrincipalId)
      && Boolean(this.runtime.longTermMemory) && this.runtime.tools.allows("long_term_memory");
  }
  private actions(id: string, retry = false): WebInteraction["actions"] {
    return [true, false].map(confirm => ({ id: confirm ? "confirm" : "cancel", kind: "submit",
      label: confirm ? retry ? "重试保存" : "确认保存" : "取消", value: { type: "memory-proposal", proposalId: id, confirm } }));
  }

  async accountDocuments() {
    if (!this.available()) return;
    return memoryDocuments(await this.runtime.longTermMemory!.editableSnapshot(this.store.owner));
  }

  private proposalDocuments(memory: EditableMemory, request: MemoryChangeRequest) {
    return [...new Set(request.changes.map(change => change.target === "archiveMemory" ? archiveDocumentId(change.title!) : change.target))]
      .flatMap(id => { const definition = documentDefinition(memory, id); return definition ? [definition] : []; });
  }

  async accountDocument(documentId: string, update?: { content: string; revision: string }): Promise<DocumentResult> {
    if (!this.available()) return { code: 404, error: "记忆文件不可用。" };
    const current = await this.runtime.longTermMemory!.editableSnapshot(this.store.owner);
    if (!documentDefinition(current, documentId)) return { code: 404, error: "记忆文件不可用。" };
    const target = documentId as MemoryDocumentTarget, key = "account:" + target;
    if (update) {
      try { validateMemoryDocument(documentId, update.content); }
      catch (error) { return { code: 400, error: (error as Error).message }; }
    }
    if (update && this.inFlight.has(key)) return { code: 409, error: "正在保存，请稍候。" };
    if (update) this.inFlight.add(key);
    try {
      if (update) {
        await this.runtime.longTermMemory!.saveConfirmedDocument(this.store.owner, target, update.revision, update.content);
      }
      const snapshot = await this.runtime.longTermMemory!.editableSnapshot(this.store.owner);
      return { code: 200, document: { ...documentDefinition(snapshot, target)!, content: documentContent(snapshot, target), revision: snapshot.revision, editable: true, pending: false } };
    } catch (error) {
      if (error instanceof MemoryConflictError) return { code: 409, error: "记忆已有变化，请重新加载后再保存。" };
      return { code: 503, error: update ? "记忆暂未能保存，请保留编辑内容后重试。" : "记忆暂时无法加载，请重试。" };
    } finally { if (update) this.inFlight.delete(key); }
  }

  async offer(request: MemoryChangeRequest, conversationId: string, turnKey: string): Promise<{ proposalId: string }> {
    if (!this.available() || !this.store.conversationInfo(conversationId)) throw new Error("Memory confirmation is unavailable");
    const userId = this.store.owner, principalId = this.runtime.config.web!.ownerPrincipalId!;
    const snapshot = await this.runtime.longTermMemory!.editableSnapshot(userId);
    const { preview, next } = previewMemoryChanges(snapshot, request);
    const key = createHash("sha256").update(JSON.stringify([userId, principalId, conversationId, turnKey, request])).digest("hex");
    const prior = prepareSql(this.store.db, "SELECT * FROM memory_proposals WHERE proposal_key=?").get(key) as ProposalRow | undefined;
    const id = prior?.id ?? randomUUID(), messageId = prior?.message_id ?? randomUUID();
    const saved: SavedProposal = prior ? JSON.parse(prior.payload) : { request, userId, principalId, expiresAt: Date.now() + 24 * 60 * 60_000 };
    if (!prior) prepareSql(this.store.db, "INSERT INTO memory_proposals(id,proposal_key,conversation_id,message_id,payload) VALUES(?,?,?,?,?)")
      .run(id, key, conversationId, messageId, JSON.stringify(saved));
    if (!this.store.message(messageId)) this.store.save({ id: messageId, conversationId, role: "notice", text: "", createdAt: Date.now(), interactions: [{
      id, kind: "memory-proposal", title: request.changes.every(change => change.target === "archiveMemory") ? "更新存档记忆" : "更新长期记忆", status: "pending", expiresAt: saved.expiresAt, memoryChanges: preview,
      documents: this.proposalDocuments(next, request),
      statusMessage: "以下内容尚未保存，所有新增、修改和删除都等你确认。", actions: this.actions(id)
    }] });
    return { proposalId: id };
  }

  async offerDocuments(conversationId: string, turnKey: string): Promise<{ proposalId: string }> {
    if (!this.available() || !this.store.conversationInfo(conversationId)) throw new Error("Memory documents are unavailable");
    const userId = this.store.owner, principalId = this.runtime.config.web!.ownerPrincipalId!;
    const key = createHash("sha256").update(JSON.stringify([userId, principalId, conversationId, turnKey, "documents"])).digest("hex");
    const prior = prepareSql(this.store.db, "SELECT * FROM memory_proposals WHERE proposal_key=?").get(key) as ProposalRow | undefined;
    const id = prior?.id ?? randomUUID(), messageId = prior?.message_id ?? randomUUID();
    if (!prior) {
      const snapshot = await this.runtime.longTermMemory!.editableSnapshot(userId);
      const saved: SavedProposal = { userId, principalId, viewOnly: true, expiresAt: 0,
        request: { format: "markdown-v1", expectedRevision: snapshot.revision, changes: [] } };
      prepareSql(this.store.db, "INSERT INTO memory_proposals(id,proposal_key,conversation_id,message_id,payload) VALUES(?,?,?,?,?)")
        .run(id, key, conversationId, messageId, JSON.stringify(saved));
    }
    if (!this.store.message(messageId)) this.store.save({ id: messageId, conversationId, role: "notice", text: "", createdAt: Date.now(), interactions: [{
      id, kind: "memory-proposal", memoryDocumentView: true, title: "长期记忆文件", status: "completed", actions: [],
      documents: memoryDocuments(await this.runtime.longTermMemory!.editableSnapshot(userId)), statusMessage: "打开文件可以查看或修改，保存后生效。"
    }] });
    return { proposalId: id };
  }

  private documentScope(conversationId: string, messageId: string, interactionId: string, documentId: string) {
    if (!this.available() || !["longTermMemory", "behaviorRules"].includes(documentId) && !/^archive-[a-f0-9]{24}$/.test(documentId)) return;
    const row = prepareSql(this.store.db, "SELECT * FROM memory_proposals WHERE id=?").get(interactionId) as ProposalRow | undefined;
    const message = this.store.message(messageId), interaction = message?.interactions?.find(item => item.id === interactionId);
    if (!row || row.conversation_id !== conversationId || row.message_id !== messageId || message?.conversationId !== conversationId
      || interaction?.kind !== "memory-proposal") return;
    const saved = JSON.parse(row.payload) as SavedProposal;
    if (saved.userId !== this.store.owner || saved.principalId !== this.runtime.config.web?.ownerPrincipalId
      || !saved.viewOnly && !saved.request.changes.some(change => (change.target === "archiveMemory" ? archiveDocumentId(change.title!) : change.target) === documentId)) return;
    return { saved, interaction, target: documentId as MemoryDocumentTarget };
  }

  async openDocument(conversationId: string, messageId: string, interactionId: string, documentId: string): Promise<DocumentResult> {
    const scope = this.documentScope(conversationId, messageId, interactionId, documentId);
    if (!scope) return { code: 404, error: "记忆文件不可用。" };
    const snapshot = await this.runtime.longTermMemory!.editableSnapshot(scope.saved.userId);
    let memory: EditableMemory = snapshot;
    let pending = ["pending", "failed"].includes(scope.interaction.status);
    let description = "";
    if (["pending", "failed"].includes(scope.interaction.status)) {
      if (scope.saved.expiresAt <= Date.now()) return { code: 409, error: "提议已过期，请让我重新读取记忆。" };
      try { memory = previewMemoryChanges(snapshot, scope.saved.request).next; }
      catch (error) {
        if (error instanceof MemoryConflictError) {
          pending = false;
          description = `原提议核对未通过，当前显示最新文件，原提议未应用。${description}`;
        } else throw error;
      }
    }
    const definition = documentDefinition(memory, scope.target);
    if (!definition) return { code: 404, error: "记忆文件不可用。" };
    return { code: 200, document: { ...definition, content: documentContent(memory, scope.target), revision: snapshot.revision, editable: true,
      pending, description } };
  }

  async saveDocument(conversationId: string, messageId: string, interactionId: string, documentId: string, content: string, revision: string): Promise<DocumentResult> {
    const scope = this.documentScope(conversationId, messageId, interactionId, documentId);
    if (!scope) return { code: 404, error: "记忆文件不可用。" };
    if (this.inFlight.has(interactionId)) return { code: 409, error: "正在保存，请稍候。" };
    if (["pending", "failed"].includes(scope.interaction.status) && scope.saved.expiresAt <= Date.now())
      return { code: 409, error: "提议已过期，请让我重新读取记忆。" };
    this.inFlight.add(interactionId);
    try {
      try { validateMemoryDocument(documentId, content); }
      catch (error) { return { code: 400, error: (error as Error).message }; }
      // An editor opened before an upgrade must not save an unguarded old proposal.
      if (["pending", "failed"].includes(scope.interaction.status)) {
        const snapshot = await this.runtime.longTermMemory!.editableSnapshot(scope.saved.userId);
        previewMemoryChanges(snapshot, scope.saved.request);
      }
      await this.runtime.longTermMemory!.saveConfirmedDocument(scope.saved.userId, scope.target, revision, content, scope.saved.request.changes.find(change => change.target === "archiveMemory" && archiveDocumentId(change.title!) === scope.target)?.title);
      const updated = await this.runtime.longTermMemory!.editableSnapshot(scope.saved.userId);
      const definition = documentDefinition(updated, scope.target)!;
      const hasOtherTarget = scope.saved.request.changes.some(change => (change.target === "archiveMemory" ? archiveDocumentId(change.title!) : change.target) !== scope.target);
      const latest = this.store.message(messageId)!;
      this.store.save({ ...latest, interactions: latest.interactions?.map(item => item.id === interactionId ? { ...item,
        status: "completed", actions: [], memoryChanges: [],
        statusMessage: `已保存你编辑的${definition.title}。${hasOtherTarget ? "提议中的其他内容未应用。" : ""}` } : item) });
      const document: WebDocument = { ...definition, content: documentContent(updated, scope.target), revision: updated.revision, editable: true, pending: false };
      return { code: 200, document };
    } catch (error) {
      if (error instanceof MemoryConflictError) return { code: 409, error: "记忆版本或原文核对未通过，文件未保存。请重新读取记忆后发起修改。" };
      return { code: 503, error: "文件暂未能保存，请保留编辑内容后重试。" };
    } finally { this.inFlight.delete(interactionId); }
  }

  async act(conversationId: string, messageId: string, interactionId: string, proposalId: string, confirm: boolean): Promise<{ code: number; error?: string }> {
    const row = prepareSql(this.store.db, "SELECT * FROM memory_proposals WHERE id=?").get(proposalId) as ProposalRow | undefined;
    const message = this.store.message(messageId), interaction = message?.interactions?.find(item => item.id === interactionId);
    if (!row || row.conversation_id !== conversationId || row.message_id !== messageId || message?.conversationId !== conversationId
      || interactionId !== proposalId || interaction?.kind !== "memory-proposal") return { code: 404, error: "记忆提议已失效。" };
    const saved = JSON.parse(row.payload) as SavedProposal;
    if (saved.userId !== this.store.owner || saved.principalId !== this.runtime.config.web?.ownerPrincipalId) return { code: 404, error: "记忆提议已失效。" };
    if (["completed", "cancelled"].includes(interaction.status)) return { code: 200 };
    const settle = (patch: Partial<WebInteraction>) => {
      const latest = this.store.message(messageId)!;
      this.store.save({ ...latest, interactions: latest.interactions?.map(item => item.id === interactionId ? { ...item, ...patch } : item) });
    };
    if (interaction.status === "expired" || saved.expiresAt <= Date.now()) {
      settle({ status: "expired", statusMessage: "提议已过期，请让我重新读取记忆并提出变更。", actions: [] });
      return { code: 409, error: "记忆提议已过期。" };
    }
    if (this.inFlight.has(proposalId)) return { code: 409, error: "正在保存，请稍候。" };
    if (!confirm) { settle({ status: "cancelled", statusMessage: "已取消，记忆未更改。", actions: [] }); return { code: 200 }; }
    this.inFlight.add(proposalId);
    try {
      if (!this.available()) throw new Error("Memory access is unavailable");
      await this.runtime.longTermMemory!.applyConfirmedChange(saved.userId, proposalId, saved.request);
      settle({ status: "completed", statusMessage: "已按你确认的内容保存记忆。", actions: [] });
      return { code: 200 };
    } catch (error) {
      if (error instanceof MemoryConflictError) {
        settle({ status: "expired", statusMessage: "记忆版本或原文核对未通过，这份提议未保存。请让我重新读取后提出变更。", actions: [] });
        return { code: 409, error: "记忆版本或原文核对未通过，需要重新读取并确认。" };
      }
      settle({ status: "failed", statusMessage: "暂未能确认保存结果，可以重试同一提议。", actions: this.actions(proposalId, true) });
      return { code: 200 };
    } finally { this.inFlight.delete(proposalId); }
  }
}
