import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentToolRegistration } from "./registry.js";
import type { CodexService } from "../codex/service.js";
import { dispatchSchema, promptSchema } from "../codex/types.js";
import { isConfirmedOperation } from "./confirmed-operation.js";
import { spaceFiles, spaceReadiness } from "../project-spaces/service.js";
import { spaces, relativePath } from "../project-spaces/policy.js";

const actions = ["spaces", "files", "read", "devices", "pair_preview", "connect", "disconnect", "dispatch", "list", "get", "events", "message", "interrupt"] as const;
const inputSchema = z.object({ action: z.enum(actions), id: z.string().uuid().optional(), code: z.string().regex(/^[A-Fa-f0-9]{10}$/).optional(),
  task: dispatchSchema.optional(), text: promptSchema.optional(), reviewAfterCompletion: z.boolean().optional(), sourceTurns: z.array(z.object({ sessionId: z.string().min(1).max(200), turnId: z.number().int().positive() }).strict()).max(20).optional(), limit: z.number().int().min(1).max(50).default(20), projectId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional(), path: relativePath.optional(), offset: z.number().int().min(0).max(1048576).default(0) }).strict();
const actionLabels: Record<string, string> = { spaces: "查看项目空间", files: "查看项目文件", read: "读取项目资料", devices: "查看执行器", pair_preview: "核对设备配对", connect: "连接执行器", disconnect: "断开执行器",
  dispatch: "准备发送 Codex 消息", list: "查看 Codex 会话", get: "查看 Codex 回复", events: "查看执行进展", message: "准备继续 Codex 会话", interrupt: "中断本机执行" };
