import { resolve, win32 } from "node:path";
import { z, type RefinementCtx } from "zod";
import type { AgentProfile, Manifest } from "./schemas.js";

export function validateManifest(manifest: Manifest, context: RefinementCtx): void {
  const canonicalPath = (value: string): string => /^[A-Za-z]:[\\/]/.test(value) ? win32.resolve(value).replace(/\\/g, "/").toLowerCase() : resolve(value);
  for (const [index, agent] of manifest.agents.entries()) {
    if (agent.channel !== "web" || !agent.web) continue;
    const occupied = [...manifest.agents.flatMap(profile => [profile.storage.sqlite, profile.storage.longTermMemory, ...(profile.id !== agent.id && profile.web ? [profile.web.storage] : [])]), manifest.integrations.location?.storage, manifest.integrations.health?.storage].filter((value): value is string => Boolean(value));
    if (occupied.some(path => canonicalPath(path) === canonicalPath(agent.web!.storage))) context.addIssue({ code: z.ZodIssueCode.custom, path: ["agents", index, "web", "storage"], message: "web storage must be dedicated" });
    if ([manifest.integrations.location?.listenPort, manifest.integrations.health?.listenPort, ...manifest.agents.filter(profile => profile.id !== agent.id && profile.enabled && profile.channel === "web").map(profile => profile.web?.listenPort)].includes(agent.web.listenPort)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["agents", index, "web", "listenPort"], message: "web listener must use a separate port" });
  }
  const dashboard = manifest.integrations.dashboard;
  if (dashboard) {
    if (!manifest.integrations.location || manifest.integrations.location.publicUrl && new URL(manifest.integrations.location.publicUrl).origin !== new URL(dashboard.publicUrl).origin)
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['integrations', 'dashboard', 'publicUrl'], message: 'dashboard requires the server gateway on the same public origin' });
    const occupied = [...manifest.agents.flatMap(agent => [agent.storage.sqlite, agent.storage.sqlite + ".performance.sqlite", agent.storage.longTermMemory, agent.web?.storage]), manifest.integrations.location?.storage, manifest.integrations.health?.storage].filter((path): path is string => Boolean(path));
    if (occupied.some(path => canonicalPath(path) === canonicalPath(dashboard.storage))) context.addIssue({ code: z.ZodIssueCode.custom, path: ['integrations', 'dashboard', 'storage'], message: 'dashboard authentication storage must be dedicated' });
    if (manifest.agents.some(agent => agent.id === 'dashboard')) context.addIssue({ code: z.ZodIssueCode.custom, path: ['integrations', 'dashboard'], message: 'dashboard is reserved for the server administration route' });
  }
  const proxyPort = manifest.integrations.location?.webProxyPort;
  if (proxyPort && !manifest.agents.some(agent => agent.enabled && agent.channel === "web" && agent.web?.listenPort === proxyPort)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["integrations", "location", "webProxyPort"], message: "web proxy must target an enabled web agent" });
  if (manifest.integrations.health) {
    const health = manifest.agents.find((agent) => agent.id === "deepmind");
    if (!health?.enabled || !health.allowedTools.includes("health_data")) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["integrations", "health"], message: "health requires enabled Deepmind with health_data" });
    }
    const canonicalStorage = (value: string): string => /^[A-Za-z]:[\\/]/.test(value)
      ? win32.resolve(value).replace(/\\/g, "/").toLowerCase() : resolve(value);
    const healthStorage = canonicalStorage(manifest.integrations.health.storage);
    if (manifest.agents.some((agent) => [agent.storage.sqlite, agent.storage.longTermMemory].some((path) => canonicalStorage(path) === healthStorage))
      || manifest.integrations.location && canonicalStorage(manifest.integrations.location.storage) === healthStorage) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["integrations", "health", "storage"], message: "health storage must be dedicated and separate from sessions, memory and location" });
    }
  }
  for (const [index, agent] of manifest.agents.entries()) {
    if (agent.id !== "deepmind" && ["health_data", "health_tasks"].some((name) => agent.allowedTools.includes(name))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["agents", index, "allowedTools"], message: "private health tools are restricted to Deepmind" });
    }
  }
  if (manifest.integrations.location) {
    const authorizedAgents = new Set(manifest.integrations.location.agents);
    for (const [authorizedIndex, agentId] of manifest.integrations.location.agents.entries()) {
      const profileIndex = manifest.agents.findIndex((profile) => profile.id === agentId);
      const profile = manifest.agents[profileIndex];
      if (!profile || !profile.enabled) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["integrations", "location", "agents", authorizedIndex],
          message: "location access must reference an enabled agent"
        });
      } else if (!profile.allowedTools.includes("user_location")) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agents", profileIndex, "allowedTools"],
          message: "location-authorized agents must enable user_location"
        });
      }
    }
    for (const [index, profile] of manifest.agents.entries()) {
      if (!authorizedAgents.has(profile.id) && profile.allowedTools.includes("user_location")) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agents", index, "allowedTools"],
          message: "user_location may only be enabled for agents in the location access list"
        });
      }
    }
  }
  if (!manifest.catalog) {
    for (const [index, profile] of manifest.agents.entries()) {
      if (profile.modelOrder && !profile.models) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agents", index, "models"],
          message: "agent models are required when no global catalog is configured"
        });
      }
    }
    return;
  }
  const catalogNames = new Set(manifest.catalog.models.map((model) => model.name));
  if (catalogNames.size !== manifest.catalog.models.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["catalog", "models"],
      message: "canonical model identity names must be unique"
    });
  }
  for (const [index, model] of manifest.catalog.models.entries()) {
    const policy = model.context;
    if (!policy || policy.maxInputTokens && policy.maxInputTokens > policy.windowTokens
      || policy.strategy === "openai-native" && model.protocol !== "openai-responses"
      || policy.strategy === "anthropic-native" && model.protocol !== "anthropic-messages"
      || policy.strategy === "runtime" && !["codex-app-server", "claude-code"].includes(model.protocol)
      || policy.confidence === "conservative" && !policy.note
      || ["openai-native", "anthropic-native"].includes(policy.strategy) && policy.confidence !== "verified") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["catalog", "models", index, "context"],
        message: "model context requires documented route limits, a compatible compaction strategy, and a note for conservative limits" });
    }
    if (model.capabilities.serviceTools.includes("web_search")
      && (!model.capabilities.functionTools || !model.webSearch
        || !manifest.catalog.suppliers[model.webSearch.supplier]?.endpoints["web-search"])) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["catalog", "models", index, "webSearch"],
        message: "service web search requires function tools and a configured search supplier endpoint" });
    }
    const supplier = manifest.catalog.suppliers[model.supplier];
    if (policy?.discoveryUrl && supplier && !Object.values(supplier.endpoints).some(endpoint => endpoint
      && new URL(endpoint).origin === new URL(policy.discoveryUrl!).origin)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["catalog", "models", index, "context", "discoveryUrl"],
        message: "context discovery must use this supplier's configured endpoint origin" });
    }
    if (!supplier) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["catalog", "models", index, "supplier"],
        message: `available model references unknown supplier ${model.supplier}`
      });
    } else if ((model.protocol === "codex-app-server" || model.protocol === "claude-code") && supplier.transport !== model.protocol) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["catalog", "suppliers", model.supplier, "transport"],
        message: `${model.supplier} is not a ${model.protocol} supplier`
      });
    } else if (model.protocol !== "codex-app-server" && model.protocol !== "claude-code" && !supplier.endpoints[model.protocol]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["catalog", "suppliers", model.supplier, "endpoints", model.protocol],
        message: `${model.supplier} has no ${model.protocol} endpoint`
      });
    }
  }
  const imageIdentities = new Set(manifest.catalog.imageModels.map((model) =>
    `${model.name}\0${model.brand}\0${model.supplier}`
  ));
  const imageNames = new Set(manifest.catalog.imageModels.map((model) => model.name));
  if (imageNames.size !== manifest.catalog.imageModels.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["catalog", "imageModels"],
      message: "canonical image-model identity names must be unique"
    });
  }
  for (const [index, model] of manifest.catalog.imageModels.entries()) {
    const supplier = manifest.catalog.suppliers[model.supplier];
    if (supplier?.transport === "codex-app-server") {
      const driver = manifest.catalog.models.find(route => route.name === model.driverModel);
      if (model.apiModel !== "gpt-image-2" || !driver || driver.supplier !== model.supplier || driver.protocol !== "codex-app-server") {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["catalog", "imageModels", index],
          message: "Codex images require gpt-image-2 and an explicit same-supplier codex-app-server driverModel" });
      }
      if (model.driverReasoningEffort && !driver?.reasoning.levels.includes(model.driverReasoningEffort)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["catalog", "imageModels", index, "driverReasoningEffort"],
          message: "Image driver reasoning effort must be supported by the configured driver model" });
      }
    } else if (!supplier?.endpoints["openai-images"]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["catalog", "imageModels", index, "supplier"],
        message: `${model.supplier} has no openai-images endpoint`
      });
    }
  }
  const videoIdentities = new Set(manifest.catalog.videoModels.map((model) =>
    `${model.name}\0${model.brand}\0${model.supplier}`
  ));
  const videoNames = new Set(manifest.catalog.videoModels.map((model) => model.name));
  if (videoNames.size !== manifest.catalog.videoModels.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["catalog", "videoModels"],
      message: "canonical video-model identity names must be unique"
    });
  }
  for (const [index, model] of manifest.catalog.videoModels.entries()) {
    const supplier = manifest.catalog.suppliers[model.supplier];
    if (!supplier?.endpoints["native-videos"]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["catalog", "videoModels", index, "supplier"],
        message: `${model.supplier} has no native-videos endpoint`
      });
    }
  }
  for (const [index, profile] of manifest.agents.entries()) {
    if (!profile.modelOrder || profile.models) continue;
    for (const name of profile.modelOrder) {
      if (!catalogNames.has(name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agents", index, "modelOrder"],
          message: `${name} is not in the available model catalog`
        });
      }
    }
    if (profile.imageModel) {
      const identity = `${profile.imageModel.name}\0${profile.imageModel.brand}\0${profile.imageModel.supplier}`;
      if (!imageIdentities.has(identity)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agents", index, "imageModel"],
          message: "selected image model is not in the available image catalog"
        });
      }
    }
    if (profile.videoModel) {
      const identity = `${profile.videoModel.name}\0${profile.videoModel.brand}\0${profile.videoModel.supplier}`;
      if (!videoIdentities.has(identity)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agents", index, "videoModel"],
          message: "selected video model is not in the available video catalog"
        });
      } else if (!manifest.catalog.suppliers[profile.videoModel.supplier]?.endpoints["native-videos"]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agents", index, "videoModel"],
          message: "selected video model supplier has no native-videos endpoint"
        });
      }
    }
    if (profile.officialVideoModel) {
      const identity = `${profile.officialVideoModel.name}\0${profile.officialVideoModel.brand}\0${profile.officialVideoModel.supplier}`;
      if (!videoIdentities.has(identity)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agents", index, "officialVideoModel"],
          message: "selected official video model is not in the available video catalog"
        });
      }
    }
    if (profile.highResolutionVideoModel) {
      const identity = `${profile.highResolutionVideoModel.name}\0${profile.highResolutionVideoModel.brand}\0${profile.highResolutionVideoModel.supplier}`;
      if (!videoIdentities.has(identity)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agents", index, "highResolutionVideoModel"],
          message: "selected high-resolution video model is not in the available video catalog"
        });
      }
    }
  }
}

