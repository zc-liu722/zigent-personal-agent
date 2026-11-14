import { z } from "zod";
import type { AgentInteractionController } from "../../agent/interaction-controller.js";
import { userQuestionAnswersSchema, validateUserQuestionAnswers } from "../../channels/user-questions.js";
import { codexEditsSchema } from "../../codex/confirmation.js";
import type { CodexSupervisor } from "../../codex/supervisor.js";
import type { AgentRuntime } from "../../runtime.js";
import type { WebCommunicationAdapter } from "../adapter.js";
import type { WebAuthorizationInteractions } from "../authorization.js";
import type { WebBrowser } from "../browser.js";
import { codexInteraction } from "../codex.js";
import type { ConversationCoordinator } from "../conversation-coordinator.js";
import type { WebInteraction, WebInteractionValue } from "../interactions.js";
import { authorizationSetupRequiredText } from "../interactions.js";
import type { WebMemoryProposals } from "../memory-proposals.js";
import type { QueuedWebMessage, WebStore } from "../store.js";
import type { WebTaskProposals } from "../task-proposals.js";

import { data, json, type WebRoute } from "../http.js";

export function createInteractionsRoutes({ store, runtime, owner, coordinator, controller, communication, browsers, codex, memoryProposals, taskProposals, authorizations, tasks, meetings }: {
  meetings: import("../meetings.js").WebMeetings;
  store: WebStore;
  runtime: AgentRuntime;
  owner: string;
  coordinator: ConversationCoordinator;
  controller: AgentInteractionController;
  communication: WebCommunicationAdapter;
  browsers: WebBrowser | undefined;
  codex: CodexSupervisor | undefined;
  memoryProposals: WebMemoryProposals;
  taskProposals: WebTaskProposals;
  authorizations: WebAuthorizationInteractions;
  tasks: Set<Promise<unknown>>;
}): WebRoute {
  const handle: WebRoute = async ({ req, res, url, route, credential }) => {
    if ((route === "api/action" || route === "api/interactions") && req.method === "POST") {
      let id: string | undefined, notice: ReturnType<WebStore["message"]>, value: WebInteractionValue, interaction: WebInteraction | undefined;
      if (route === "api/interactions") {
        const input = z.object({ conversationId: z.string().max(128), messageId: z.string().max(128), interactionId: z.string().max(128), actionId: z.string().max(128),
          codexEdits: codexEditsSchema.optional(), answers: userQuestionAnswersSchema.optional()
        }).strict().parse(await data(req));
        id = store.resolveConversation(input.conversationId); notice = store.message(input.messageId);
        interaction = notice?.interactions?.find(item => item.id === input.interactionId);
        const action = interaction?.actions.find(action => action.id === input.actionId);
        if (id && notice?.conversationId === id && interaction?.kind === "authorization" && interaction.service === "feishu"
          && !action && /^(?:retry|switch)(?::[a-f0-9-]{36}:(?:pending|failed|expired|completed))?$/.test(input.actionId)) {
          // Duplicate or stale card submission. Return the saved state without starting another attempt.
          json(res, 202, { ok: true, interaction }); return true;
        }
        if (!id || notice?.conversationId !== id || !interaction || action?.kind !== "submit") { json(res, 404, { error: "交互请求已失效。" }); return true; }
        value = action.value;
        if (value.type === "meeting") {
          if (interaction.kind !== "meeting" || interaction.id !== value.id) { json(res,404,{error:"会议已失效。"}); return true; }
          try {
            if(value.action==="accept"){
              const pending=meetings.action(value.id,id,value.action).catch(()=>{});tasks.add(pending);void pending.finally(()=>tasks.delete(pending));
              json(res,202,{ok:true});
            }else{await meetings.action(value.id,id,value.action);json(res,200,{ok:true,...(value.action==="join"?{mediaTransport:meetings.mediaTransport()}:{})});}
          } catch { json(res,409,{error:"会议状态已更新，请刷新。"}); }
          return true;
        }
        if (value.type === "deployment-retry") { json(res, 404, { error: "部署卡片不可用。" }); return true; }
        if (value.type === "file-delivery-retry") {
          const deliveries = runtime.fileWorkbench?.deliveries;
          if (!deliveries) { json(res,503,{error:"文件交付暂不可用。"}); return true; }
          const delivery = deliveries.get(value.deliveryId);
          if (delivery.replyId !== notice.id || interaction.id !== `file-delivery:${delivery.id}`) { json(res,404,{error:"交付请求已失效。"}); return true; }
          const result = await deliveries.retry(delivery.id);
          json(res,result.status==="delivered"?200:409,result); return true;
        }
        if (value.type === "audio-transcription") {
          if (interaction.id !== `audio:${value.messageId}` || !["failed", "cancelled"].includes(interaction.status)) {
            json(res, 409, { error: "转录状态已更新，请刷新后重试。" }); return true;
          }
          if (!coordinator.retryTranscription(id, value.messageId)) { json(res, 409, { error: "请等待当前回复完成后重试。" }); return true; }
          json(res, 202, { ok: true }); return true;
        }
        if (value.type === "browser-control") {
          if (!browsers || interaction.kind !== "browser" || interaction.id !== "browser:" + value.browserId) { json(res, 404, { error: "浏览器不可用" }); return true; }
          try { await browsers.interaction(input.conversationId, value, credential); json(res, 200, { ok: true }); }
          catch { json(res, 409, { error: "浏览器状态已变化，请刷新后重试" }); }
          return true;
        }
        if (value.type === "codex-task") {
          if (!runtime.codex || interaction.id !== "codex:" + value.taskId) { json(res, 404, { error: "任务不可用。" }); return true; }
          const scope = { agentId: runtime.config.id, userId: owner, conversationKind: "p2p" as const };
          const task = runtime.codex.store.owned(scope, value.taskId);
          if (store.conversationForSessionId(task.sessionId) !== id) { json(res, 409, { error: "任务状态已更新，请重试。" }); return true; }
          if (value.action !== "interrupt") { json(res, 409, { error: "请重新确认要发送的消息。" }); return true; }
          // Progress revisions never revoke the owner's request to stop this
          // exact task UUID. A completed turn cannot become a new task in place.
          const reviewing = task.review && ["pending", "running", "continued"].includes(task.review.state);
          const finished = ["succeeded", "cancelled"].includes(task.state) && !reviewing;
          if (!finished) runtime.codex.interrupt(scope, task.id, `${task.id}:${task.revision}:interrupt`);
          communication.interaction(id, codexInteraction(runtime.codex.store.get(task.id)!), "codex:" + task.id);
          void codex?.tick().catch(() => {}); json(res, 200, { ok: true }); return true;
        }
        if (value.type === "question-answer") {
          if (interaction.kind !== "user-question" || interaction.id !== value.requestId) { json(res, 404, { error: "这次提问已失效。" }); return true; }
          const chatId = store.conversationInfo(id)!.chatId;
          if (interaction.resumeAfterRestart || !coordinator.hasTask(chatId)) {
            if (interaction.status === "completed" || interaction.status === "cancelled") { json(res, 200, { ok: true }); return true; }
            const expired = !interaction.expiresAt || interaction.expiresAt <= Date.now();
            const questionCreatedAt = notice.createdAt;
            // Never apply a recovered answer to a newer request in the same topic.
            const superseded = store.messages(id).some(message => message.role === "user" && message.createdAt > questionCreatedAt)
              || store.queuedMessages(id).some(message => message.createdAt >= questionCreatedAt);
            if (interaction.status !== "pending" || expired || superseded) {
              communication.interaction(id, { ...interaction, status: expired ? "expired" : "failed", actions: [],
                statusMessage: expired ? "提问已过期。" : "已有新的请求，这次提问已结束。" }, notice.id);
              json(res, 409, { error: expired ? "提问已过期。" : "这次提问已结束。" }); return true;
            }
            const answers = value.cancel || !interaction.questions?.length ? undefined : validateUserQuestionAnswers(interaction.questions, input.answers);
            if (!value.cancel && !answers) { json(res, 400, { error: "请完整回答每个问题。" }); return true; }
            if (store.queuedMessages(id).length >= 20) { json(res, 429, { error: "等待消息已满，请处理后再提交。" }); return true; }
            // Commit the receipt and a single durable continuation together. No tool is replayed.
            const details = answers ? interaction.questions!.map(question => {
              const answer = answers[question.id]!;
              const labels = question.type === "text" ? [] : question.options.filter(option => answer.selectedOptionIds?.includes(option.id)).map(option => option.label);
              return { question: question.question, selectedOptions: labels, ...(answer.text ? { text: answer.text } : {}) };
            }) : undefined;
            const workspaceChoice = interaction.questionPurpose === "workspace";
            const continuation: QueuedWebMessage = { id: `question-answer:${interaction.id}`, conversationId: id,
              text: value.cancel ? workspaceChoice ? "取消上次项目区选择，不切换或退出原项目区；暂不开始该次归属待定的文件任务，不要将取消视为新的项目授权。" : "跳过上次提问，请按现有信息继续原来的请求。"
                : `${workspaceChoice ? "补充上次项目区选择，请先据此完成具体项目选择，再继续原来的文件任务。" : "回答上次提问，请据此继续原来的请求。"}\n\n${JSON.stringify(details)}`,
              assets: [], createdAt: Date.now(), model: coordinator.selectedModel(id), reasoningEfforts: coordinator.currentReasoningEfforts(), status: "queued" };
            const status = value.cancel ? "cancelled" as const : "completed" as const;
            const statusMessage = value.cancel ? workspaceChoice ? "已取消本次项目区选择。" : "已跳过这些问题。" : workspaceChoice ? "项目选择已收到。" : "回答已收到。";
            store.completeRecoveredQuestion({ ...notice, interactions: notice.interactions!.map(item => item.id === interaction!.id
              ? { ...item, answers, status, statusMessage }
              : item) }, continuation);
            // Release an orphaned in-process waiter as well. The durable queue
            // owns continuation; duplicate card callbacks cannot enqueue twice.
            if (!interaction.resumeAfterRestart) void controller.handleAction(owner, chatId, { ...value, answers });
            json(res, 200, { ok: true }); return true;
          }
          // A question pauses the active run. Resolve it directly while that run still owns the queue.
          const result = await controller.handleAction(owner, chatId, { ...value, answers: input.answers });
          json(res, result.ok ? 200 : 409, result.ok ? { ok: true } : { error: result.message }); return true;
        }
        if (input.answers !== undefined) { json(res, 400, { error: "此操作不接收回答。" }); return true; }
        if (value.type === "operation-confirmation") {
          if (interaction.kind !== "operation-confirmation" || interaction.id !== value.proposalId.split(":", 1)[0]) { json(res, 404, { error: "变更确认已失效。" }); return true; }
          const chatId = store.conversationInfo(id)!.chatId;
          const task = controller.handleAction(owner, chatId, { ...value, codexEdits: input.codexEdits });
          tasks.add(task); void task.finally(() => tasks.delete(task));
          if (input.codexEdits !== undefined) { const result = await task; json(res, result.ok ? 200 : 409, result.ok ? { ok: true } : { error: result.message }); return true; }
          json(res, 202, { ok: true }); return true;
        }
        if (input.codexEdits !== undefined) { json(res, 400, { error: "此操作不接收 Codex 编辑。" }); return true; }
        if (value.type === "memory-proposal") {
          const result = await memoryProposals.act(id, notice.id, interaction.id, value.proposalId, value.confirm);
          json(res, result.code, result.error ? { error: result.error } : { ok: true }); return true;
        }
        if (value.type === "task-proposal") {
          const result = await taskProposals.act(id, notice.id, interaction.id, value.proposalId, value.confirm);
          json(res, result.code, result.error ? { error: result.error } : { ok: true }); return true;
        }
        if (value.type === "model-select") { json(res, 400, { error: "请从模型库选择模型。" }); return true; }
        if (value.type === "model-picker") { json(res, 400, { error: "请从模型库选择模型。" }); return true; }
        if (value.type === "authorization-retry") {
          const expired = interaction.status === "pending" && interaction.expiresAt !== undefined && interaction.expiresAt <= Date.now();
          const liveFeishu = value.service === "feishu" && (interaction.status === "pending" || interaction.status === "completed");
          if (interaction.kind !== "authorization" || interaction.service !== value.service || !liveFeishu && !expired && interaction.status !== "failed" && interaction.status !== "expired") {
            json(res, 409, { error: "此连接请求仍在处理或已经结束。" }); return true;
          }
          try {
            // Legacy retry cards also resume safely; only the explicit switch action changes apps.
            const switchAccount = value.switchAccount === true;
            if (!authorizations.retry(value.service, id, notice.id, interaction.id, switchAccount)) { json(res, 409, { error: authorizationSetupRequiredText(value.service) }); return true; }
          } catch { json(res, 409, { error: "上次授权仍在处理，请稍后重试。" }); return true; }
          const current = store.message(notice.id)?.interactions?.find(item => item.id === interaction!.id);
          json(res, 202, { ok: true, ...(value.service === "feishu" && current ? { interaction: current } : {}) }); return true;
        }
        if (interaction.status !== "pending") { json(res, 409, { error: "此操作已经处理。" }); return true; }
      } else {
        const input = z.object({ conversationId: z.string(), requestId: z.string(), confirm: z.boolean() }).parse(await data(req));
        id = store.resolveConversation(input.conversationId); notice = store.message(input.requestId);
        const action = notice?.action as { type?: string; requestId?: string } | undefined;
        if (!id || notice?.conversationId !== id || action?.type !== "model-fallback" || action.requestId !== input.requestId) { json(res, 404, { error: "确认请求已失效。" }); return true; }
        value = { type: "model-fallback", requestId: input.requestId, confirm: input.confirm };
      }
      const result = await coordinator.continueModelRequest(id, notice!, value, interaction?.id);
      json(res, result.code, result.error ? { error: result.error } : { ok: true }); return true;
    }
    return false;
  };
  return handle;
}
