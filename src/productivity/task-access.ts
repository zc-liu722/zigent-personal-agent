import type { PersonalIntegrationConfig, ProductivityIntegration } from "./config.js";
import { assertPersonalAccess } from "./http.js";
import type { ToolExecutionContext } from "../tools/registry.js";

export type VerifyProductivityRun = (context: ToolExecutionContext) => boolean;
export const productivityTaskReads = {
  google_calendar: { actions: ["status", "list_calendars", "list_events", "get_event"],
    fields: ["action", "calendar_id", "event_id", "time_min", "time_max", "query", "page_token", "limit", "time_zone"] },
  todoist: { actions: ["status", "list_projects", "list_tasks", "get_task"],
    fields: ["action", "task_id", "project_id", "section_id", "parent_id", "filter", "lang", "cursor", "limit"] }
} satisfies Partial<Record<ProductivityIntegration, { actions: string[]; fields: string[] }>>;

export function taskReadPolicy(integration: string) {
  return integration === "google_calendar" || integration === "todoist" ? productivityTaskReads[integration] : undefined;
}

export function canReadProductivityTask(config: PersonalIntegrationConfig | undefined, context: ToolExecutionContext,
  integration: string, verify?: VerifyProductivityRun): boolean {
  return Boolean(taskReadPolicy(integration) && config?.ownerUserId && config.agentId === context.agentId
    && config.ownerUserId === context.userId && context.conversationKind === "p2p" && context.conversationId
    && context.backgroundTaskKind === "proactive" && context.taskRunId && context.taskLeaseToken
    && !context.signal?.aborted && verify?.(context));
}

export function assertProductivityAccess(config: PersonalIntegrationConfig | undefined, context: ToolExecutionContext,
  integration: string, action: unknown, verify?: VerifyProductivityRun): void {
  if (!context.taskRunId && context.backgroundTaskKind !== "proactive") return assertPersonalAccess(config, context);
  const policy = taskReadPolicy(integration);
  if (!canReadProductivityTask(config, context, integration, verify) || !policy?.actions.includes(String(action))) {
    throw new Error("Background productivity access requires the configured owner, a verified task and a read-only action; writes and account authorization require a user turn");
  }
  // The lease and read action above replace only the ordinary no-background restriction.
  // Keep the same private-chat, owner, Agent and abort checks as every normal user operation.
  assertPersonalAccess(config, { ...context, taskRunId: undefined });
}
