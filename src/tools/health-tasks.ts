import { createHash } from "node:crypto";
import type { AgentToolRegistration } from "./registry.js";
import type { TaskStore } from "../tasks/store.js";
import type { TaskTrigger } from "../tasks/types.js";
export function mutationIdentity(
  context: { taskRunId?: string; sessionId: string; turnId: number },
  value: unknown,
): string {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : value;
  return `${context.taskRunId ?? `${context.sessionId}:${context.turnId}`}:${createHash(
    "sha256",
  )
    .update(JSON.stringify(canonical(value)))
    .digest("hex")}`;
}
export function createHealthTasksTool(options: {
  store: TaskStore;
  supportsLocation?: () => boolean;
  initialHealthCursor?: () => number;
}): AgentToolRegistration {
  return {
    requiredSkill: "health",
    definition: {
      type: "function",
      name: "health_tasks",
      description:
        "Manage owner-authorized private health reminders and proactive analysis. Create only when the user requests a future or recurring task. Never create tasks merely because health data changed. Only declarative time, health_change, OwnTracks location enter/leave triggers; no scripts. Runs record model usage and notification delivery independently.",
      input_schema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["create", "update", "pause", "cancel", "list", "runs"],
          },
          id: { type: "string" },
          title: { type: "string", description: "Required when creating a task. Use a specific task name of at most four characters (Latin letters count), also used as its phone notification title. Prefer the user's chosen name; never use a generic label such as 主动通知." },
          instruction: { type: "string" },
          trigger: {
            type: "object",
            description:
              "{type:time,schedule:once,at:ISO timestamp with offset,timezone?:IANA} OR {type:time,schedule:daily|weekly,time:HH:mm,timezone:IANA (default Asia/Shanghai),weekdays?:[0..6]} OR {type:health_change,debounceSeconds?:0..3600,metrics?:string[]} OR {type:location,event:enter|leave,regionId?:string,minSpeedKph?:0..2000,maxSpeedKph?:0..2000}. Location speed bounds are inclusive km/h on the crossing report; min <= max, either may be omitted. Missing speed does not match configured bounds.",
          },
          status: { type: "string", enum: ["active", "paused"] },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    executionMode: "sequential",
    activity: {
      started: () => ({ message: "我正在处理健康提醒任务。" }),
      completed: () => ({ message: "我已经处理好健康提醒任务。" }),
      failed: () => ({ message: "这次我没能处理健康提醒任务。" }),
    },
    async execute(value, context) {
      context.signal?.throwIfAborted();
      const scope = {
        agentId: context.agentId,
        userId: context.userId,
        conversationId: context.conversationId,
        conversationKind: context.conversationKind,
      };
      options.store.assertScope(scope);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("health_tasks input must be an object");
      const input = value as Record<string, unknown>,
        action = input.action,
        id = typeof input.id === "string" ? input.id : undefined;
      if (action === "list") return { tasks: options.store.list(scope) };
      if (action === "runs")
        return {
          runs: options.store
            .runs(scope, id, typeof input.limit === "number" ? input.limit : 30)
            .map((run) => ({
              id: run.id,
              taskId: run.taskId,
              parentRunId: run.parentRunId,
              refreshCount: run.refreshCount,
              occurrence: run.occurrence,
              taskRevision: run.taskRevision,
              state: run.state,
              attempts: run.attempts,
              triggeredAt: run.triggeredAt,
              startedAt: run.startedAt,
              endedAt: run.endedAt,
              summary: run.result?.summary?.slice(0, 2000),
              model: run.result?.model,
              usage: run.result?.usage,
              skillRevision: run.result?.skillRevision,
              cursor: run.result?.cursor,
              error: run.error?.slice(0, 500),
              notificationStatus: run.notificationStatus,
              sessionId: run.sessionId,
              messageId: run.messageId,
            })),
        };
      if (action === "create") {
        const desired = {
          title: String(input.title ?? ""),
          instruction: String(input.instruction ?? ""),
          trigger: input.trigger as TaskTrigger,
        };
        if (
          desired.trigger?.type === "location" &&
          !options.supportsLocation?.()
        )
          throw new Error(
            "Location task triggers are unavailable until an authorized OwnTracks source is configured",
          );
        const key = mutationIdentity(context, desired);
        return {
          task: options.store.create(
            scope,
            desired,
            Date.now(),
            key,
            options.initialHealthCursor?.() ?? 0,
          ),
        };
      }
      if (!id) throw new Error("Task id is required");
      if (action === "pause" || action === "cancel")
        return {
          task: options.store.update(
            scope,
            id,
            {
              status: action === "pause" ? "paused" : "cancelled",
            },
            Date.now(),
            mutationIdentity(context, input),
          ),
        };
      if (
        action === "update" &&
        (input.trigger as TaskTrigger)?.type === "location" &&
        !options.supportsLocation?.()
      )
        throw new Error(
          "Location task triggers are unavailable until an authorized OwnTracks source is configured",
        );
      if (action === "update")
        return {
          task: options.store.update(
            scope,
            id,
            {
              ...(typeof input.title === "string"
                ? { title: input.title }
                : {}),
              ...(typeof input.instruction === "string"
                ? { instruction: input.instruction }
                : {}),
              ...(input.trigger
                ? { trigger: input.trigger as TaskTrigger }
                : {}),
              ...(input.status === "active" || input.status === "paused"
                ? { status: input.status }
                : {}),
            },
            Date.now(),
            mutationIdentity(context, input),
          ),
        };
      throw new Error("Unsupported health_tasks action");
    },
  };
}
