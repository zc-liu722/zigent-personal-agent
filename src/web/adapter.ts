import { activityStructure, type AgentActivityUpdate } from "../agent/transcript.js";
import type { WebMessageOperation } from "./message-operations.js";
import { randomUUID } from "node:crypto";
import type { CommunicationAdapter, ModelFallbackNotice, OAuthAuthorizationNotice } from "../channels/communication.js";
import type { AgentRunChannel } from "../channels/types.js";
import type { StoredImageSource, ReferenceImage } from "../image-generation.js";
import type { Session, SessionMetadata } from "../memory/types.js";
import { WebStore, type WebMessage } from "./store.js";
import { PRODUCTIVITY_LABELS, productivityAuthorizationResultText } from "../productivity/authorization.js";
import type { ProductivityIntegration } from "../productivity/config.js";
import { AUTHORIZATION_SERVICES, authorizationInteraction, modelFallbackInteraction, operationInteraction, questionInteraction, scheduleReminderInteraction, type WebAuthorizationService, type WebInteraction } from "./interactions.js";
import type { UserQuestionNotice } from "../channels/user-questions.js";
import type { OperationNotice } from "../channels/operation-confirmations.js";
import type { AuthorizationFailure } from "../productivity/authorization-failure.js";
import type { FileDeliveryNotice } from "../file-workbench/delivery.js";
import { conversationOutputSchema } from "../channels/output.js";