export function assertUnique(values: Array<{ value: string; agentId: string }>, label: string): void {
  const owners = new Map<string, string>();
  for (const { value, agentId } of values) {
    const existing = owners.get(value);
    if (existing) throw new Error(`${label} must be isolated: ${existing} and ${agentId} both use ${value}`);
    owners.set(value, agentId);
  }
}

export function assertManifestStorageIsolation(profiles: AgentProfile[]): void {
  const enabledProfiles = profiles.filter((profile) => profile.enabled);
  // Manifests are also checked on non-Windows development hosts. Normalize
  // explicit Windows paths with Windows rules rather than the host's rules.
  const canonical = (value: string): string => {
    const windows = process.platform === "win32" || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
    const path = windows ? win32.resolve(value).replace(/\\/g, "/").toLowerCase() : resolve(value);
    return path.replace(/\/$/, "");
  };
  assertUnique(
    enabledProfiles.map((profile) => ({ value: canonical(profile.storage.sqlite), agentId: profile.id })),
    "SQLite path"
  );
  assertUnique(
    enabledProfiles.map((profile) => ({ value: canonical(profile.storage.longTermMemory), agentId: profile.id })),
    "Long-term memory path"
  );
}

export function assertAgentIsolation(manifest: Manifest, environmentPrefixes = true): void {
  assertUnique(manifest.agents.map(profile => ({ value: profile.id, agentId: profile.id })), "Agent id");
  if (environmentPrefixes) assertUnique(manifest.agents.map(profile => ({ value: profile.envPrefix, agentId: profile.id })), "Environment prefix");
  assertManifestStorageIsolation(manifest.agents);
}