export function createCodexTool(service?: CodexService): AgentToolRegistration {
  return {
    available: Boolean(service), executionMode: "sequential",
    definition: { type: "function", name: "codex",
      description: "Use Codex as a general delegation capability for user-authorized research, coding, document editing and other work across available projects. spaces lists ONLY this Agent’s authorized spaces, exact machine mapping and sync readiness. files(projectId) lists registered files; read(projectId,path,offset) reads UTF-8 text in 20000-character pages. Never accept arbitrary OS paths, another Agent’s space, credentials or excluded files. FIRST use spaces/devices and list for live executor projects and known sessions. windows-codex runs on Windows directly in the registered project directory with file read/write access. linux-claude runs only on Linux and is currently unavailable (no-account); never substitute a model supplier route or run Claude on Windows. Changes are saved directly to project files in their appropriate topic directories. Do not create results/TASK_ID bundles, return manifests or task-report folders. Relative paths refer to the project root; synchronization remains limited to its registered selection. Legacy work-copy sessions must not be resumed in the live project; start a new session. dispatch proposes exact deviceId/projectId/title (at most four characters)/prompt, optionally continueTaskId. message continues the original session. Every foreground dispatch, follow-up and answer requires the existing user confirmation card showing project, executor, session and FULL prompt. You MAY rewrite, synthesize across sessions, decompose tasks and add useful execution detail. The server checks semantic fidelity before confirmation, not literal wording. When intent depends on older sessions, use conversation_history to retrieve the relevant user turns, then cite sourceTurns=[{sessionId,turnId}] on task or message; the server independently resolves the owner's real records. Do not rely on the latest utterance alone or treat old plans as current when superseded. The executor and completion reviewer receive the resolved source evidence as well as your synthesized assignment. Keep the assignment faithful to the user's original request. Reasonable research questions, hypotheses and execution steps are allowed. Do not invent offline/local-only fallbacks, reduce the goal, reverse the agreed sequence, or impose extra deliverables/formats contrary to the user's intent. Research uses available network normally. An actual access failure is a blocker to report, not permission to replace research with local summaries. The channel also preserves verbatim user requirements for the executor. reviewAfterCompletion=true ONLY when the user asks for completion review and follow-up: it is shown in confirmation, persisted, and checks the goal before delivering or continuing the same scoped session. Do not claim this supervision is active without that saved authorization. Progress and results arrive automatically in the same operation area. Do not poll. interrupt cancels only that task, including queued work. connect/disconnect also require confirmation. Verified authorized proactive runs may dispatch/message without per-message confirmation; the server validates their live lease. Never request tokens or bypass a closed executor admission gate.",
      input_schema: { type: "object", properties: { action: { type: "string", enum: [...actions] }, id: { type: "string" }, code: { type: "string" }, sourceTurns: { type: "array", maxItems: 20, items: { type: "object", properties: { sessionId: { type: "string" }, turnId: { type: "integer", minimum: 1 } }, required: ["sessionId", "turnId"], additionalProperties: false } }, reviewAfterCompletion: { type: "boolean" }, text: { type: "string", maxLength: 16000 }, limit: { type: "integer", minimum: 1, maximum: 50 }, projectId: { type: "string" }, path: { type: "string" }, offset: { type: "integer", minimum: 0 },
        task: { type: "object", properties: { deviceId: { type: "string" }, projectId: { type: "string" }, title: { type: "string", maxLength: 4 }, prompt: { type: "string", maxLength: 16000 }, continueTaskId: { type: "string" },
          sourceTurns: { type: "array", maxItems: 20, items: { type: "object", properties: { sessionId: { type: "string" }, turnId: { type: "integer", minimum: 1 } }, required: ["sessionId", "turnId"], additionalProperties: false } }, reviewAfterCompletion: { type: "boolean", description: "Only when the user asks to check completion and continue if needed; the confirmation card authorizes the bounded follow-up chain." }, timeoutMinutes: { type: "integer", minimum: 5, maximum: 1440 } }, required: ["deviceId", "projectId", "title", "prompt"], additionalProperties: false } }, required: ["action"], additionalProperties: false } },
    activity: {
      started: input => ({ message: "我正在" + (actionLabels[String((input as { action?: string })?.action)] ?? "处理 Codex 消息") + "。" }),
      completed: (_input, result) => ({ message: (result as { status?: string })?.status === "pending_confirmation" ? "消息已展示，等你确认项目和完整提示词后发送。"
        : (result as { status?: string })?.status === "queued" ? "消息已确认并排队，进展会在这里更新。" : "我已处理这次 Codex 请求。" }),
      failed: () => ({ message: "这次 Codex 请求未完成，请检查连接或重新确认消息。" })
    },
    prepare: (value, context) => service ? service.prepareDelegation(value, context) : Promise.resolve({ input: value, context }),
    async execute(value, context) {
      if (!service) throw new Error("Codex 尚未配置");
      if ((context.taskRunId || context.backgroundTaskKind) && (!service.canAutomate(context) || !["spaces", "files", "read", "devices", "dispatch", "list", "get", "events", "message", "interrupt"].includes(String((value as { action?: string })?.action))))
        throw new Error("后台 Codex 请求需要有效的主动任务运行授权");
      const scope = { agentId: context.agentId, userId: context.userId, conversationId: context.conversationId, sessionId: context.sessionId, conversationKind: context.conversationKind };
      service.store.assertScope(scope); const input = inputSchema.parse(value);
      if (input.action === "spaces") return { spaces: await Promise.all((await spaces(context.agentId)).map(async space => ({ ...space, status: await spaceReadiness(context.agentId, space.id) }))) };
      if (input.action === "files" || input.action === "read") {
        if (!input.projectId || input.action === "read" && !input.path) throw new Error("请选择项目及相对文件路径");
        return spaceFiles(context.agentId, input.projectId, input.offset, input.action === "read" ? 20000 : input.limit, input.action === "read" ? input.path : undefined);
      }
      if (["connect", "disconnect", "dispatch", "message"].includes(input.action) && !isConfirmedOperation(context, "codex", value) && !(["dispatch", "message"].includes(input.action) && service.canAutomate(context)))
        throw new Error("Codex 消息必须先通过用户确认组件");
      const key = createHash("sha256").update(JSON.stringify([context.agentId, context.userId, context.sessionId, context.turnId, value])).digest("hex");
      if (input.action === "devices") return { devices: service.store.devices(scope) };
      if (input.action === "pair_preview" || input.action === "connect") {
        if (!input.code) throw new Error("请输入 Mac 显示的配对码");
        if (!service.store.limit("pair:" + scope.userId, 20)) throw new Error("配对尝试过多，请稍后重试");
        return { device: input.action === "connect" ? service.store.pair(scope, input.code) : service.store.pairPreview(scope, input.code) };
      }
      if (input.action === "dispatch") {
        if (!input.task) throw new Error("请提供项目和完整提示词");
        const task = await service.dispatch(scope, input.task, key, context, value); return { status: "queued", task: service.statusTask(task) };
      }
      if (input.action === "list") return { tasks: service.store.list(scope, input.limit).map(task => service.statusTask(task)) };
      if (!input.id) throw new Error("请选择具体任务或设备");
      if (input.action === "disconnect") { service.store.revoke(scope, input.id); return { status: "disconnected" }; }
      const task = service.store.owned(scope, input.id);
      if (input.action === "get") return { task: service.statusTask(task) };
      if (input.action === "events") return { events: service.store.events(scope, task.id, input.limit) };
      if (input.action === "message") {
        if (!input.text) throw new Error("请提供完整提示词");
        return service.message(scope, task.id, input.text, key, context, value, input.reviewAfterCompletion);
      }
      return service.interrupt(scope, task.id, key);
    }
  };
}
