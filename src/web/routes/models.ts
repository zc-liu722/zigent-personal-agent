import { z } from "zod";
import type { AgentInteractionController } from "../../agent/interaction-controller.js";
import { savedReasoningEffort } from "../../models/reasoning.js";
import type { AgentRuntime } from "../../runtime.js";
import type { ConversationCoordinator } from "../conversation-coordinator.js";
import { modelSelectionInteraction } from "../interactions.js";
import type { WebStore } from "../store.js";

import { data, json, type WebRoute } from "../http.js";

export function createModelsRoutes({ store, runtime, owner, coordinator, controller }: {
  store: WebStore;
  runtime: AgentRuntime;
  owner: string;
  coordinator: ConversationCoordinator;
  controller: AgentInteractionController;
}): WebRoute {
  const handle: WebRoute = async ({ req, res, url, route, credential }) => {
    if (route === "api/models/prewarm" && req.method === "POST") {
      const input = z.object({ conversationId: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().parse(await data(req));
      const id = input.conversationId ? store.resolveConversation(input.conversationId) : undefined;
      if (input.conversationId && !id) { json(res, 404, { error: "对话不存在。" }); return true; }
      const selected = id ? coordinator.selectedModel(id) : runtime.model.defaultProvider;
      if (runtime.config.models?.some(model => model.name === selected && model.protocol === "codex-app-server")) {
        runtime.model.warmContextPolicy(selected);
      }
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
        ? z.object({ conversationId: z.string().regex(/^[a-f0-9]{64}$/), actionId: z.string().min(1).max(128), reasoningEffort: z.string().min(1).max(32).optional(), fallbackRequestId: z.string().uuid().optional() }).strict().parse(await data(req))
        : { conversationId: url.searchParams.get("conversationId") ?? undefined, fallbackRequestId: url.searchParams.get("fallbackRequestId") ?? undefined };
      const id = input.conversationId ? store.resolveConversation(input.conversationId) : undefined;
      if (input.conversationId !== undefined && !id) { json(res, 404, { error: "对话不存在。" }); return true; }
      const recovery = input.fallbackRequestId && id ? controller.recoveryOptions(owner, store.conversationInfo(id)!.chatId, input.fallbackRequestId) : undefined;
      if (input.fallbackRequestId && !recovery) { json(res, 409, { error: "这次重试已失效，请重新发送问题。" }); return true; }
      let model = id ? coordinator.selectedModel(id) : runtime.model.defaultProvider;
      if ("actionId" in input) {
        if (!id) { json(res, 404, { error: "对话不存在。" }); return true; }
        if (coordinator.isBusy(store.conversationInfo(id)!.chatId)) { json(res, 409, { error: "请等待当前回复完成后再切换模型。" }); return true; }
        const deployment = runtime.config.models?.find(model => model.name === input.actionId);
        if (!deployment || !runtime.config.modelOrder?.includes(deployment.name)
          || recovery && !recovery.selectableProviders.includes(deployment.name)) { json(res, 400, { error: "此模型暂不可选，请从模型库重新选择。" }); return true; }
        if (recovery && input.fallbackRequestId) {
          if (input.reasoningEffort !== undefined) { json(res, 400, { error: "请直接选择重试使用的模型。" }); return true; }
          const notice = store.message(input.fallbackRequestId);
          if (!notice || notice.conversationId !== id) { json(res, 409, { error: "这次重试已失效。" }); return true; }
          runtime.model.warmContextPolicy(deployment.name);
          const result = await coordinator.continueModelRequest(id, notice, { type: "model-fallback", requestId: input.fallbackRequestId, confirm: true, model: deployment.name });
          if (result.error) { json(res, result.code, { error: result.error }); return true; }
          store.selectModel(id, deployment.name);
          json(res, result.code, { selectedModel: deployment.name,
            interaction: modelSelectionInteraction(runtime.config, deployment.name, name => store.modelReasoning(name), recovery.selectableProviders) }); return true;
        }
        if (input.reasoningEffort !== undefined) {
          const effort = savedReasoningEffort(deployment, input.reasoningEffort);
          if (model !== deployment.name || !effort) {
            json(res, 400, { error: "此模型不支持该思考强度，请重新选择。" }); return true;
          }
          store.saveModelReasoning(deployment.name, effort);
        } else store.selectModel(id, deployment.name);
        model = deployment.name;
        runtime.model.warmContextPolicy(model);
      }
      json(res, 200, { selectedModel: model, interaction: modelSelectionInteraction(runtime.config, model, name => store.modelReasoning(name), recovery?.selectableProviders) }); return true;
    }
    return false;
  };
  return handle;
}
