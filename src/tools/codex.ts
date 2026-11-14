import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentToolRegistration } from "./registry.js";
import type { CodexService } from "../codex/service.js";
import { dispatchSchema, promptSchema } from "../codex/types.js";
import { isConfirmedOperation } from "./confirmed-operation.js";

const actions = ["devices", "pair_preview", "connect", "disconnect", "dispatch", "list", "get", "events", "message", "interrupt"] as const;
const inputSchema = z.object({ action: z.enum(actions), id: z.string().uuid().optional(), code: z.string().regex(/^[A-Fa-f0-9]{10}$/).optional(),
  task: dispatchSchema.optional(), text: promptSchema.optional(), reviewAfterCompletion: z.boolean().optional(), sourceTurns: z.array(z.object({ sessionId: z.string().min(1).max(200), turnId: z.number().int().positive() }).strict()).max(20).optional(), limit: z.number().int().min(1).max(50).default(20) }).strict();
const actionLabels: Record<string, string> = { devices: "查看桌面连接", pair_preview: "核对设备配对", connect: "连接桌面 Codex", disconnect: "断开桌面连接",
  dispatch: "准备发送 Codex 消息", list: "查看 Codex 会话", get: "查看 Codex 回复", events: "查看执行进展", message: "准备继续 Codex 会话", interrupt: "中断本机执行" };
export function createCodexTool(service?: CodexService): AgentToolRegistration {
  return {
    available: Boolean(service), executionMode: "sequential",
    definition: { type: "function", name: "codex",
      description: [
        "Delegate research, coding and documents to an authorized Windows desktop Codex. List connected devices and saved tasks first. Use an absolute Windows working directory. Ordinary Zigent workspace tools keep their own permissions.",
        "The desktop backend edits the real files in place with danger-full-access and approvalPolicy=never. No copies, snapshots or result overwrite are involved. Follow the full user goal and project rules. Retired executor histories remain recovery records and are not silently imported as desktop sessions.",
        "dispatch: deviceId/directory/title<=4 characters/prompt, optional continueTaskId; message continues that session. Every foreground dispatch/follow-up/answer and connect/disconnect needs the existing confirmation card (project/executor/session/FULL prompt). Only dispatch/message under a verified proactive lease may skip per-message confirmation. Never request login tokens.",
        "Rewrite/synthesize/decompose and add useful questions/hypotheses/steps faithfully. Recover older intent via conversation_history; cite sourceTurns=[{sessionId,turnId}] on task/message. Server resolves owner records, checks semantic fidelity and supplies original requirements/evidence to executor/reviewer. Honor superseding corrections and the full goal, sequence and formats; no invented offline/local-only fallback, scope reduction or extra deliverables. Research uses network normally; report actual access failures, never replace research with local summaries.",
        "reviewAfterCompletion=true ONLY on explicit completion-review/follow-up request: confirmation persists authorization to check the goal and deliver/continue the same scope/session. Never claim supervision without saved authorization. Progress/results arrive in the same operation area; do not poll. interrupt cancels only the selected task, including queued work."
      ].join(" "),
      input_schema: { type: "object", properties: { action: { type: "string", enum: [...actions] }, id: { type: "string" }, code: { type: "string" }, sourceTurns: { type: "array", maxItems: 20, items: { type: "object", properties: { sessionId: { type: "string" }, turnId: { type: "integer", minimum: 1 } }, required: ["sessionId", "turnId"], additionalProperties: false } }, reviewAfterCompletion: { type: "boolean" }, text: { type: "string", maxLength: 16000 }, limit: { type: "integer", minimum: 1, maximum: 50 },
        task: { type: "object", properties: { deviceId: { type: "string" }, projectId: { type: "string" }, directory: { type: "string", description: "Absolute Windows task directory; no catalogue admission or extra writable-root boundary." }, title: { type: "string", maxLength: 4 }, prompt: { type: "string", maxLength: 16000 }, continueTaskId: { type: "string" },
          sourceTurns: { type: "array", maxItems: 20, items: { type: "object", properties: { sessionId: { type: "string" }, turnId: { type: "integer", minimum: 1 } }, required: ["sessionId", "turnId"], additionalProperties: false } }, reviewAfterCompletion: { type: "boolean", description: "Only when the user asks to check completion and continue if needed; the confirmation card authorizes the bounded follow-up chain." }, timeoutMinutes: { type: "integer", minimum: 5, maximum: 1440 } }, required: ["deviceId", "directory", "title", "prompt"], additionalProperties: false } }, required: ["action"], additionalProperties: false } },
    activity: {
      started: input => ({ message: "我正在" + (actionLabels[String((input as { action?: string })?.action)] ?? "处理 Codex 消息") + "。" }),
      completed: (_input, result) => ({ message: (result as { status?: string })?.status === "pending_confirmation" ? "消息已展示，等你确认项目和完整提示词后发送。"
        : (result as { status?: string })?.status === "queued" ? "消息已确认并排队，进展会在这里更新。" : "我已处理这次 Codex 请求。" }),
      failed: () => ({ message: "这次 Codex 请求未完成，请检查连接或重新确认消息。" })
    },
    prepare: (value, context) => service ? service.prepareDelegation(value, context) : Promise.resolve({ input: value, context }),
    async execute(value, context) {
      if (!service) throw new Error("Codex 尚未配置");
      if ((context.taskRunId || context.backgroundTaskKind) && (!service.canAutomate(context) || !["devices", "dispatch", "list", "get", "events", "message", "interrupt"].includes(String((value as { action?: string })?.action))))
        throw new Error("后台 Codex 请求需要有效的主动任务运行授权");
      const scope = { agentId: context.agentId, userId: context.userId, conversationId: context.conversationId, sessionId: context.sessionId, conversationKind: context.conversationKind };
      service.store.assertScope(scope); const input = inputSchema.parse(value);
      if (["connect", "disconnect", "dispatch", "message"].includes(input.action) && !isConfirmedOperation(context, "codex", value) && !(["dispatch", "message"].includes(input.action) && service.canAutomate(context)))
        throw new Error("Codex 消息必须先通过用户确认组件");
      const key = createHash("sha256").update(JSON.stringify([context.agentId, context.userId, context.sessionId, context.turnId, value])).digest("hex");
      if (input.action === "devices") return { devices: service.store.devices(scope) };
      if (input.action === "pair_preview" || input.action === "connect") {
        if (!input.code) throw new Error("请输入桌面连接显示的配对码");
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
