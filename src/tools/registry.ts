import { createSubagentsTool } from "./subagents.js";
import { createScheduleTool } from "./schedule.js";
import type { ScheduleStore } from "../schedule/store.js";
import { createBrowserTool } from "./browser.js";
import type { BrowserService } from "../browser/service.js";
import { createProactiveTasksTool } from "./proactive-tasks.js";
import { createPhoneNotificationsTool } from "./phone-notifications.js";
import { createCodexTool } from "./codex.js";
import { createConversationHistoryTool } from "./conversation-history.js";
import type { CodexService } from "../codex/service.js";
import type { ProjectSpaceFiles } from "../project-spaces/files.js";
import { createProjectFilesTool } from "./project-files.js";
import { createDocumentsTool } from "./documents.js";
import { createFileWorkbenchTools } from "./file-workbench.js";
import type { FileWorkbench } from "../file-workbench/service.js";
import type { DocumentCapability } from "../capabilities/documents/service.js";
import { createLongTermMemoryTool } from "./long-term-memory.js";
import { createPresentOutputTool } from "./present-output.js";
import { createAskUserQuestionTool } from "./ask-user-question.js";
import type { SQLiteSkillService } from "../skills/service.js";
import type { SQLiteAgentSkillService } from "../skills/agent-skills.js";
import { createLoadSkillTool, createUpdateSkillTool } from "./skills.js";
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
import { createGoogleDriveTool } from "./google-drive.js";
import { createTodoistTool } from "./todoist.js";
import type { UserLocationAccess } from "../location/service.js";
import { createBeijingSubwayTool } from "./beijing-subway.js";
import type { BeijingSubway } from "../transit/beijing-subway.js";
import { createUserLocationTool } from "./user-location.js";
import { object, operationTitle } from "./operation-policy.js";
import { genericToolActivity, hiddenToolActivity, webSearchActivity, type ToolActivityPresenter } from "./activity-presentation.js";
import { createToolAccessPolicy } from "./tool-access.js";
import { createToolDefinitionProjector } from "./tool-definitions.js";
import { createToolExecutor } from "./tool-execution.js";
import type { AgentToolRegistration, AgentToolSet, ToolExecutionContext } from "./tool-contracts.js";

export type { AgentToolRegistration, AgentToolSet, ToolExecutionContext } from "./tool-contracts.js";

export class AgentToolRegistry {
  private readonly catalog = new Map<string, AgentToolRegistration>();

  constructor(private readonly skills?: SQLiteSkillService, private readonly verifyProactiveRun?: (context: ToolExecutionContext) => boolean,
    private readonly agentSkills?: SQLiteAgentSkillService, private readonly projectFiles?: ProjectSpaceFiles, private readonly documents?: DocumentCapability) {}

  register(tool: AgentToolRegistration): this {
    const name = tool.definition.name;
    if (this.catalog.has(name)) throw new Error(`Tool ${name} is already registered`);
    if (!tool.activity) throw new Error(`Tool ${name} must define user-facing activity translations`);
    this.catalog.set(name, Object.freeze({
      definition: Object.freeze({ ...tool.definition }),
      executionMode: tool.executionMode,
      available: tool.available,
      requiredSkill: ["health_data", "health_tasks"].includes(name) ? "health" : tool.requiredSkill,
      activity: tool.activity,
      prepare: tool.prepare,
      execute: tool.execute
    }));
    return this;
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
      skills: this.skills, agentSkills: this.agentSkills, projectFiles: this.projectFiles, documents: this.documents,
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
        if (operationTitle(name, input) && name !== "codex" && name !== "documents") {
          if (phase === "completed" && object(outcome).status === "pending_confirmation") return { message: "变更已展示，等你点击确认后再执行。" };
        }
        const presenter = this.catalog.get(name)?.activity
          ?? hostedCatalog.get(name)?.activity
          ?? genericToolActivity;
        if (phase === "completed") return presenter.completed(input, outcome, context);
        if (phase === "failed") return presenter.failed(input, String(outcome ?? "未知错误"), context);
        return presenter.started(input, context);
      },
      executionMode: (name: string) => this.catalog.get(name)?.executionMode ?? "parallel",
      execute
    });
  }
}

