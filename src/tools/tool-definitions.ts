import { subagentActions } from "./subagents.js";
import type { ModelHostedTool, ModelTool } from "../models/types.js";
import { taskReadPolicy } from "../productivity/task-access.js";
import { confirmationGuidance } from "./operation-policy.js";
import type { ToolAccessPolicy } from "./tool-access.js";
import type { AgentToolRegistration, ToolExecutionContext } from "./tool-contracts.js";

export function createToolDefinitionProjector(options: {
  names: readonly string[];
  catalog: ReadonlyMap<string, AgentToolRegistration>;
  hostedCatalog: ReadonlyMap<string, { definition: ModelHostedTool }>;
  isAvailable: ToolAccessPolicy;
}): (context?: ToolExecutionContext) => readonly ModelTool[] {
  const { names, catalog, hostedCatalog, isAvailable } = options;
  return (context) => Object.freeze(names
    .filter((name) => isAvailable(name, context) || name === "subagents" && context?.preparedSubagentModels !== undefined && catalog.get(name)?.available !== false)
    .map((name) => {
      let definition = catalog.get(name)?.definition ?? hostedCatalog.get(name)!.definition;
      const subagentModels = context?.subagents?.availableModels ?? context?.preparedSubagentModels;
      if (name === "subagents" && subagentModels && definition.type === "function") {
        const properties = definition.input_schema.properties as Record<string, unknown>;
        definition = { ...definition, input_schema: { ...definition.input_schema, properties: { ...properties,
          model: { ...(properties.model as Record<string, unknown>), enum: [...subagentModels] } } } };
      }
      if (context?.subagent && definition.type === "function") {
        const actions = subagentActions[name];
        const properties = definition.input_schema.properties as Record<string, unknown>;
        definition = { ...definition, description: `${definition.description} As a subagent, use explicit environment_id for exec_command/apply_patch/view_image and workspaceId for workspace operations. Return artifact paths to the coordinator for final delivery.`,
          ...(actions ? { input_schema: { ...definition.input_schema, properties: { ...properties, action: { type: "string", enum: actions } } } } : {}) };
      }
      if (definition.type === "function" && ["schedule", "google_calendar", "todoist", "google_drive", "gmail", "notion", "xmind", "feishu_cli", "proactive_tasks", "health_tasks", "user_location"].includes(name)) {
        definition = { ...definition, description: `${definition.description}\n${confirmationGuidance}` };
        if (["notion", "xmind", "feishu_cli"].includes(name)) {
          const properties = definition.input_schema.properties as Record<string, unknown>;
          const action = (properties.action ?? {}) as { enum?: string[] };
          definition = { ...definition, input_schema: { ...definition.input_schema, properties: { ...properties,
            action: { ...action, enum: action.enum?.filter(value => value !== "confirm") } } } };
          const sanitized = { ...(definition.input_schema.properties as Record<string, unknown>) };
          delete sanitized.confirmation_id; delete sanitized.confirmationId;
          definition = { ...definition, input_schema: { ...definition.input_schema, properties: sanitized } };
        }
      }
      if ((context?.taskRunId || context?.subagent) && name === "markdown" && definition.type === "function") {
        const { changes: _changes, ...properties } = definition.input_schema.properties as Record<string, unknown>;
        return { ...definition, description: "Discover, read and search authorized Zigent Markdown by document_id.",
          input_schema: { ...definition.input_schema, properties: { ...properties, action: { type: "string", enum: ["list", "read", "search"] } } } };
      }
      if (context?.taskRunId && name === "schedule" && definition.type === "function") {
        const properties = definition.input_schema.properties as Record<string, unknown>;
        return { ...definition, description: "读取用户的内置日程和待办。后台任务只能使用 list 和 get，不得修改。",
          input_schema: { ...definition.input_schema, properties: Object.fromEntries(Object.entries(properties)
            .filter(([key]) => ["action", "id", "kind", "query", "from", "to", "include_completed"].includes(key))
            .map(([key, value]) => [key, key === "action" ? { type: "string", enum: ["list", "get"] } : value])) } };
      }
      const productivityRead = taskReadPolicy(name);
      if (context?.taskRunId && productivityRead && definition.type === "function") {
        const properties = definition.input_schema.properties as Record<string, unknown>;
        return { ...definition,
          description: `Read the configured owner's ${name === "todoist" ? "tasks" : "calendar"} for this authorized proactive task. Only read actions are available; do not create, edit, complete, delete or authorize anything. Follow pagination. If unavailable, explain the missing context and continue; unknown is not an empty schedule.`,
          input_schema: { ...definition.input_schema, properties: Object.fromEntries(Object.entries(properties)
            .filter(([key]) => productivityRead.fields.includes(key))
            .map(([key, value]) => [key, key === "action" ? { type: "string", enum: productivityRead.actions } : value])) } };
      }
      if (context?.taskRunId && context.backgroundTaskKind === "proactive" && name === "health_data" && definition.type === "function") {
        const properties = definition.input_schema.properties as Record<string, unknown>;
        return { ...definition, description: `${definition.description} In this proactive run only status/query/sleep/diary/view_photos are available; do not fabricate user reports.`,
          input_schema: { ...definition.input_schema, properties: Object.fromEntries(Object.entries(properties)
            .filter(([key]) => ["action", "from", "to", "metrics", "stream", "after_seq", "limit", "from_date", "to_date", "photo_ids"].includes(key))
            .map(([key, value]) => [key, key === "action" ? { type: "string", enum: ["status", "query", "sleep", "diary", "view_photos"] } : value])) } };
      }
      if (context?.taskRunId && name === "skills" && definition.type === "function") {
        const properties = definition.input_schema.properties as Record<string, unknown>;
        return { ...definition, description: "Discover or load authorized instruction skills and read packaged text.",
          input_schema: { ...definition.input_schema, properties: Object.fromEntries(Object.entries(properties)
            .filter(([key]) => ["name", "action", "limit", "resource"].includes(key))
            .map(([key, value]) => [key, key === "action" ? { type: "string", enum: ["list", "load", "read_resource", "updates"] } : value])) } };
      }
      if (!context?.taskRunId || name !== "user_location" || definition.type !== "function") return definition;
      return { ...definition,
        description: "Read the configured owner's last-known location when materially relevant to the authorized background task. Location binding and deletion are unavailable in background tasks.",
        input_schema: { type: "object", properties: { action: { type: "string", enum: ["get"] } }, required: ["action"], additionalProperties: false }
      };
    }));
}
