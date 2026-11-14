import { BackgroundScheduler, watchBackgroundInputs } from "./background-scheduler.js";
import { SubagentStore } from "./agent/subagent-store.js";
import type { ScheduleReminders } from "./plugins/schedule/reminders.js";
import type { ScheduleConnection, ScheduleCapability } from "./plugins/schedule/entry.js";
import { PluginHost } from "./plugins/host.js";
import { PluginInstallation, componentOwners, componentResources, componentRoutes } from "./plugins/installation.js";
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
import { modelCatalogSnapshot, type ModelCatalogSnapshot } from "./models/catalog.js";
import { createMemoryOrchestrator } from "./memory/index.js";
import { FileLongTermMemoryRepository } from "./memory/long-term.js";
import type { MemoryOrchestrator } from "./memory/orchestrator.js";
import { createAgentToolSet, type AgentToolSet } from "./tools/registry.js";
import { SupplierHealthRegistry } from "./models/supplier-health.js";
import { VideoGenerationGateway } from "./video-generation.js";
import { UserLocationAccess } from "./location/service.js";
import { MessageLocationEnrichment } from "./location/message-enrichment.js";
import { UserHealthAccess } from "./health/service.js";
import { SQLiteSkillService } from "./skills/service.js";
import { SQLiteAgentSkillService } from "./skills/agent-skills.js";
import { TaskStore } from "./tasks/store.js";
import { legacyTaskModel } from "./tasks/model-defaults.js";
import { HealthTaskRuntime } from "./health-runtime.js";
import { BarkTransport } from "./notifications/bark.js";
import { NotificationService } from "./notifications/service.js";
import { CodexService } from "./codex/service.js";
import { ProjectSpaceFiles } from "./project-spaces/files.js";
import type { RecordingWorkflow, RecordingConnection } from "./capabilities/recordings.js";
import { recordingObjectStorage } from "./capabilities/recording-storage.js";
import { DocumentCapability } from "./capabilities/documents/service.js";
import { isConfirmedOperation } from "./tools/confirmed-operation.js";
import type { ModelProtocolService } from "./plugins/model-http/entry.js";
import { ExecutionJournal } from "./agent/execution-journal.js";
import { FileWorkbench } from "./file-workbench/service.js";