export type AgentToolDependencies = {
  schedule?: ScheduleStore;
  fileWorkbench?: FileWorkbench;
  conversationHistory?: Parameters<typeof createConversationHistoryTool>[0];
  codex?: CodexService;
  projectFiles?: ProjectSpaceFiles;
  documents?: DocumentCapability;
  browser?: BrowserService;
  longTermMemory?: Parameters<typeof createLongTermMemoryTool>[0];
  proactiveTasks?: AgentToolRegistration;
  phoneNotifications?: Parameters<typeof createPhoneNotificationsTool>[0];
  verifyProactiveRun?: (context: ToolExecutionContext) => boolean;
  userLocation?: UserLocationAccess;
  beijingSubway?: BeijingSubway;
  skills?: SQLiteSkillService;
  agentSkills?: SQLiteAgentSkillService;
  skillTools?: readonly AgentToolRegistration[];
};

export function createDefaultToolRegistry(
  toolSettings: AgentToolSettings = {},
  dependencies: AgentToolDependencies = {}
): AgentToolRegistry {
  const registry = new AgentToolRegistry(dependencies.skills, dependencies.verifyProactiveRun, dependencies.agentSkills, dependencies.projectFiles, dependencies.documents)
    .register(createSubagentsTool())
    .register(createScheduleTool(dependencies.schedule))
    .register(createConversationHistoryTool(dependencies.conversationHistory))
    .register(createCodexTool(dependencies.codex))
    .register(createBrowserTool(dependencies.browser))
    .register(createProjectFilesTool(dependencies.projectFiles))
    .register(createDocumentsTool(dependencies.documents))
    .register(createLongTermMemoryTool(dependencies.longTermMemory, dependencies.verifyProactiveRun))
    .register(dependencies.proactiveTasks ?? createProactiveTasksTool())
    .register(createPhoneNotificationsTool(dependencies.phoneNotifications))
    .register(createPresentOutputTool())
    .register(createBeijingSubwayTool(dependencies.beijingSubway))
    .register(createAskUserQuestionTool())
    .register(createLoadSkillTool(dependencies.skills, dependencies.agentSkills, dependencies.projectFiles))
    .register(createUpdateSkillTool(dependencies.skills, dependencies.agentSkills, dependencies.projectFiles))
    .register(createFeishuCliTool())
    .register(createViewSessionImageTool())
    .register(createImageGenerationTool())
    .register(createVideoGenerationTool())
    .register(createGoogleCalendarTool(toolSettings.google_calendar, undefined, dependencies.verifyProactiveRun))
    .register(createGoogleDriveTool(toolSettings.google_drive))
    .register(createTodoistTool(toolSettings.todoist, undefined, dependencies.verifyProactiveRun));
  if (toolSettings.notion) {
    const { account, serverUrl, proxyUrl, callbackUrl } = toolSettings.notion;
    registry.register(createNotionTool(createNotionMcpGateway(account, serverUrl, proxyUrl, callbackUrl)));
  }
  if (toolSettings.xmind) {
    const { account, serverUrl } = toolSettings.xmind;
    registry.register(createXmindTool(createXmindMcpGateway(account, serverUrl)));
  }
  for (const name of ["health_data", "health_tasks"]) {
    const tool = dependencies.skillTools?.find((candidate) => candidate.definition.name === name);
    registry.register(tool ?? {
      requiredSkill: "health",
      available: false,
      definition: { type: "function", name, description: "Private health project capability.", input_schema: { type: "object", properties: {} } },
      activity: { started: () => ({ message: "我正在查看健康项目。" }), completed: () => ({ message: "我已经查看健康项目。" }), failed: () => ({ message: "这次未能查看健康项目。" }) },
      execute: async () => { throw new Error("This health capability is not configured"); }
    });
  }
  for (const tool of createFileWorkbenchTools(dependencies.fileWorkbench)) registry.register(tool);
  if (dependencies.userLocation) registry.register(createUserLocationTool(dependencies.userLocation));
  return registry;
}

export function createAgentToolSet(
  agentId: string,
  allowlist: readonly string[],
  toolSettings: AgentToolSettings = {},
  dependencies: AgentToolDependencies = {}
): AgentToolSet {
  // Each runtime gets fresh tool instances, so mutable confirmation and
  // guidance state cannot leak between agents.
  return createDefaultToolRegistry(toolSettings, dependencies).createToolSet(agentId, allowlist, toolSettings);
}
