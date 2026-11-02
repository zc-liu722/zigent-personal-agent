import { BackgroundScheduler, watchBackgroundInputs } from "./background-scheduler.js";
import { SubagentStore } from "./agent/subagent-store.js";
import { ScheduleReminders } from "./schedule/reminders.js";
import { ScheduleStore } from "./schedule/store.js";
import { PerformanceStore } from "./performance/store.js";
import { instrumentAsync } from "./performance/instrument.js";
import { BrowserService } from "./browser/service.js";
import { dirname, resolve } from "node:path";
import { BeijingSubway } from "./transit/beijing-subway.js";
import { UsageStore } from "./usage/store.js";
import { UsageReconciler } from "./usage/reconcile.js";
import { createProactiveTasksTool } from "./tools/proactive-tasks.js";
import { ProactiveTaskRuntime, canReadTaskLocation, verifyProactiveRun } from "./tasks/runtime.js";
import type { AgentConfig } from "./config.js";
import { AgentExecutor } from "./agent/executor.js";
import { ImageGenerationGateway } from "./image-generation.js";
import { ModelGateway } from "./llm.js";
import { createMemoryOrchestrator } from "./memory/index.js";
import { FileLongTermMemoryRepository } from "./memory/long-term.js";
import type { MemoryOrchestrator } from "./memory/orchestrator.js";
import { createAgentToolSet, type AgentToolSet } from "./tools/registry.js";
import { SupplierHealthRegistry } from "./models/supplier-health.js";
import { VideoGenerationGateway } from "./video-generation.js";
import { UserLocationAccess } from "./location/service.js";
import { UserHealthAccess } from "./health/service.js";
import { SQLiteSkillService } from "./skills/service.js";
import { SQLiteAgentSkillService } from "./skills/agent-skills.js";
import { TaskStore } from "./tasks/store.js";
import { legacyTaskModel } from "./tasks/model-defaults.js";
import { HealthTaskRuntime } from "./health-runtime.js";
import { createHealthDataTool } from "./tools/health-data.js";
import { createHealthTasksTool } from "./tools/health-tasks.js";
import { BarkTransport } from "./notifications/bark.js";
import { NotificationService } from "./notifications/service.js";
import { CodexService } from "./codex/service.js";
import { ProjectSpaceFiles } from "./project-spaces/files.js";
import { DocumentCapability } from "./capabilities/documents/service.js";
import { FileWorkbench } from "./file-workbench/service.js";

export type AgentRuntime = {
  readonly scheduler: BackgroundScheduler;
  readonly schedule?: ScheduleStore;
  readonly scheduleReminders?: ScheduleReminders;
  readonly fileWorkbench?: FileWorkbench;
  readonly codex?: CodexService;
  readonly projectFiles?: ProjectSpaceFiles;
  readonly documents?: DocumentCapability;
  readonly browser?: BrowserService;
  readonly config: AgentConfig;
  readonly usage?: UsageStore;
  readonly performance?: PerformanceStore;
  readonly usageReconciler?: UsageReconciler;
  readonly model: ModelGateway;
  readonly agent: AgentExecutor;
  readonly subagents: SubagentStore;
  readonly memory: MemoryOrchestrator;
  readonly longTermMemory?: FileLongTermMemoryRepository;
  readonly tools: AgentToolSet;
  readonly imageGeneration: ImageGenerationGateway;
  readonly videoGeneration: VideoGenerationGateway;
  readonly location?: UserLocationAccess;
  readonly health?: UserHealthAccess;
  readonly skills?: SQLiteSkillService;
  readonly agentSkills?: SQLiteAgentSkillService;
  readonly proactiveTasks?: TaskStore;
  readonly proactiveRunner?: ProactiveTaskRuntime;
  readonly healthTasks?: TaskStore;
  readonly healthRunner?: HealthTaskRuntime;
  readonly notifications?: NotificationService;
  close(): Promise<void>;
};

