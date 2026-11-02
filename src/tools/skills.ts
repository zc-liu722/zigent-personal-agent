import { SQLiteSkillService, skillSectionsSchema, skillTarget } from "../skills/service.js";
import { SQLiteAgentSkillService, agentSkillName } from "../skills/agent-skills.js";
import type { ToolActivityPresenter } from "./activity-presentation.js";
import type { AgentToolRegistration } from "./registry.js";
import type { ProjectSpaceFiles } from "../project-spaces/files.js";

/** Deliberately excludes private arguments, document bodies and raw errors from activity. */
export const loadSkillActivity: ToolActivityPresenter = {
  started: input => ({ message: object(input).name === "health" ? "我正在读取这个私人的健康项目。" : "我正在读取技能记录。" }),
  completed: input => ({ message: object(input).name === "health" ? "我已经读取健康项目和当前状态。" : "我已经读取技能记录。" }),
  failed: input => ({ message: object(input).name === "health" ? "这次未能读取健康项目。" : "这次未能读取技能记录。" })
};
export const updateSkillActivity: ToolActivityPresenter = {
  started: () => ({ message: "我正在维护技能记录。" }),
  completed: () => ({ message: "我已经完成技能记录的维护。" }),
  failed: () => ({ message: "这次未能完成技能记录的维护。" })
};
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Skill input must be an object");
  return input as Record<string, unknown>;
}
function string(input: Record<string, unknown>, key: string): string {
  if (typeof input[key] !== "string") throw new Error(`${key} must be a string`);
  return input[key] as string;
}
export function createLoadSkillTool(service?: SQLiteSkillService, agentSkills?: SQLiteAgentSkillService, projectFiles?: ProjectSpaceFiles): AgentToolRegistration {
  return {
    definition: {
      type: "function", name: "load_skill",
      description: "Load an instruction skill owned by this Agent and user. Discover skills with update_skill action=list. Loaded instructions refresh each turn and do not grant permissions. Registered project entries contain business background, the user's role and source-document entrypoints; tool usage belongs to capability definitions, not project entries. The reserved health project requires separate health-owner authorization; loading health returns rules, private state and today's/yesterday's Asia/Shanghai projectDiary, and enables only its authorized project tools next round. No separate diary query is needed for that supplied range.",
      input_schema: { type: "object", properties: { name: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" } }, required: ["name"], additionalProperties: false }
    },
    executionMode: "sequential",
    activity: loadSkillActivity,
    execute: async (input, context) => {
      const name = agentSkillName.parse(string(object(input), "name"));
      if (name !== "health") {
        if (projectFiles?.canAccess(context) && await projectFiles.current(context, name)) return projectFiles.load(context, name);
        if (!agentSkills) throw new Error("Agent skills are not configured");
        return agentSkills.load(context, context.sessionId, name);
      }
      if (!service) throw new Error("Private project skills are not configured");
      return service.load(context, context.sessionId, name);
    }
  };
}
export function createUpdateSkillTool(service?: SQLiteSkillService, agentSkills?: SQLiteAgentSkillService, projectFiles?: ProjectSpaceFiles): AgentToolRegistration {
  return {
    definition: {
      type: "function", name: "update_skill",
      description: "Manage instruction skills belonging to this Agent and private user. list discovers names/descriptions, read returns current body/rules and revision (exists=false for an absent ordinary skill), updates returns lightweight metadata. create requires name, description, body and optional rules; first read the name and copy expected_revision, including 0 for a never-created name. replace edits a whole body/rules document via content and optionally description. delete removes an ordinary skill and unloads it from every session. Every create/edit/delete requires the existing user confirmation component; never claim pending changes saved. Skills persist across restart/deployment and cannot grant tools, execute code, or change permissions. health is reserved: separate owner authorization applies, only read/updates/replace_section/replace_sections are allowed, and health cannot be created, replaced wholesale or deleted here. target=rules edits persistent rules; target=body (default) edits state. For section edits use replace_sections with ALL distinct non-overlapping existing headings in one batch; replace_section remains compatible. First read latest and use the SAME expected_revision for pending edits; never increment before confirmation. source_request_id must be stable. On conflict reread. Replays return current state without reverting. For health, save confirmed baselines, preferences, goals/plans and concise status; keep daily facts in health_data, query rules in rules, and recent state dated with an exit condition. Maintenance does not require loading or activate tools.",
      input_schema: {
        type: "object", properties: {
          name: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
          description: { type: "string", maxLength: 500 }, body: { type: "string", maxLength: 100000 }, rules: { type: "string", maxLength: 100000 },
          target: { type: "string", enum: ["body", "rules"], description: "Editable document: body (default) or persistent project rules. One target per batch." },
          action: { type: "string", enum: ["list", "read", "updates", "create", "replace", "delete", "replace_sections", "replace_section"] },
          sections: { type: "array", minItems: 1, maxItems: 20, description: "All changes to this file, based on the same read revision.", items: {
            type: "object", properties: { heading: { type: "string" }, content: { type: "string", maxLength: 100000 } },
            required: ["heading", "content"], additionalProperties: false
          } },
          heading: { type: "string", description: "Exact existing heading, e.g. ## 当前计划" },
          content: { type: "string", description: "Replacement section contents, excluding its heading" },
          expected_revision: { type: "integer", minimum: 0 }, source_request_id: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 20 }
        }, required: ["action"], additionalProperties: false
      }
    },
    executionMode: "sequential", activity: updateSkillActivity,
    execute: async (input, context) => {
      const value = object(input);
      if (value.action === "list") return { skills: [
        ...(projectFiles?.canAccess(context) ? await projectFiles.catalog(context) : []),
        ...(agentSkills?.list(context, context.sessionId) ?? []),
        ...(service?.canAccessSession(context, context.sessionId) ? service.catalogFor(context) : [])
      ] };
      const name = agentSkillName.parse(string(value, "name"));
      if (name !== "health") {
        const synced = projectFiles?.canAccess(context) ? await projectFiles.current(context, name) : undefined;
        if (synced) {
          if (value.action === "read") return synced;
          if (value.action === "updates") return { updates: [{ revision: synced.revision, action: "space" }] };
          throw new Error("Registered project guidance is managed with the project-space release; ordinary skills cannot replace it");
        }
        if (!agentSkills) throw new Error("Agent skills are not configured");
        if (value.action === "read") return agentSkills.current(context, context.sessionId, name);
        if (value.action === "updates") return { updates: agentSkills.updates(context, context.sessionId, name, typeof value.limit === "number" ? value.limit : 5) };
        return agentSkills.mutate(context, context.sessionId, value, `${context.sessionId}:${context.turnId}:${string(value, "source_request_id")}`);
      }
      if (!service) throw new Error("Private project skills are not configured");
      const target = skillTarget(value.target);
      switch (value.action) {
        case "read": return service.current(context, context.sessionId, name);
        case "history": // Compatibility for old tool traces: only metadata is returned.
        case "updates": return { updates: await service.updates(context, context.sessionId, name,
          typeof value.limit === "number" ? value.limit : 5) };
        case "replace_section": return service.updateSection(context, context.sessionId, {
          name, target, heading: string(value, "heading"), content: string(value, "content"),
          expectedRevision: value.expected_revision as number,
          sourceRequestId: `${context.taskRunId ?? `${context.sessionId}:${context.turnId}`}:${string(value, "source_request_id")}`
        });
        case "replace_sections": return service.updateSections(context, context.sessionId, {
          name, target, sections: skillSectionsSchema.parse(value.sections), expectedRevision: value.expected_revision as number,
          sourceRequestId: `${context.taskRunId ?? `${context.sessionId}:${context.turnId}`}:${string(value, "source_request_id")}`
        });
        default: throw new Error("Unsupported skill operation");
      }
    }
  };
}
