import { createSubagentsTool } from "./subagents.js";
import type { BrowserService } from "../browser/service.js";
import { createProactiveTasksTool } from "./proactive-tasks.js";
import { createPhoneNotificationsTool } from "./phone-notifications.js";
import { createCodexTool } from "./codex.js";
import { createConversationHistoryTool } from "./conversation-history.js";
import type { CodexService } from "../codex/service.js";
import type { ProjectSpaceFiles } from "../project-spaces/files.js";
import { createFileWorkbenchTools } from "./file-workbench.js";
import type { FileWorkbench } from "../file-workbench/service.js";
import type { DocumentCapability } from "../capabilities/documents/service.js";
import { createMarkdownTool, type MemoryDocumentAccess } from "./markdown.js";
import { createPresentOutputTool } from "./present-output.js";
import { createImageAssetsTool } from "./image-assets.js";
import { createVoiceCallTool } from "./voice-call.js";
import { createAskUserQuestionTool } from "./ask-user-question.js";
import type { SQLiteSkillService } from "../skills/service.js";
import type { SQLiteAgentSkillService } from "../skills/agent-skills.js";
import { createSkillsTool, SkillDocuments } from "./skills.js";
import type { AgentToolSettings } from "../config.js";
import type { ModelHostedTool } from "../models/types.js";
import { createFeishuCliTool } from "./feishu-cli.js";
import { createImageGenerationTool } from "./image-generation.js";
import { createViewSessionImageTool } from "./view-session-image.js";
import { createVideoGenerationTool } from "./video-generation.js";
import { createXmindTool } from "./xmind.js";
import { createXmindMcpGateway } from "../xmind/client.js";
import { createNotionTool } from "./notion.js";
import { createNotionMcpGateway } from "../notion/client.js";
import { createGoogleCalendarTool } from "./google-calendar.js";
import { createGmailTool } from "./gmail.js";
import { createGoogleDriveTool } from "./google-drive.js";
import { createTodoistTool } from "./todoist.js";
import type { UserLocationAccess } from "../location/service.js";
import { createBeijingSubwayTool } from "./beijing-subway.js";
import type { BeijingSubway } from "../transit/beijing-subway.js";
import { object, operationTitle } from "./operation-policy.js";
import { genericToolActivity, hiddenToolActivity, webSearchActivity, type ToolActivityPresenter } from "./activity-presentation.js";
import { createToolAccessPolicy } from "./tool-access.js";
import { createToolDefinitionProjector } from "./tool-definitions.js";
import { createToolExecutor } from "./tool-execution.js";
import type { AgentToolRegistration, AgentToolSet, ToolExecutionContext } from "./tool-contracts.js";
import type { PluginSource } from "../plugins/contracts.js";
import { livePluginTools } from "../plugins/tools.js";

export type { AgentToolRegistration, AgentToolSet, ToolExecutionContext } from "./tool-contracts.js";

export class AgentToolRegistry {
  private readonly catalog = new Map<string, AgentToolRegistration>();

  constructor(private readonly skills?: SQLiteSkillService, private readonly verifyProactiveRun?: (context: ToolExecutionContext) => boolean,
    private readonly agentSkills?: SQLiteAgentSkillService, private readonly documents?: DocumentCapability) {}

  register(tool: AgentToolRegistration): this {
    const name = tool.definition.name;
    if (this.catalog.has(name)) throw new Error(`Tool ${name} is already registered`);
    if (!tool.activity) throw new Error(`Tool ${name} must define user-facing activity translations`);
    this.catalog.set(name, Object.freeze({
      definition: Object.freeze({ ...tool.definition }),
      executionMode: tool.executionMode,
      operationRecovery: tool.operationRecovery,
      available: tool.available,
      requiredSkill: ["health_data", "health_tasks"].includes(name) ? "health" : tool.requiredSkill,
      activity: tool.activity,
      resultFailed: tool.resultFailed,
      prepare: tool.prepare,
      execute: tool.execute
    }));
    return this;
  }