export type AgentRuntime = {
  readonly recordingConnection: RecordingConnection;
  readonly scheduler: BackgroundScheduler;
  readonly plugins: PluginHost;
  readonly pluginInstallation: PluginInstallation;
  readonly executionJournal: ExecutionJournal;
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
  const model = new ModelGateway(config, supplierHealth, recordUsage);
  const bootstrapModelCatalog = modelCatalogSnapshot(config);
  const liveConfig: AgentConfig = { ...config,
    get providers() { return model.catalog?.providers ?? config.providers; },
    get models() { return model.catalog?.models ?? config.models; },
    get modelOrder() { return model.catalog?.modelOrder ?? config.modelOrder; },
    get providerOrder() { return model.catalog?.providerOrder ?? config.providerOrder; },
    get imageGeneration() { return model.catalog?.imageGeneration ?? config.imageGeneration; }
  };
  const imageSource = new ImageGenerationGateway(liveConfig, supplierHealth, recordUsage);
  const videoSource = new VideoGenerationGateway(config, supplierHealth, recordUsage);
  const location = config.location ? await UserLocationAccess.create(config.location) : undefined;
  // Initialize the Agent-owned conversation database before attaching domain tables.
  const longTermMemory = new FileLongTermMemoryRepository(config.longTermMemoryPath, config.id);
  const memorySource = await createMemoryOrchestrator(config, longTermMemory);
  const performance = new PerformanceStore(config.memoryStoragePath, config.id);
  model.performance = performance;
  const imageGeneration = instrumentAsync(imageSource, performance, "media.image", ["generate", "conversation"]);
  const videoGeneration = instrumentAsync(videoSource, performance, "media.video", ["generate"]);
  const memory = instrumentAsync(memorySource, performance, "memory.operation", ["prepareTurn", "prepareBackgroundContext", "prepareImageContext", "queryConversationHistory", "recordAssistantReply", "getSession", "getRecentUserRequests", "resumePreviousSession", "startNewSession"]);
  usage = new UsageStore(config.memoryStoragePath, config.id, config);
  usage.importHistory();
  usage.backfillPrices();
  const usageReconciler = new UsageReconciler(usage, liveConfig, performance);
  const notifications = config.notifications ? new NotificationService({
    databasePath: config.memoryStoragePath, agentId: config.id, ownerUserId: config.notifications.ownerUserId,
    transport: instrumentAsync(new BarkTransport(config.notifications, config.name), performance, "notification.send", ["send"])
  }, scheduler) : undefined;
  const health = config.health ? await UserHealthAccess.create(config.health) : undefined;
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
  const verifyTaskRun = (scope: import("./skills/service.js").SkillScope) => {
    const store = scope.backgroundTaskKind === "proactive" ? proactiveTasks : healthTasks;
    return Boolean(store && verifyProactiveRun(store, scope));
  };
  const agentSkills = new SQLiteAgentSkillService(config.memoryStoragePath, config.id, verifyTaskRun);
  agentSkills.initialize();
  const skills = health ? new SQLiteSkillService({ databasePath: config.memoryStoragePath,
    agentId: config.id, ownerUserId: health.config.ownerUserId, ownerPrincipalId: health.config.ownerPrincipalId,
    ...(health.config.initialSkillPath ? { statePath: health.config.initialSkillPath } : {}),
    projectDiary: () => health.store.recentProjectDiary(),
    verifyTaskRun
  }) : undefined;
  await skills?.initialize();
  const codex = CodexService.fromConfig(config, proactiveTasks ? context => verifyProactiveRun(proactiveTasks, context) : undefined, model);
  const projectFiles = ProjectSpaceFiles.fromConfig(config, agentSkills, model);
  await projectFiles?.initializeSkills(config.web?.ownerPrincipalId);
  const fileWorkbench = FileWorkbench.fromConfig(config, verifyTaskRun);
  const documents = fileWorkbench ? undefined : DocumentCapability.fromConfig(config, model, projectFiles);
  const browser = config.channel === "web" && config.web?.ownerUserId && config.allowedTools.includes("browser")
    ? new BrowserService({ agentId: config.id, ownerUserId: config.web.ownerUserId, directory: config.memoryStoragePath + ".browsers", proxyUrl: config.zenmuxProxyUrl,
      verifyBackground: scope => Boolean(proactiveTasks && verifyProactiveRun(proactiveTasks, scope)) }) : undefined;
  let scheduleReminders: ScheduleReminders | undefined;
  const schedule = config.allowedTools.includes("schedule") && config.web?.ownerUserId ? new ScheduleStore(`${config.memoryStoragePath}.schedule.sqlite`, config.id, config.web.ownerUserId,
    config.channel === "web", id => scheduleReminders?.changed(id)) : undefined;
  const scheduleConnection: ScheduleConnection = { started: false, paused: false };
  const recordingConnection: RecordingConnection = {
    config: config.web?.transcription ? {model:config.web.transcription.model,apiKey:config.web.transcription.apiKey} : undefined,
    objects: recordingObjectStorage(config.web?.transcription?.tos)
  };
  const executionJournal = new ExecutionJournal(`${config.memoryStoragePath}.execution.sqlite`, memory.conversationStore);
  const plugins = new PluginHost({ scheduleStore: schedule, notifications, scheduler, scheduleConnection, browser, documents, health, healthTasks, location, recordingConnection, confirmedOperation: isConfirmedOperation,
    modelCatalogBinding: config.modelCatalogBinding, bootstrapModelCatalog }, componentOwners, componentResources, componentRoutes);
  const pluginInstallation = await PluginInstallation.open(plugins, config.id, Object.keys(componentOwners));
  if (pluginInstallation.status().active.some(record => record.id === "model-catalog")) {
    model.connectCatalog(() => plugins.service<ModelCatalogSnapshot>("modelCatalog"));
  }
  agentSkills.connectCatalog(() => plugins.service<import("./skills/catalog.js").SkillCatalog>("skillCatalog"));
  skills?.connectDefaultRules(() => plugins.service<import("./skills/catalog.js").SkillCatalog>("skillCatalog").entries.find(skill => skill.name === "health")?.body);
  if (config.web?.ownerUserId && config.web.transcription) {
    const owner = { userId: config.web.ownerUserId, principalId: config.web.ownerPrincipalId };
    const workflow = plugins.service<RecordingWorkflow>("recordingWorkflow");
    agentSkills.seedSkills(owner, [workflow.skill]);
    for (const migration of workflow.migrations)
      agentSkills.migrateText(owner, workflow.skill.name, migration.id, migration.before, migration.after);
  }
  model.protocolAdapter = (route, request, updates) => plugins.service<ModelProtocolService>("modelProtocol").buildProtocolRequest(route, request, updates);
  const nativeServices = { "codex-app-server": ["model-codex", "codexModel"],
    "cursor-acp": ["model-cursor", "cursorModel"], "antigravity-acp": ["model-antigravity", "antigravityModel"] } as const;
  type NativeProtocol = keyof typeof nativeServices;
  function nativeAdapter(protocol: NativeProtocol): import("./models/types.js").ModelRoundAdapter {
    return async (...args) => {
      const [id, name] = nativeServices[protocol];
      const snapshot = plugins.snapshot([], [id]);
      try {
        const service = snapshot.services[name] as import("./models/types.js").NativeModelService | undefined;
        if (!service) throw new Error("NATIVE_MODEL_COMPONENT_NOT_READY");
        return await service.invoke(...args);
      } finally { snapshot.release(); }
    };
  }
  model.codexModel = nativeAdapter("codex-app-server");
  model.cursorModel = nativeAdapter("cursor-acp");
  model.antigravityModel = nativeAdapter("antigravity-acp");
  model.nativeModelService = protocol => {
    const entry = nativeServices[protocol as NativeProtocol];
    if (!entry) return;
    try { return plugins.service<import("./models/types.js").NativeModelService>(entry[1]); }
    catch { return undefined; }
  };
  imageSource.codexImageRound = async (...args) => {
    const snapshot = plugins.snapshot([], ["model-codex"]);
    try {
      const service = snapshot.services.codexModel as import("./models/codex-contract.js").CodexModelService | undefined;
      if (!service) throw new Error("CODEX_COMPONENT_NOT_READY");
      return await service.imageRound(...args);
    } finally { snapshot.release(); }
  };
  if (schedule) scheduleReminders = {
    get activeCount() { return plugins.service<ScheduleCapability>("schedule").reminders.activeCount; },
    changed: (id: string) => plugins.service<ScheduleCapability>("schedule").reminders.changed(id),
    connect: (delivery) => { scheduleConnection.delivery = delivery; plugins.service<ScheduleCapability>("schedule").reminders.connect(delivery); },
    start: () => { scheduleConnection.started = true; plugins.service<ScheduleCapability>("schedule").reminders.start(); },
    pause: (value: boolean) => { scheduleConnection.paused = value; plugins.service<ScheduleCapability>("schedule").reminders.pause(value); },
    close: async () => { scheduleConnection.started = false; await plugins.service<ScheduleCapability>("schedule").reminders.close(); }
  } as ScheduleReminders;
  const toolSource = createAgentToolSet(config.id, config.allowedTools, { ...config.toolSettings,
    ...(codex ? { codex: { agentId: config.id, ownerUserId: codex.options.ownerUserId } } : {}) }, {
    codex, projectFiles, documents, browser, fileWorkbench, plugins: pluginInstallation,
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

  });
  const tools = instrumentAsync(toolSource, performance, "tool.call", ["execute"]);
  const subagents = new SubagentStore(config.memoryStoragePath, config.id);
  const agent = new AgentExecutor(model, tools, context => context ? browser?.retainForRun(context) : undefined, subagents, executionJournal);
  const proactiveRunner = proactiveTasks ? new ProactiveTaskRuntime({ completeExecution:(runId,delivery)=>executionJournal.completeTask(runId,delivery), scheduler, tasks: proactiveTasks, agent, memory, performance,
    get defaultProvider() { return model.defaultProvider; }, location, health, skills }) : undefined;
  const healthRunner = health && skills && healthTasks ? new HealthTaskRuntime({
    completeExecution:(runId,delivery)=>executionJournal.completeTask(runId,delivery), scheduler, agentId: config.id, health, skills, tasks: healthTasks, agent, memory, performance,
    get defaultProvider() { return model.defaultProvider; }, location
  }) : undefined;
  const stopInputWatch = watchBackgroundInputs(
    [health?.config.storagePath, location?.config.storagePath].filter((path): path is string => Boolean(path)),
    () => { proactiveRunner?.wake(); healthRunner?.wake(); }
  );
  usageReconciler.start();
  const messageLocations = location && config.web?.ownerUserId ? new MessageLocationEnrichment(location.store,
    config.memoryStoragePath, config.id, [...new Set([config.web.ownerUserId, config.web.ownerPrincipalId,
      config.health?.ownerUserId, config.health?.ownerPrincipalId].filter((id): id is string => Boolean(id)))]) : undefined;
  messageLocations?.start();
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    stopInputWatch();
    messageLocations?.close();
    await scheduleReminders?.close();
    await proactiveRunner?.close();
    await healthRunner?.close();
    await agent.close();

    await browser?.close();
    await fileWorkbench?.close();
    await model.close();
    await pluginInstallation.close();
    executionJournal.close();
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
    subagents.close();
    usage?.close();
    memory.close();
    performance.close();
  })();
  model.startNativeWarmup();
  return Object.freeze({ recordingConnection, scheduler, plugins, pluginInstallation, executionJournal, schedule, scheduleReminders, config: liveConfig, performance, usage, usageReconciler, model, agent, memory, longTermMemory, tools, imageGeneration, videoGeneration, location, codex, projectFiles, documents, browser, fileWorkbench,
    health, skills, agentSkills, healthTasks, healthRunner, notifications, proactiveTasks, proactiveRunner, subagents, close });
}
