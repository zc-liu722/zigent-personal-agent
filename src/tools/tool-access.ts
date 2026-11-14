import type { AgentToolSettings } from "../config.js";
import { canReadProductivityTask } from "../productivity/task-access.js";
import type { DocumentCapability } from "../capabilities/documents/service.js";
import type { SQLiteAgentSkillService } from "../skills/agent-skills.js";
import type { SQLiteSkillService } from "../skills/service.js";
import type { AgentToolRegistration, ToolExecutionContext } from "./tool-contracts.js";

export type ToolAccessPolicy = (name: string, context?: ToolExecutionContext) => boolean;

export function createToolAccessPolicy(options: {
  agentId: string;
  allowed: ReadonlySet<string>;
  catalog: ReadonlyMap<string, AgentToolRegistration>;
  toolSettings: AgentToolSettings;
  skills?: SQLiteSkillService;
  agentSkills?: SQLiteAgentSkillService;
  documents?: DocumentCapability;
  verifyProactiveRun?: (context: ToolExecutionContext) => boolean;
}): ToolAccessPolicy {
  const { agentId, allowed, catalog, toolSettings, skills, agentSkills, documents, verifyProactiveRun } = options;
  const privateNames = new Set(["health_data", "health_tasks"]);
  const interactiveTools = new Set(["health_tasks", "proactive_tasks", "image_generation", "video_generation"]);

  return (name, context) => {
    if (!allowed.has(name) || catalog.get(name)?.available === false || context?.signal?.aborted) return false;
    const background = Boolean(context?.taskRunId || context?.backgroundTaskKind);
    if (background) {
      if (!context?.taskRunId || !context.taskLeaseToken) return false;
      const verified = context.backgroundTaskKind === "proactive" ? verifyProactiveRun?.(context)
        : skills?.canAccessSession(context, context.sessionId);
      if (!verified || interactiveTools.has(name)) return false;
    }
    if (name === "subagents") return Boolean(context?.subagents && !context.subagent && !context.taskRunId && !context.backgroundTaskKind);
    if (context?.subagent && ["browser", "codex", "ask_user_question", "present_output", "image_assets", "image_generation", "video_generation"].includes(name)) return false;
    if (name === "image_assets") return Boolean(context?.imageAssets && context.presentOutput && context.conversationKind === "p2p" && !context.taskRunId && !context.backgroundTaskKind);
    if (name === "schedule") {
      if (!context || context.agentId !== agentId || context.conversationKind !== "p2p" || !context.userId) return false;
      if (context.taskRunId || context.backgroundTaskKind) return Boolean(context.taskRunId && context.backgroundTaskKind === "proactive" && verifyProactiveRun?.(context));
      return true;
    }
    if (name === "conversation_history" && (!context || context.agentId !== agentId || !context.userId
      || !context.sessionId || !context.conversationId || !context.conversationKind || context.taskRunId || context.backgroundTaskKind)) return false;
    if (name === "codex" && (!context || context.conversationKind !== "p2p" || !context.conversationId
      || ((context.taskRunId || context.backgroundTaskKind) && !(context.backgroundTaskKind === "proactive" && context.taskRunId && context.taskLeaseToken && verifyProactiveRun?.(context))) || toolSettings.codex?.agentId !== context.agentId
      || toolSettings.codex.ownerUserId !== context.userId)) return false;
    if (name === "browser" && (!context || context.conversationKind !== "p2p" || !context.conversationId)) return false;
    if (name === "notion" || name === "xmind") {
      const account = toolSettings[name]?.account;
      if (!account || !context || context.conversationKind !== "p2p" || context.agentId !== agentId
        || account.agentId !== context.agentId || account.ownerUserId !== context.userId) return false;
    }
    if (name === "present_output" && !context?.presentOutput) return false;
    if (name === "documents") return Boolean(context && documents?.canAccess(context));
    if (name === "voice_call" && (!context?.voiceCall || context.subagent || context.taskRunId || context.backgroundTaskKind || context.conversationKind !== "p2p")) return false;
    if (name === "ask_user_question" && (!context?.askUserQuestion || !context.conversationId
      || !context.userId || context.taskRunId || context.backgroundTaskKind)) return false;
    if (name === "markdown" && (!context || context.agentId !== agentId || context.conversationKind !== "p2p" || !context.conversationId)) return false;
    if (name === "google_calendar" || name === "google_drive" || name === "gmail" || name === "todoist") {
      if (!context || context.conversationKind !== "p2p") return false;
      const binding = toolSettings[name];
      if (binding && (binding.agentId !== context.agentId || binding.ownerUserId && binding.ownerUserId !== context.userId)) return false;
      if ((context.taskRunId || context.backgroundTaskKind === "proactive")
        && !canReadProductivityTask(binding, context, name, verifyProactiveRun)) return false;
    }
    // Agent capability: maintaining a skill never requires loading its project or mounting its tools.
    if (name === "skills") return Boolean(context && context.agentId === agentId
      && (context.backgroundTaskKind !== "proactive" || context.taskRunId && verifyProactiveRun?.(context))
      && (agentSkills?.canAccessSession(context, context.sessionId) || skills?.canAccessSession(context, context.sessionId)));
    if (name === "proactive_tasks" && (!context || context.conversationKind !== "p2p" || !context.conversationId || !context.userId)) return false;
    if (name === "phone_notifications" && (!context || context.agentId !== agentId || context.conversationKind !== "p2p"
      || !context.conversationId || !context.userId || !context.principalId || context.backgroundTaskKind && !context.taskRunId)) return false;
    // Run leases constrain authorization, not capability discovery. In particular,
    // workspace/file tools use the same catalogue and project selection as user turns.
    const requiredSkill = catalog.get(name)?.requiredSkill;
    if (!privateNames.has(name) && !requiredSkill) return true;
    if (!context || context.agentId !== agentId || !skills?.canAccess(context)) return false;
    return !requiredSkill || skills.isLoaded(context, context.sessionId, requiredSkill);
  };
}