  withTools(tools: readonly AgentToolRegistration[]): AgentToolRegistry {
    const registry = new AgentToolRegistry(this.skills, this.verifyProactiveRun, this.agentSkills, this.documents);
    // Preserve host-owned tool instances and account/confirmation state across catalog leases.
    for (const tool of this.catalog.values()) registry.register(tool);
    for (const tool of tools) registry.register(tool);
    return registry;
  }

  createToolSet(
    agentId: string,
    allowlist: readonly string[],
    toolSettings: AgentToolSettings = {}
  ): AgentToolSet {
    const hostedCatalog = new Map<string, { definition: ModelHostedTool; activity: ToolActivityPresenter }>([[
      "web_search",
      Object.freeze({
        definition: Object.freeze({
          type: "web_search",
          search_context_size: "medium",
          ...toolSettings.web_search
        }),
        activity: webSearchActivity
      })
    ]]);
    const names = Object.freeze([...allowlist]);
    const unknown = names.filter((name) => !this.catalog.has(name) && !hostedCatalog.has(name));
    if (unknown.length > 0) {
      throw new Error(`Agent ${agentId} enables unregistered tools: ${unknown.join(", ")}`);
    }
    const allowed = new Set(names);
    const localNames = Object.freeze(names.filter((name) => this.catalog.has(name)));
    const isAvailable = createToolAccessPolicy({
      agentId, allowed, catalog: this.catalog, toolSettings,
      skills: this.skills, agentSkills: this.agentSkills, documents: this.documents,
      verifyProactiveRun: this.verifyProactiveRun
    });
    const definitionsFor = createToolDefinitionProjector({
      names, catalog: this.catalog, hostedCatalog, isAvailable
    });
    const execute = createToolExecutor({
      agentId, allowed, catalog: this.catalog, hostedCatalog, isAvailable,
      verifyProactiveRun: this.verifyProactiveRun
    });
    const definitions = definitionsFor();
    return Object.freeze({
      names,
      localNames,
      definitions,
      definitionsFor,
      isAvailable,
      allows: (name: string) => allowed.has(name),
      isLocal: (name: string) => allowed.has(name) && this.catalog.has(name),
      presentActivity: (name, phase, input, outcome, context) => {
        if (name === "prepare_image_generation") return hiddenToolActivity();
        const presenter = this.catalog.get(name)?.activity
          ?? hostedCatalog.get(name)?.activity
          ?? genericToolActivity;
        if (phase === "completed") {
          if (object(outcome).status === "pending_confirmation" && name !== "codex" && name !== "documents" && operationTitle(name, input)) {
            const { title, actionKind } = presenter.started(input, context);
            return { ...(title === undefined ? {} : { title }), ...(actionKind === undefined ? {} : { actionKind }),
              message: "变更已展示，等你点击确认后再执行。" };
          }
          return presenter.completed(input, outcome, context);
        }
        if (phase === "failed") return presenter.failed(input, String(outcome ?? "未知错误"), context);
        return presenter.started(input, context);
      },
      executionMode: (name: string) => this.catalog.get(name)?.executionMode ?? "parallel",
      resultFailed: (name: string, result: unknown) => this.catalog.get(name)?.resultFailed?.(result) ?? false,
      execute
    });
  }
}

export type AgentToolDependencies = {
  plugins?: PluginSource;
  pluginTools?: readonly AgentToolRegistration[];
  fileWorkbench?: FileWorkbench;
  conversationHistory?: Parameters<typeof createConversationHistoryTool>[0];
  codex?: CodexService;
  projectFiles?: ProjectSpaceFiles;
  documents?: DocumentCapability;
  browser?: BrowserService;
  longTermMemory?: MemoryDocumentAccess;
  markdownSkillAccess?: boolean;
  proactiveTasks?: AgentToolRegistration;
  phoneNotifications?: Parameters<typeof createPhoneNotificationsTool>[0];
  verifyProactiveRun?: (context: ToolExecutionContext) => boolean;
  userLocation?: UserLocationAccess;
  beijingSubway?: BeijingSubway;
  skills?: SQLiteSkillService;
  agentSkills?: SQLiteAgentSkillService;
};

