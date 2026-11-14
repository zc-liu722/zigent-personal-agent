import { z } from "zod";
import type { AgentInteractionController } from "../../agent/interaction-controller.js";
import { reasoningSelection, savedReasoningEffort } from "../../models/reasoning.js";
import type { AgentRuntime } from "../../runtime.js";
import type { ConversationCoordinator } from "../conversation-coordinator.js";
import { modelSelectionInteraction } from "../interactions.js";
import type { WebStore } from "../store.js";

import { data, json, type WebRoute } from "../http.js";

const modelChange = z.object({ conversationId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  actionId: z.string().min(1).max(128), reasoningEffort: z.string().min(1).max(32).optional(),
  fallbackRequestId: z.string().uuid().optional(), compact: z.literal(true).optional() }).strict();

export function createModelsRoutes({ store, runtime, owner, coordinator, controller, createConversation, prepareConversation }: {
  store: WebStore;
  runtime: AgentRuntime;
  owner: string;
  coordinator: ConversationCoordinator;
  controller: AgentInteractionController;
  createConversation: (model?: string) => Promise<string>;
  prepareConversation: (id: string | undefined, model: string) => void;
}): WebRoute {
  const handle: WebRoute = async ({ req, res, url, route }) => {
    if (route === "api/models/prewarm" && req.method === "POST") {
      const input = z.object({ conversationId: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().parse(await data(req));
      const id = input.conversationId ? store.resolveConversation(input.conversationId) : undefined;
      if (input.conversationId && !id) { json(res, 404, { error: "对话不存在。" }); return true; }
      const selected = id ? coordinator.selectedModel(id) : runtime.model.defaultProvider;
      prepareConversation(id, selected);
      json(res, 202, { ok: true }); return true;
    }
    if (route === "api/models/context" && req.method === "GET") {
      const model = url.searchParams.get("model") ?? runtime.model.defaultProvider;
      if (!(runtime.config.modelOrder ?? runtime.config.providerOrder).includes(model)) {
        json(res, 400, { error: "模型不存在。" }); return true;
      }
      json(res, 200, await runtime.model.contextInfo(model)); return true;
    }
    if (route === "api/models/default" && req.method === "POST") {
      const input = z.object({ model: z.string().min(1).max(128) }).strict().parse(await data(req));
      if (!runtime.config.modelOrder?.includes(input.model)) { json(res, 400, { error: "模型不存在。" }); return true; }
      runtime.model.setDefaultProvider(input.model); store.saveDefaultModel(input.model);
      json(res, 200, { defaultModel: runtime.model.defaultProvider }); return true;
    }
    if (route === "api/models" && (req.method === "GET" || req.method === "POST")) {
      const input = req.method === "POST"
        ? modelChange.parse(await data(req))
        : { conversationId: url.searchParams.get("conversationId") ?? undefined, fallbackRequestId: url.searchParams.get("fallbackRequestId") ?? undefined };
      const id = input.conversationId ? store.resolveConversation(input.conversationId) : undefined;
      const conversation = id ? store.conversationInfo(id) : undefined;
      if (input.conversationId !== undefined && !conversation) { json(res, 404, { error: "对话不存在。" }); return true; }
      const recovery = input.fallbackRequestId && conversation ? controller.recoveryOptions(owner, conversation.chatId, input.fallbackRequestId) : undefined;
      if (input.fallbackRequestId && !recovery) { json(res, 409, { error: "这次重试已失效，请重新发送问题。" }); return true; }
      const catalog = recovery?.catalog ?? runtime.config;
      if ("actionId" in input) {
        if (!conversation && (!input.compact || input.reasoningEffort !== undefined)) { json(res, 404, { error: "对话不存在。" }); return true; }
        if (conversation && coordinator.isBusy(conversation.chatId)) { json(res, 409, { error: "请等待当前回复完成后再切换模型。" }); return true; }
        const deployment = catalog.models?.find(model => model.name === input.actionId);
        if (!deployment || !catalog.modelOrder?.includes(deployment.name)
          || recovery && !recovery.selectableProviders.includes(deployment.name)) { json(res, 400, { error: "此模型暂不可选，请从模型库重新选择。" }); return true; }
        const selectedModel = deployment.name;
        let effort: ReturnType<typeof savedReasoningEffort>;
        let conversationId = input.conversationId;
        let status = 200;
        if (id && recovery && input.fallbackRequestId) {
          if (input.reasoningEffort !== undefined) { json(res, 400, { error: "请直接选择重试使用的模型。" }); return true; }
          const notice = store.message(input.fallbackRequestId);
          if (!notice || notice.conversationId !== id) { json(res, 409, { error: "这次重试已失效。" }); return true; }
          runtime.model.warmContextPolicy(deployment.name);
          const result = await coordinator.continueModelRequest(id, notice, { type: "model-fallback", requestId: input.fallbackRequestId, confirm: true, model: deployment.name });
          if (result.error) { json(res, result.code, { error: result.error }); return true; }
          store.selectModel(id, selectedModel);
          status = result.code;
        } else if (id && input.reasoningEffort !== undefined) {
          effort = savedReasoningEffort(deployment, input.reasoningEffort);
          if (coordinator.selectedModel(id) !== selectedModel || !effort) {
            json(res, 400, { error: "此模型不支持该思考强度，请重新选择。" }); return true;
          }
          store.saveModelReasoning(deployment.name, effort);
        } else if (conversation) {
          if (conversation.model !== selectedModel) store.selectModel(conversation.id, selectedModel);
        } else {
          conversationId = await createConversation(selectedModel);
          status = 201;
        }
        if (input.compact) {
          const reasoning = reasoningSelection(deployment, effort ?? store.modelReasoning(selectedModel));
          json(res, status, { selectedModel, conversationId, reasoning });
        } else {
          json(res, status, { selectedModel,
            interaction: modelSelectionInteraction(catalog, selectedModel, name => store.modelReasoning(name), recovery?.selectableProviders) });
        }
        if (!recovery) prepareConversation(conversationId ? store.resolveConversation(conversationId) : undefined, selectedModel);
        return true;
      }
      const model = id ? coordinator.selectedModel(id) : runtime.model.defaultProvider;
      json(res, 200, { selectedModel: model, interaction: modelSelectionInteraction(catalog, model, name => store.modelReasoning(name), recovery?.selectableProviders) }); return true;
    }
    return false;
  };
  return handle;
}