export class WebCommunicationAdapter implements CommunicationAdapter {
  private readonly selectedConversations = new Map<string, string>();
  private readonly replyTargets = new Map<string, string>();
  private readonly activeReplies = new Map<string, { id: string; current: () => WebMessage; save: () => void; update: (interactions:WebInteraction[])=>void }>();
  constructor(readonly store: WebStore) {}
  close(): void {
    for (const reply of this.activeReplies.values()) reply.save();
    this.activeReplies.clear();
  }
  selectConversation(chatId: string, id: string, replyTo?: string): void {
    this.selectedConversations.set(chatId, id);
    if (replyTo) this.replyTargets.set(chatId, replyTo); else this.replyTargets.delete(chatId);
  }
  resolveConversation(chatId: string): string { return this.selectedConversations.get(chatId) ?? (this.store.hasConversation(chatId) ? chatId : this.store.conversationForChat(chatId)); }
  private conversation(chatId: string): string { return this.resolveConversation(chatId); }
  /** One durable message save for the entire validated batch, including its operation state. */
  async deliverFiles({delivery,outputs}: FileDeliveryNotice): Promise<void> {
    const active = [...this.activeReplies.values()].find(item=>item.id===delivery.replyId);
    const message = active?.current() ?? this.store.message(delivery.replyId);
    if (!message || message.role !== "assistant") throw new Error("文件交付回复不存在。");
    let interactions = [...(message.interactions ?? [])];
    const operationId = `file-delivery:${delivery.id}`;
    if (delivery.status === "delivered") {
      if (interactions.some(item=>item.fileDelivery && item.fileDelivery.sequence>delivery.sequence)) throw new Error("FILE_DELIVERY_SUPERSEDED");
      const previous = interactions.filter(item=>item.kind==="output" && item.output?.blocks.every(block=>block.type==="artifact"));
      const additions = outputs.map(output=>{
        const block = output.blocks[0]!;
        const matches = previous.filter(item=>item.output?.id===output.id
          || item.output?.blocks.some(candidate=>candidate.type==="artifact" && block.type==="artifact" && candidate.fileId===block.fileId));
        const old = matches[0];
        if (old?.fileDelivery && old.fileDelivery.createdAt > delivery.createdAt) throw new Error("FILE_DELIVERY_SUPERSEDED");
        const oldBlock = old?.output?.blocks[0];
        if (block.type==="artifact" && oldBlock?.type==="artifact") {
          if (oldBlock.fileId!==block.fileId) throw new Error("成果标识已属于另一个文件。");
          const history = matches.flatMap(item=>item.output!.blocks.flatMap(candidate=>candidate.type==="artifact" && candidate.fileId===block.fileId
            ? [...(candidate.previousVersions ?? []),{versionId:candidate.versionId,filename:candidate.filename,size:candidate.size}] : []));
          block.previousVersions = [...new Map(history.filter(item=>item.versionId!==block.versionId).map(item=>[item.versionId,item])).values()].slice(-100);
        }
        return {id:`output:${output.id}`,kind:"output" as const,title:output.title,status:"completed" as const,actions:[],output,
          fileDelivery:{id:delivery.id,createdAt:delivery.createdAt,sequence:delivery.sequence}};
      });
      additions.forEach(item=>conversationOutputSchema.parse(item.output));
      const replacing = new Set(additions.map(item=>item.id));
      const fileIds = new Set(outputs.flatMap(output=>output.blocks.flatMap(block=>block.type==="artifact"?[block.fileId]:[])));
      // Only this reply's new delivery slots, or reliable legacy file identities, are replaced.
      interactions = interactions.filter(item=>!replacing.has(item.id) && !item.fileDelivery
        && !(item.output?.blocks.every(block=>block.type==="artifact" && fileIds.has(block.fileId)))
        && !item.actions.some(action=>action.kind==="submit" && action.value.type==="file-delivery-retry"));
      interactions.push(...additions);
    } else if (delivery.status === "superseded") {
      interactions = interactions.filter(item=>item.id!==operationId);
    } else {
      interactions = interactions.filter(item=>item.id!==operationId);
      interactions.push({id:operationId,kind:"actions",title:"交付文件",status:"failed",statusMessage:"文件已保存，交付失败。",
        actions:[{id:"retry",kind:"submit",label:"重试交付",value:{type:"file-delivery-retry",deliveryId:delivery.id}}]});
    }
    if (active) active.update(interactions);
    else {
      const delivered=delivery.status==="delivered" && message.text==="文件已保存，交付尚未完成，请使用重试交付。";
      const text=delivered?"文件已交付。":message.text;
      const snapshot=delivered && message.snapshot?{...message.snapshot,answerDraft:text,items:message.snapshot.items.map(item=>
        item.type==="response" && item.text===message.text?{...item,text}:item)}:message.snapshot;
      this.store.save({...message,text,snapshot,interactions});
    }
  }
  async sendUserQuestion(notice: UserQuestionNotice): Promise<{ messageId: string }> {
    const messageId = notice.messageId ?? `question:${notice.id}`;
    const previous = this.store.message(messageId);
    const conversationId = previous?.conversationId ?? this.store.conversationForSessionId(notice.sessionId)
      ?? this.resolveConversation(notice.conversationId);
    const interaction = questionInteraction(notice);
    interaction.placement = previous?.interactions?.find(item => item.id === notice.id)?.placement;
    if (!previous && !interaction.placement) {
      const active = this.activeReplies.get(conversationId);
      const checkpoint = active?.current().snapshot?.items.find(item => item.type === "tool"
        && item.name === (notice.purpose === "workspace" ? "workspaces" : "ask_user_question") && item.status === "running");
      if (active && checkpoint) {
        // Publish the parent checkpoint before its form, including throttled activity.
        active.save(); interaction.placement = { messageId: active.id, activityId: checkpoint.id };
      }
    }
    this.interaction(conversationId, interaction, messageId);
    return { messageId };
  }
  async sendOperationConfirmation(notice: OperationNotice): Promise<{ messageId: string }> {
    const messageId = notice.messageId ?? `operation:${notice.id}`;
    const previous = this.store.message(messageId);
    // Pin to the original web conversation even when the selected topic changes.
    const conversationId = previous?.conversationId ?? (notice.sessionId ? this.store.conversationForSessionId(notice.sessionId) : undefined) ?? this.resolveConversation(notice.conversationId);
    this.interaction(conversationId, operationInteraction(notice), messageId);
    return { messageId };
  }
  /** The caller supplies an already resolved session ID, so async results cannot drift to a newer session. */
  interaction(conversationId: string, interaction: WebInteraction, id: string = randomUUID()): void {
    const previous = this.store.message(id);
    const interactions = previous?.interactions?.filter(item => item.id !== interaction.id) ?? [];
    const index = previous?.interactions?.findIndex(item => item.id === interaction.id) ?? -1;
    interactions.splice(index < 0 ? interactions.length : index, 0, interaction);
    this.store.save({ ...previous, id, conversationId, role: "notice", text: previous?.text ?? "", createdAt: previous?.createdAt ?? Date.now(), interactions });
  }
  createRunChannel(conversationId: string): AgentRunChannel {
    const replyTo = this.replyTargets.get(conversationId);
    conversationId = this.conversation(conversationId);
    let message: WebMessage = { id: randomUUID(), conversationId, replyTo, role: "assistant", text: "", createdAt: Date.now() };
    const request = replyTo ? this.store.message(replyTo) : undefined;
    // The visible user message is timestamped at dispatch; the queue retains acceptance time.
    const queued = replyTo ? this.store.queuedMessage(replyTo) : undefined;
    const acceptedAt = queued?.conversationId === conversationId ? queued.createdAt
      : request?.role === "user" && request.conversationId === conversationId ? request.createdAt : undefined;
    const elapsedBeforeRun = acceptedAt === undefined ? undefined : Math.max(0, message.createdAt - acceptedAt);
    const runStarted = performance.now();
    let timer: NodeJS.Timeout | undefined;
    let checkpointTimer: NodeJS.Timeout | undefined;
    let terminal = false;
    let operationSource = true;
    let structure: string | undefined;
    let pendingSnapshot: AgentActivityUpdate["snapshot"] | undefined;
    let pendingOperations: WebMessageOperation[] = [];
    const appendPositions = new Map<string, number>();
    const visibleTextItems = new Set<string>();
    let firstVisiblePublished = false;
    const containsFirstVisibleText = (operations: readonly WebMessageOperation[]) => {
      let visible = false;
      for (const operation of operations) {
        if (operation.type === "add_item" || operation.type === "replace_item") {
          const item = operation.item;
          if (item.type === "response" || item.type === "commentary") {
            visibleTextItems.add(item.id);
            visible ||= Boolean(item.text.trim());
          } else visibleTextItems.delete(item.id);
        } else if (operation.type === "remove_item") visibleTextItems.delete(operation.id);
        else if (operation.type === "append_text" && visibleTextItems.has(operation.id)) visible ||= Boolean(operation.text.trim());
        else if (operation.type === "append_answer" || operation.type === "set_answer") visible ||= Boolean(operation.text.trim());
      }
      return visible;
    };
    const enqueue = (operations: readonly WebMessageOperation[]) => {
      for (const operation of operations) {
        const key = operation.type === "append_text" ? operation.id : operation.type === "append_answer" ? "answer" : undefined;
        if (key === undefined) { appendPositions.clear(); pendingOperations.push(operation); continue; }
        const index = appendPositions.get(`${operation.type}:${key}`), previous = index === undefined ? undefined : pendingOperations[index];
        if (previous?.type === operation.type && "text" in previous && "text" in operation) previous.text += operation.text;
        else { appendPositions.set(`${operation.type}:${key}`, pendingOperations.length); pendingOperations.push({ ...operation }); }
      }
    };
    const finishTiming = () => {
      if (message.replyDurationMs !== undefined || elapsedBeforeRun === undefined) return;
      message.replyDurationMs = Math.round(elapsedBeforeRun + Math.max(0, performance.now() - runStarted));
      if (operationSource) enqueue([{ type: "update_message", fields: { replyDurationMs: message.replyDurationMs } }]);
    };
    const current = () => {
      if (pendingSnapshot) {
        const snapshot = pendingSnapshot();
        pendingSnapshot = undefined;
        message = { ...message, snapshot, text: snapshot.answerDraft };
      }
      return message;
    };
    const flush = () => {
      if (timer) clearTimeout(timer); timer = undefined;
      if (!pendingOperations.length) return;
      const operations = pendingOperations; pendingOperations = []; appendPositions.clear();
      this.store.publishOperations(message, operations, () => { flush(); return current(); });
    };
    const release = () => { if (this.activeReplies.get(conversationId)?.id === message.id) this.activeReplies.delete(conversationId); };
    const save = (full = false) => {
      flush();
      if (checkpointTimer) clearTimeout(checkpointTimer); checkpointTimer = undefined;
      this.store.save(current(), full);
      if (message.snapshot && message.snapshot.status !== "running") release();
    };
    const updateActivitySource = async (update: AgentActivityUpdate) => {
      if (terminal) return;
      const operationPath = operationSource = update.operations !== undefined;
      const checkpoint = update.status !== "running" || (operationPath ? update.checkpoint : structure !== update.structure);
      if (!operationPath) structure = update.structure;
      pendingSnapshot = update.snapshot;
      if (operationPath) enqueue(update.operations!);
      let firstVisible = false;
      if (!firstVisiblePublished) {
        if (operationPath) firstVisible = containsFirstVisibleText(update.operations!);
        else {
          const snapshot = current().snapshot;
          firstVisible = Boolean(snapshot?.answerDraft.trim() || snapshot?.items.some(item =>
            (item.type === "response" || item.type === "commentary") && item.text.trim()));
        }
      }
      if (firstVisible) { firstVisiblePublished = true; visibleTextItems.clear(); }
      if (update.status !== "running") { terminal = true; finishTiming(); }
      if (checkpoint) save(!operationPath);
      else {
        if (firstVisible) {
          if (operationPath) flush();
          else { if (timer) clearTimeout(timer); timer = undefined; this.store.publish(current()); }
        }
        else if (!timer) { timer = setTimeout(() => { timer = undefined; if (operationPath) flush(); else this.store.publish(current()); }, 200); timer.unref(); }
        if (!checkpointTimer) { checkpointTimer = setTimeout(() => { checkpointTimer = undefined; save(!operationPath); }, 1000); checkpointTimer.unref(); }
      }
    };
    const updateMessage = (fields: Extract<WebMessageOperation, { type: "update_message" }>["fields"]) => {
      message = { ...current(), ...fields };
      if (operationSource) enqueue([{ type: "update_message", fields }]);
      save(!operationSource);
    };
    this.activeReplies.set(conversationId, { id: message.id, current, save: () => save(), update:interactions=>updateMessage({interactions}) });
    return {
      replyId: message.id,
      openActivity: async snapshot => {
        pendingSnapshot = undefined;
        structure = activityStructure(snapshot.items);
        message = { ...message, snapshot, text: snapshot.answerDraft }; save(true);
      },
      updateActivity: async snapshot => updateActivitySource({
        status: snapshot.status, structure: activityStructure(snapshot.items), snapshot: () => snapshot
      }),
      updateActivitySource,
      sendFinalReply: async text => { terminal = true; finishTiming(); updateMessage({ text }); release(); },
      sendOutput: async output => {
        const interaction: WebInteraction = { id: `output:${output.id}`, kind: "output", title: output.title,
          status: "completed", actions: [], output };
        const items = [...(message.interactions ?? [])], index = items.findIndex(item => item.id === interaction.id);
        if (index < 0) {
          const files = output.blocks.every(block=>block.type==="artifact");
          if (items.filter(item => item.kind === "output" && Boolean(item.output?.blocks.every(block=>block.type==="artifact"))===files).length >= (files?100:6)) throw new Error("Too many outputs in this reply");
          items.push(interaction);
        } else items[index] = interaction;
        updateMessage({ interactions: items });
      },
      sendFailure: async text => { terminal = true; finishTiming(); updateMessage({ text }); release(); },
      sendImages: async images => {
        const deliveries = images.map(image => {
          const imageKey = this.store.addAsset(image.data, image.mimeType);
          message.assets = [...(message.assets ?? []), imageKey];
          return { provider: "web" as const, messageId: message.id, imageKey,
            generationId: image.generationId, sha256: image.sha256, experimentId: image.experimentId,
            variant: image.variant, ordinal: image.ordinal };
        });
        updateMessage({ assets: message.assets }); return deliveries;
      },
      sendVideos: async videos => {
        current();
        for (const video of videos) {
          if (video.data) message.assets = [...(message.assets ?? []), this.store.addAsset(video.data, video.mimeType)];
          else if (video.url && /^https:\/\//i.test(video.url)) message.text += `\n\n[下载视频](${video.url})`;
        }
        updateMessage({ text: message.text, assets: message.assets });
      }
    };
  }
  async prepareBackgroundSession(session: Session): Promise<void> {
    if (session.userId !== this.store.owner) throw new Error("WEB_OWNER_MISMATCH");
    this.store.conversationForSession(session);
  }
  async readImage(source: StoredImageSource): Promise<ReferenceImage> {
    const asset = this.store.asset(source.imageKey);
    if (!asset || !asset.mime.startsWith("image/")) throw new Error("IMAGE_NOT_FOUND");
    return { data: Buffer.from(asset.bytes), mimeType: asset.mime, source };
  }
  async sendBackgroundResult(notice: { userId?: string; conversationId: string; idempotencyKey: string; title: string; text: string; replyDurationMs?: number; scheduleReminder?: import("../channels/change-preview.js").CalendarPreviewState; snapshot?: import("../agent/transcript.js").AgentRunSnapshot; session?: Session }): Promise<{ messageId: string }> {
    if (notice.userId && notice.userId !== this.store.owner || notice.session && notice.session.userId !== this.store.owner) throw new Error("WEB_OWNER_MISMATCH");
    const id = `background:${notice.idempotencyKey}`;
    const existing = this.store.message(id);
    if (existing && !existing.taskTitle) this.store.save({ ...existing, taskTitle: notice.title });
    if (!existing) this.store.save({ id,
      conversationId: notice.session ? this.store.conversationForSession(notice.session) : this.conversation(notice.conversationId),
      text: notice.text, snapshot: notice.snapshot, replyDurationMs: notice.replyDurationMs,
      ...(notice.scheduleReminder ? { interactions: [scheduleReminderInteraction(notice.idempotencyKey, notice.scheduleReminder)] } : {}), taskTitle: notice.title, role: "assistant", createdAt: Date.now() });
    return { messageId: id };
  }
  async sendSessionEnded(_session: SessionMetadata): Promise<void> { /* History remains available in the sidebar. */ }
  async sendModelFallback(notice: ModelFallbackNotice): Promise<void> {
    const interaction = modelFallbackInteraction(notice);
    this.store.save({ id: notice.requestId, conversationId: this.conversation(notice.conversationId), role: "notice", createdAt: Date.now(),
      text: interaction.description!,
      action: { type: "model-fallback", requestId: notice.requestId },
      interactions: [interaction] });
  }
  async sendStandaloneFailure(conversationId: string, text: string): Promise<void> { await this.notice(conversationId, text); }
  async notice(conversationId: string, text: string, action?: unknown): Promise<void> {
    this.store.save({ id: randomUUID(), conversationId: this.conversation(conversationId), role: "notice", text, action, createdAt: Date.now() });
  }
  async sendXmindAuthorization(notice: OAuthAuthorizationNotice): Promise<void> { await this.authorization(notice, "XMind"); }
  async sendNotionAuthorization(notice: OAuthAuthorizationNotice): Promise<void> { await this.authorization(notice, "Notion"); }
  async sendProductivityAuthorization(notice: OAuthAuthorizationNotice & { service: ProductivityIntegration }): Promise<void> {
    await this.authorization(notice, PRODUCTIVITY_LABELS[notice.service]);
  }
  async sendProductivityAuthorizationResult(conversationId: string, service: ProductivityIntegration, authorized: boolean, failure?: AuthorizationFailure): Promise<void> {
    const target = this.conversation(conversationId);
    const pending = this.store.messages(target).filter(message => message.interactions?.some(interaction => interaction.service === service && interaction.status === "pending"));
    for (const message of pending) this.interaction(target, authorizationInteraction(message.interactions![0]!.id, service, authorized ? "completed" : "failed",
      undefined, productivityAuthorizationResultText(service, authorized, failure)), message.id);
    if (!pending.length) this.interaction(target, authorizationInteraction(randomUUID(), service, authorized ? "completed" : "failed",
      undefined, productivityAuthorizationResultText(service, authorized, failure)));
  }
  async authorization(notice: OAuthAuthorizationNotice, name: string): Promise<void> {
    const service = (Object.keys(AUTHORIZATION_SERVICES) as WebAuthorizationService[]).find(service => AUTHORIZATION_SERVICES[service].label === name);
    if (!service) throw new Error("Unknown authorization service");
    this.interaction(this.conversation(notice.conversationId), authorizationInteraction(randomUUID(), service, "pending", notice));
  }
}