export function createDefaultToolRegistry(
  toolSettings: AgentToolSettings = {},
  dependencies: AgentToolDependencies = {}
): AgentToolRegistry {
  const skills = new SkillDocuments(dependencies.skills, dependencies.agentSkills);
  const registry = new AgentToolRegistry(dependencies.skills, dependencies.verifyProactiveRun, dependencies.agentSkills, dependencies.documents)
    .register(createSubagentsTool())
    .register(createConversationHistoryTool(dependencies.conversationHistory))
    .register(createCodexTool(dependencies.codex))
    .register(createMarkdownTool(dependencies.longTermMemory, dependencies.markdownSkillAccess ? skills : undefined, dependencies.verifyProactiveRun))
    .register(dependencies.proactiveTasks ?? createProactiveTasksTool())
    .register(createPhoneNotificationsTool(dependencies.phoneNotifications))
    .register(createPresentOutputTool())
    .register(createImageAssetsTool(dependencies.fileWorkbench,dependencies.browser))
    .register(createBeijingSubwayTool(dependencies.beijingSubway))
    .register(createAskUserQuestionTool())
    .register(createVoiceCallTool())
    .register(createSkillsTool(skills, dependencies.fileWorkbench))
    .register(createFeishuCliTool())
    .register(createViewSessionImageTool())
    .register(createImageGenerationTool())
    .register(createVideoGenerationTool())
    .register(createGoogleCalendarTool(toolSettings.google_calendar, undefined, dependencies.verifyProactiveRun))
    .register(createGoogleDriveTool(toolSettings.google_drive))
    .register(createGmailTool(toolSettings.gmail, dependencies.fileWorkbench))
    .register(createTodoistTool(toolSettings.todoist, undefined, dependencies.verifyProactiveRun));
  if (toolSettings.notion) {
    const { account, serverUrl, proxyUrl, callbackUrl } = toolSettings.notion;
    registry.register(createNotionTool(createNotionMcpGateway(account, serverUrl, proxyUrl, callbackUrl)));
  }
  if (toolSettings.xmind) {
    const { account, serverUrl } = toolSettings.xmind;
    registry.register(createXmindTool(createXmindMcpGateway(account, serverUrl)));
  }
  for (const tool of dependencies.pluginTools ?? []) registry.register(tool);
  for (const tool of createFileWorkbenchTools(dependencies.fileWorkbench)) registry.register(tool);
  return registry;
}

export function createAgentToolSet(
  agentId: string,
  allowlist: readonly string[],
  toolSettings: AgentToolSettings = {},
  dependencies: AgentToolDependencies = {}
): AgentToolSet {
  dependencies = { ...dependencies, markdownSkillAccess: allowlist.includes("skills") };
  if (dependencies.plugins) {
    const registry = createDefaultToolRegistry(toolSettings, { ...dependencies, plugins: undefined, pluginTools: [] });
    return livePluginTools(dependencies.plugins, snapshot => ({
      ...registry.withTools(snapshot.tools).createToolSet(agentId, allowlist, toolSettings),
      skillContextFor: async scope => (await Promise.all([
        dependencies.skills?.contextFor(scope, scope.sessionId), dependencies.agentSkills?.contextFor(scope, scope.sessionId)
      ])).filter(Boolean).join("\n\n")
    }), allowlist);
  }
  // Each runtime gets fresh tool instances, so mutable confirmation and
  // guidance state cannot leak between agents.
  return createDefaultToolRegistry(toolSettings, dependencies).createToolSet(agentId, allowlist, toolSettings);
}