export async function createAgentRuntime(config: AgentConfig): Promise<AgentRuntime> {
  const scheduler = new BackgroundScheduler();
  const supplierHealth = new SupplierHealthRegistry();
  let usage: UsageStore | undefined;
  const recordUsage: import("./usage/types.js").UsageRecorder = event => usage!.record(event);
  const imageSource = new ImageGenerationGateway(config, supplierHealth, recordUsage);
  const videoSource = new VideoGenerationGateway(config, supplierHealth, recordUsage);
  const location = config.location ? await UserLocationAccess.create(config.location) : undefined;
  const model = new ModelGateway(config, supplierHealth, recordUsage);
  // Initialize the Agent-owned conversation database before attaching domain tables.
  const longTermMemory = new FileLongTermMemoryRepository(config.longTermMemoryPath, config.id);
  const memorySource = await createMemoryOrchestrator(config, model, longTermMemory);
  const performance = new PerformanceStore(config.memoryStoragePath, config.id);
  model.performance = performance;
  const imageGeneration = instrumentAsync(imageSource, performance, "media.image", ["generate", "conversation"]);
  const videoGeneration = instrumentAsync(videoSource, performance, "media.video", ["generate"]);
  const memory = instrumentAsync(memorySource, performance, "memory.operation", ["prepareTurn", "prepareBackgroundContext", "prepareImageContext", "queryConversationHistory", "recordAssistantReply", "getSession", "getRecentUserRequests", "resumePreviousSession", "startNewSession"]);
  usage = new UsageStore(config.memoryStoragePath, config.id, config);
  usage.importHistory();
  usage.backfillPrices();
  const usageReconciler = new UsageReconciler(usage, config, performance);
  const notifications = config.notifications ? new NotificationService({
    databasePath: config.memoryStoragePath, agentId: config.id, ownerUserId: config.notifications.ownerUserId,
    transport: instrumentAsync(new BarkTransport(config.notifications, config.name), performance, "notification.send", ["send"])
  }, scheduler) : undefined;
  const health = config.health ? await UserHealthAccess.create(config.health) : undefined;
  const agentSkills = new SQLiteAgentSkillService(config.memoryStoragePath, config.id);
  agentSkills.initialize();
  const taskModels = {
    defaultModel: () => model.defaultProvider,
    legacyDefaultModel: config.models?.find(item => item.name === legacyTaskModel)?.name ?? model.defaultProvider
  };
  const proactiveTasks = config.allowedTools.includes("proactive_tasks") ? new TaskStore({
    ...taskModels,
    databasePath: `${config.memoryStoragePath}.proactive.sqlite`, agentId: config.id,
    ...(config.channel === "web" ? { ownerUserId: config.web?.ownerUserId } : {}),
    deliveryDatabasePath: config.memoryStoragePath
  }) : undefined;
  const healthTasks = health ? new TaskStore({ databasePath: config.memoryStoragePath,
    ...taskModels, agentId: config.id, ownerUserId: health.config.ownerUserId }) : undefined;
  const skills = health ? new SQLiteSkillService({ databasePath: config.memoryStoragePath,
    agentId: config.id, ownerUserId: health.config.ownerUserId, ownerPrincipalId: health.config.ownerPrincipalId,
    ...(health.config.initialSkillPath ? { statePath: health.config.initialSkillPath } : {}),
    projectDiary: () => health.store.recentProjectDiary(),
    verifyTaskRun: (scope, runId) => {
      if (scope.backgroundTaskKind === "proactive") return Boolean(proactiveTasks && verifyProactiveRun(proactiveTasks, scope));
      const run = healthTasks?.getRun(runId);
      const task = run ? healthTasks?.get(run.taskId) : undefined;
      return run?.state === "running" && Boolean(scope.taskLeaseToken) && run.leaseToken === scope.taskLeaseToken
        && (run.leaseUntil ?? 0) > Date.now() && task?.status === "active" && task.revision === run.taskRevision
        && task.agentId === scope.agentId && task.userId === scope.userId
        && task.conversationId === scope.conversationId;
    }
  }) : undefined;
  await skills?.initialize();
  const codex = CodexService.fromConfig(config, proactiveTasks ? context => verifyProactiveRun(proactiveTasks, context) : undefined, model);
  const projectFiles = ProjectSpaceFiles.fromConfig(config, model);
  const fileWorkbench = FileWorkbench.fromConfig(config);
  const documents = fileWorkbench ? undefined : DocumentCapability.fromConfig(config, model, projectFiles);
  const browser = config.channel === "web" && config.web?.ownerUserId && config.allowedTools.includes("browser")
    ? new BrowserService({ agentId: config.id, ownerUserId: config.web.ownerUserId, directory: config.memoryStoragePath + ".browsers", proxyUrl: config.zenmuxProxyUrl,
      verifyBackground: scope => Boolean(proactiveTasks && verifyProactiveRun(proactiveTasks, scope)) }) : undefined;
  let scheduleReminders: ScheduleReminders | undefined;
  const schedule = config.allowedTools.includes("schedule") && config.web?.ownerUserId ? new ScheduleStore(`${config.memoryStoragePath}.schedule.sqlite`, config.id, config.web.ownerUserId,
    config.channel === "web", id => scheduleReminders?.changed(id)) : undefined;
  if (schedule) scheduleReminders = new ScheduleReminders(schedule, notifications, scheduler);
  const toolSource = createAgentToolSet(config.id, config.allowedTools, { ...config.toolSettings,
    ...(codex ? { codex: { agentId: config.id, ownerUserId: codex.options.ownerUserId } } : {}) }, {
    codex, projectFiles, documents, browser, fileWorkbench, schedule,
    conversationHistory: memory,
    phoneNotifications: proactiveTasks && config.channel === "web" && config.web?.ownerUserId && config.web.ownerPrincipalId
      ? { store: proactiveTasks, agentId: config.id, ownerUserId: config.web.ownerUserId, ownerPrincipalId: config.web.ownerPrincipalId,
          verifyProactiveRun: context => verifyProactiveRun(proactiveTasks, context) } : undefined,
    longTermMemory: config.channel === "web" && config.web?.ownerUserId && config.web.ownerPrincipalId
      ? { agentId: config.id, repository: longTermMemory, ownerUserId: config.web.ownerUserId, ownerPrincipalId: config.web.ownerPrincipalId } : undefined,
    proactiveTasks: proactiveTasks ? createProactiveTasksTool({ store: proactiveTasks,
      supportsLocation: (scope) => canReadTaskLocation(location, scope),
      supportsHealth: (scope) => Boolean(health && skills?.canAccess(scope)),
      initialHealthCursor: () => health?.store.highWaterSeq() ?? 0,
      seedLocation: (task) => {
        if (task.trigger.type !== "location" || !task.trigger.center || !canReadTaskLocation(location, task)) return;
        const point = location?.store.latest();
        if (point) proactiveTasks.seedLocation(task.id, point);
      }
    }) : undefined,
    verifyProactiveRun: proactiveTasks ? (context) => verifyProactiveRun(proactiveTasks, context) : undefined,
    userLocation: location,
    beijingSubway: config.allowedTools.includes("beijing_subway") ? new BeijingSubway(resolve(dirname(config.memoryStoragePath), "..", "beijing-subway")) : undefined,
    skills,
    agentSkills,
    skillTools: health && healthTasks ? [createHealthDataTool(health), createHealthTasksTool({
      store: healthTasks, initialHealthCursor: () => health.store.highWaterSeq(),
      supportsLocation: () => Boolean(location?.store.isOwner(
        health.config.ownerPrincipalId ?? health.config.ownerUserId, [health.config.ownerUserId]))
    })] : [],
  });
  const tools = instrumentAsync(toolSource, performance, "tool.call", ["execute"]);
  const subagents = new SubagentStore(config.memoryStoragePath, config.id);
  const agent = new AgentExecutor(model, tools, context => context ? browser?.retainForRun(context) : undefined, subagents);
  const proactiveRunner = proactiveTasks ? new ProactiveTaskRuntime({ scheduler, tasks: proactiveTasks, agent, memory, performance,
    get defaultProvider() { return model.defaultProvider; }, location, health, skills }) : undefined;
  const healthRunner = health && skills && healthTasks ? new HealthTaskRuntime({
    scheduler, agentId: config.id, health, skills, tasks: healthTasks, agent, memory, performance,
    get defaultProvider() { return model.defaultProvider; }, location
  }) : undefined;
  const stopInputWatch = watchBackgroundInputs(
    [health?.config.storagePath, location?.config.storagePath].filter((path): path is string => Boolean(path)),
    () => { proactiveRunner?.wake(); healthRunner?.wake(); }
  );
  usageReconciler.start();
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    stopInputWatch();
    await scheduleReminders?.close();
    await proactiveRunner?.close();
    await healthRunner?.close();
    await agent.close();
    await browser?.close();
    await fileWorkbench?.close();
    schedule?.close();
    proactiveTasks?.close();
    healthTasks?.close();
    skills?.close();
    agentSkills?.close();
    health?.close();
    await notifications?.close();
    codex?.close();
    location?.close();
    await usageReconciler.close();
    await model.close();
    subagents.close();
    usage?.close();
    memory.close();
    performance.close();
  })();
  model.enableCodexWarmup();
  return Object.freeze({ scheduler, schedule, scheduleReminders, config, performance, usage, usageReconciler, model, agent, memory, longTermMemory, tools, imageGeneration, videoGeneration, location, codex, projectFiles, documents, browser, fileWorkbench,
    health, skills, agentSkills, healthTasks, healthRunner, notifications, proactiveTasks, proactiveRunner, subagents, close });
}
