import { dirname, resolve } from "node:path";
import { DEFAULT_IMAGE_GENERATION_TIMEOUT_MS } from "../image-generation-policy.js";
import { loadNotificationConfig } from "../notifications/config.js";
import { loadProductivityConfig } from "../productivity/config.js";
import { mcpOAuthAccount } from "../mcp/account.js";
import { optionalEnv, positiveInteger, requiredEnv, reusableZenmuxApiKey, validUrl } from "./environment.js";
import type { AgentProfile, Integrations, ModelCatalog, RuntimeSettings } from "./schemas.js";
import type { AgentConfig, Environment, ModelDeployment, ModelSupplier } from "./types.js";

function readProviderConfig(profile: AgentProfile, environment: Environment): AgentConfig["providers"] {
  const prefix = profile.envPrefix;
  const providers: AgentConfig["providers"] = {};

  if (profile.providerOrder?.includes("claude")) {
    const settings = profile.providers.claude!;
    providers.claude = {
      apiKey: requiredEnv(environment, `${prefix}_ZENMUX_API_KEY`),
      model: settings.model,
      baseUrl: validUrl(settings.baseUrl, `${profile.id}.providers.claude.baseUrl`),
      maxTokens: settings.maxTokens,
      reasoningEffort: settings.reasoningEffort
    };
  }
  if (profile.providerOrder?.includes("gpt")) {
    const settings = profile.providers.gpt!;
    providers.gpt = {
      apiKey: requiredEnv(environment, `${prefix}_GPT_API_KEY`),
      model: settings.model,
      baseUrl: validUrl(settings.baseUrl, `${profile.id}.providers.gpt.baseUrl`),
      reasoningEffort: settings.reasoningEffort
    };
  }
  if (profile.providerOrder?.includes("deepseek")) {
    const settings = profile.providers.deepseek!;
    providers.deepseek = {
      apiKey: requiredEnv(environment, `${prefix}_DEEPSEEK_API_KEY`),
      model: settings.model,
      baseUrl: validUrl(settings.baseUrl, `${profile.id}.providers.deepseek.baseUrl`),
      reasoningEffort: settings.reasoningEffort
    };
  }
  return providers;
}

function readModelSuppliers(
  profile: AgentProfile,
  environment: Environment
): Record<string, ModelSupplier> | undefined {
  if (!profile.suppliers) return undefined;
  return Object.fromEntries(Object.entries(profile.suppliers).flatMap(([id, supplier]): Array<[string, ModelSupplier]> => {
    if (supplier.transport === "codex-app-server" || supplier.transport === "claude-code") {
      return [[id, {
        id,
        transport: supplier.transport,
        endpoints: {},
        network: supplier.network,
        cost: supplier.cost,
        command: supplier.command ?? "codex",
        codexHome: supplier.codexHome,
        args: supplier.args.length > 0 ? supplier.args : ["app-server"]
      }]];
    }
    const apiKeyNames = (Array.isArray(supplier.apiKeyEnv) ? supplier.apiKeyEnv : [supplier.apiKeyEnv!])
      .map((name) => name.replace("{ENV_PREFIX}", profile.envPrefix));
    const apiKey = apiKeyNames.map((name) => optionalEnv(environment, name)).find(Boolean)
      ?? (id === "zenmux" ? reusableZenmuxApiKey(environment, profile.envPrefix) : undefined);
    if (!apiKey && supplier.optional) return [];
    if (!apiKey) throw new Error(`Missing required configuration: one of ${apiKeyNames.join(", ")}`);
    return [[id, {
      id,
      transport: "http",
      apiKey,
      endpoints: Object.fromEntries(Object.entries(supplier.endpoints).map(([protocol, endpoint]) => [
        protocol,
        validUrl(endpoint, `${profile.id}.suppliers.${id}.endpoints.${protocol}`)
      ])),
      network: supplier.network,
      cost: supplier.cost,
      imageModel: supplier.imageModel
    }]];
  }));
}

function readModelDeployments(
  profile: AgentProfile,
  environment: Environment,
  suppliers?: Record<string, ModelSupplier>
): ModelDeployment[] | undefined {
  if (!profile.models) return undefined;
  const deployments = profile.models.flatMap((model): ModelDeployment[] => {
    const supplier = suppliers?.[model.supplier];
    if (profile.suppliers && !supplier) return [];
    if (model.protocol === "codex-app-server" || model.protocol === "claude-code") {
      if (supplier?.transport !== model.protocol) {
        throw new Error(`Missing ${model.protocol} supplier for ${profile.id}.${model.supplier}`);
      }
      return [{
        name: model.name,
        brand: model.brand,
        supplier: model.supplier,
        apiModel: model.apiModel,
        protocol: model.protocol,
        network: supplier.network,
        cost: supplier.cost,
        command: supplier.command ?? "codex",
        codexHome: supplier.codexHome,
        args: supplier.args ?? ["app-server"],
        reasoningEffort: model.reasoningEffort,
        reasoning: model.reasoning,
        context: model.context,
        capabilities: model.capabilities
      }];
    }
    const apiKey = supplier?.apiKey ?? (model.apiKeyEnv ? optionalEnv(environment, model.apiKeyEnv) : undefined);
    if (!apiKey && model.optional) return [];
    if (!apiKey) throw new Error(`Missing required model supplier key for ${profile.id}.${model.supplier}`);
    const searchSupplier = model.webSearch ? suppliers?.[model.webSearch.supplier] : undefined;
    if (model.capabilities.serviceTools.includes("web_search") && !searchSupplier?.apiKey) return [];
    const baseUrl = supplier?.endpoints[model.protocol] ?? model.baseUrl;
    if (!baseUrl) throw new Error(`Missing ${model.protocol} endpoint for ${profile.id}.${model.supplier}`);
    return [{
      name: model.name,
      brand: model.brand,
      supplier: model.supplier,
      apiKey,
      apiModel: model.apiModel,
      baseUrl: validUrl(baseUrl, `${profile.id}.models.${model.name}.${model.supplier}.baseUrl`),
      protocol: model.protocol,
      network: supplier?.network ?? model.network ?? "direct",
      cost: supplier?.cost ?? model.cost ?? { type: "official", multiplier: 1 },
      maxTokens: model.maxTokens,
      context: model.context,
      reasoningEffort: model.reasoningEffort,
      reasoning: model.reasoning,
      capabilities: model.capabilities,
      ...(searchSupplier?.apiKey && searchSupplier.endpoints["web-search"] ? {
        webSearch: {
          supplier: searchSupplier.id,
          url: searchSupplier.endpoints["web-search"],
          apiKey: searchSupplier.apiKey,
          network: searchSupplier.network,
          cost: searchSupplier.cost
        }
      } : {})
    }];
  });
  const modelRanks = new Map((profile.modelOrder ?? []).map((name, index) => [name, index]));
  return deployments.sort((left, right) => {
    return (modelRanks.get(left.name) ?? Number.MAX_SAFE_INTEGER)
      - (modelRanks.get(right.name) ?? Number.MAX_SAFE_INTEGER);
  });
}

export function materializeProfile(
  profile: AgentProfile,
  runtime: RuntimeSettings,
  environment: Environment,
  catalog?: ModelCatalog,
  integrations: Integrations = {}
): AgentConfig {
  const prefix = profile.envPrefix;
  const zenmuxProxyUrl = optionalEnv(environment, "ZENMUX_PROXY_URL");
  const ownerUserId = optionalEnv(environment, `${prefix}_WEB_OWNER_USER_ID`)
    ?? (profile.id === "deepmind" ? optionalEnv(environment, "HEALTH_OWNER_USER_ID") : undefined)
    ?? `web:${profile.id}:owner`;
  const accountFor = (service: "notion" | "xmind") => mcpOAuthAccount(service, dirname(resolve(profile.storage.sqlite)), profile.id, ownerUserId);
  const imageApiKey = reusableZenmuxApiKey(environment, prefix);
  const modelRuntime = { ...runtime, ...profile.modelRuntime };
  const resolvedZenmuxProxyUrl = modelRuntime.zenmuxProxyUrl ?? zenmuxProxyUrl;
  const catalogModels = catalog && !profile.models
    ? catalog.models.filter((model) => profile.modelOrder?.includes(model.name))
    : undefined;
  const effectiveProfile: AgentProfile = catalog && !profile.models ? {
    ...profile,
    suppliers: catalog.suppliers,
    models: catalogModels
  } : profile;
  const suppliers = readModelSuppliers(effectiveProfile, environment);
  const models = readModelDeployments(effectiveProfile, environment, suppliers);
  const configuredModelOrder = profile.modelOrder ? [...profile.modelOrder] : undefined;
  const enabledModelNames = new Set(models?.map((model) => model.name) ?? []);
  const modelOrder = configuredModelOrder
    ? configuredModelOrder.filter((name) => enabledModelNames.has(name))
    : undefined;
  if (models && modelOrder) {
    if (modelOrder.length === 0) {
      throw new Error(`No enabled deployment for ${profile.id}; configure at least one model supplier API key`);
    }
    const delegateModel = profile.toolSettings.web_search?.delegateModel;
    if (delegateModel) {
      const delegate = models.find((model) => model.name === delegateModel);
      if (!delegate || !modelOrder.includes(delegateModel)) {
        throw new Error(`Web search delegate ${delegateModel} is not enabled for agent ${profile.id}`);
      }
      if (!delegate.capabilities?.hostedTools.includes("web_search")) {
        throw new Error(`Web search delegate ${delegateModel} does not provide native web_search`);
      }
    }
  }
  if (models?.some((model) => model.network === "proxy") && !resolvedZenmuxProxyUrl) {
    throw new Error(`Agent ${profile.id} has a proxy model route but no zenmuxProxyUrl is configured`);
  }
  const selectedImageDefinition = profile.imageModel && catalog
    ? catalog.imageModels.find((model) =>
        model.name === profile.imageModel!.name
        && model.brand === profile.imageModel!.brand
        && model.supplier === profile.imageModel!.supplier
      )
    : undefined;
  const imageSupplier = selectedImageDefinition
    ? suppliers?.[selectedImageDefinition.supplier]
    : Object.values(suppliers ?? {}).find((supplier) =>
        supplier.endpoints["openai-images"] && supplier.imageModel
      );
  const imageDriver = selectedImageDefinition?.driverModel
    ? models?.find(model => model.name === selectedImageDefinition.driverModel) : undefined;
  if (imageSupplier?.transport === "codex-app-server" && !imageDriver) {
    throw new Error(`Missing ChatGPT image driver for ${profile.id}`);
  }
  const selectedVideoDefinition = profile.videoModel && catalog
    ? catalog.videoModels.find((model) =>
        model.name === profile.videoModel!.name
        && model.brand === profile.videoModel!.brand
        && model.supplier === profile.videoModel!.supplier
      )
    : undefined;
  const videoSupplier = selectedVideoDefinition
    ? suppliers?.[selectedVideoDefinition.supplier]?.endpoints["native-videos"]
      ? suppliers[selectedVideoDefinition.supplier]
      : undefined
    : undefined;
  const selectedOfficialVideoDefinition = profile.officialVideoModel && catalog
    ? catalog.videoModels.find((model) =>
        model.name === profile.officialVideoModel!.name
        && model.brand === profile.officialVideoModel!.brand
        && model.supplier === profile.officialVideoModel!.supplier
      )
    : undefined;
  const selectedHighResolutionVideoDefinition = profile.highResolutionVideoModel && catalog
    ? catalog.videoModels.find((model) =>
        model.name === profile.highResolutionVideoModel!.name
        && model.brand === profile.highResolutionVideoModel!.brand
        && model.supplier === profile.highResolutionVideoModel!.supplier
      )
    : undefined;
  const officialVideoSupplier = selectedOfficialVideoDefinition
    ? suppliers?.[selectedOfficialVideoDefinition.supplier]?.endpoints["native-videos"]
      ? suppliers[selectedOfficialVideoDefinition.supplier]
      : undefined
    : undefined;
  return {
    id: profile.id,
    name: profile.name,
    modelOrder,
    suppliers,
    models,
    providerOrder: modelOrder ?? [...(profile.providerOrder ?? [])],
    allowedTools: [...profile.allowedTools],
    fileWorkbench: profile.fileWorkbench ? {
      enabled: profile.fileWorkbench.enabled,
      stateDirectory: resolve(profile.fileWorkbench.stateDirectory),
      executionEndpoint: profile.fileWorkbench.executionEndpoint,
      executionPreviousEndpoint:profile.fileWorkbench.executionPreviousEndpoint,
      executionTokenFile: profile.fileWorkbench.executionTokenFile ? resolve(profile.fileWorkbench.executionTokenFile) : undefined,
      executionToken: profile.fileWorkbench.executionTokenEnv ? optionalEnv(environment, profile.fileWorkbench.executionTokenEnv) : undefined
    } : undefined,
    notifications: loadNotificationConfig(prefix, environment, profile.notifications, profile.web?.publicUrl,
      profile.channel === "web" ? optionalEnv(environment, `${prefix}_WEB_OWNER_USER_ID`)
        ?? (profile.id === "deepmind" ? optionalEnv(environment, "HEALTH_OWNER_USER_ID") : undefined) ?? `web:${profile.id}:owner` : undefined),
    toolSettings: {
      ...profile.toolSettings,
      ...Object.fromEntries(Object.entries(loadProductivityConfig(profile.id, prefix, environment, resolve(dirname(profile.storage.sqlite)), resolvedZenmuxProxyUrl,
        integrations.productivity && optionalEnv(environment, "XMIND_AUTH_BRIDGE_SECRET") ? {
          bridgeUrl: integrations.productivity.authorizationBridgeUrl,
          bridgeSecret: optionalEnv(environment, "XMIND_AUTH_BRIDGE_SECRET")!, timeoutMs: integrations.productivity.authorizationTimeoutMs
        } : undefined, integrations.productivity?.todoist))
        .filter(([name]) => profile.allowedTools.includes(name))),
      ...(profile.allowedTools.includes("notion") ? {
        notion: {
          account: accountFor("notion"),
          serverUrl: integrations.notion?.serverUrl ?? "https://mcp.notion.com/mcp",
          ...(profile.channel === "web" && profile.web ? { callbackUrl: new URL("oauth/notion/callback", profile.web.publicUrl).toString() }
            : integrations.notion?.authorizationBridgeUrl ? { callbackUrl: `${integrations.notion.authorizationBridgeUrl.replace(/\/$/, "")}/v1/notion/callback` } : {}),
          ...(resolvedZenmuxProxyUrl ? { proxyUrl: resolvedZenmuxProxyUrl } : {})
        }
      } : {}),
      ...(profile.allowedTools.includes("xmind") && integrations.xmind ? {
        xmind: {
          account: accountFor("xmind"),
          serverUrl: validUrl(integrations.xmind.serverUrl, "integrations.xmind.serverUrl")
        }
      } : {})
    },
    zenmuxProxyUrl: resolvedZenmuxProxyUrl
      ? validUrl(resolvedZenmuxProxyUrl, modelRuntime.zenmuxProxyUrl ? `${profile.id}.modelRuntime.zenmuxProxyUrl` : "ZENMUX_PROXY_URL")
      : undefined,
    imageGeneration: imageSupplier ? {
      transport: imageSupplier.transport === "codex-app-server" ? "codex-app-server" : "http",
      driver: imageDriver ? { ...imageDriver,
        reasoningEffort: selectedImageDefinition?.driverReasoningEffort ?? imageDriver.reasoningEffort } : undefined,
      apiKey: imageSupplier.apiKey,
      baseUrl: imageSupplier.endpoints["openai-images"],
      model: selectedImageDefinition?.apiModel ?? imageSupplier.imageModel!,
      modelName: selectedImageDefinition?.name,
      supplier: imageSupplier.id,
      network: imageSupplier.network,
      cost: imageSupplier.cost
    } : imageApiKey ? {
      apiKey: imageApiKey,
      baseUrl: validUrl(optionalEnv(environment, "ZENMUX_IMAGE_BASE_URL") ?? "https://zenmux.ai/api/v1", "ZENMUX_IMAGE_BASE_URL"),
      model: optionalEnv(environment, "ZENMUX_IMAGE_MODEL") ?? "openai/gpt-image-2.5-sunburst",
      supplier: "zenmux",
      network: "proxy",
      cost: { type: "official", multiplier: 1 }
    } : undefined,
    videoGeneration: videoSupplier || (officialVideoSupplier && selectedHighResolutionVideoDefinition) ? {
      ...(videoSupplier ? {
        apiKey: videoSupplier.apiKey!,
        baseUrl: videoSupplier.endpoints["native-videos"]!,
        model: selectedVideoDefinition!.apiModel,
        modelName: selectedVideoDefinition!.name,
        supplier: videoSupplier.id,
        network: videoSupplier.network,
        cost: videoSupplier.cost
      } : {}),
      ...(officialVideoSupplier && selectedHighResolutionVideoDefinition ? {
        official: {
          apiKey: officialVideoSupplier.apiKey!,
          baseUrl: officialVideoSupplier.endpoints["native-videos"]!,
        model: selectedOfficialVideoDefinition!.apiModel,
        highResolutionModel: selectedHighResolutionVideoDefinition.apiModel,
        modelName: selectedOfficialVideoDefinition!.name,
        highResolutionModelName: selectedHighResolutionVideoDefinition.name,
          supplier: officialVideoSupplier.id,
          network: officialVideoSupplier.network,
          cost: officialVideoSupplier.cost
        }
      } : {})
    } : imageApiKey && profile.allowedTools.includes("video_generation") ? {
      apiKey: imageApiKey,
      baseUrl: validUrl(optionalEnv(environment, "ZENMUX_VIDEO_BASE_URL") ?? "https://zenmux.ai/api/v1", "ZENMUX_VIDEO_BASE_URL"),
      model: optionalEnv(environment, "ZENMUX_VIDEO_MODEL") ?? "minimax/minimax-h3-max",
      supplier: "zenmux",
      network: "proxy",
      cost: { type: "official", multiplier: 1 }
    } : undefined,
    xmindAuthorization: profile.allowedTools.includes("xmind") && integrations.xmind ? {
      account: accountFor("xmind"),
      serverUrl: validUrl(integrations.xmind.serverUrl, "integrations.xmind.serverUrl"),
      bridgeUrl: validUrl(integrations.xmind.authorizationBridgeUrl, "integrations.xmind.authorizationBridgeUrl"),
      bridgeSecret: requiredEnv(environment, "XMIND_AUTH_BRIDGE_SECRET"),
      timeoutMs: integrations.xmind.authorizationTimeoutMs,
      ...(resolvedZenmuxProxyUrl ? {
        proxyUrl: validUrl(resolvedZenmuxProxyUrl, "runtime.zenmuxProxyUrl")
      } : {})
    } : undefined,
    notionAuthorization: profile.allowedTools.includes("notion") && (profile.channel === "web" && profile.web || integrations.notion?.authorizationBridgeUrl) ? {
      account: accountFor("notion"),
      serverUrl: integrations.notion?.serverUrl ?? "https://mcp.notion.com/mcp",
      ...(profile.channel === "web" ? {} : {
        bridgeUrl: validUrl(integrations.notion!.authorizationBridgeUrl!, "integrations.notion.authorizationBridgeUrl"),
        bridgeSecret: requiredEnv(environment, "XMIND_AUTH_BRIDGE_SECRET")
      }),
      timeoutMs: integrations.notion?.authorizationTimeoutMs ?? 15 * 60_000,
      ...(resolvedZenmuxProxyUrl ? { proxyUrl: resolvedZenmuxProxyUrl } : {})
    } : undefined,
    health: integrations.health && profile.id === "deepmind" && optionalEnv(environment, "HEALTH_OWNER_USER_ID") ? {
      storagePath: resolve(integrations.health.storage),
      allowedAgentId: "deepmind",
      ownerUserId: requiredEnv(environment, "HEALTH_OWNER_USER_ID"),
      ...(optionalEnv(environment, "HEALTH_OWNER_PRINCIPAL_ID") ? { ownerPrincipalId: optionalEnv(environment, "HEALTH_OWNER_PRINCIPAL_ID") } : {}),
      ...(integrations.health.initialSkillPath ? { initialSkillPath: resolve(integrations.health.initialSkillPath) } : {}),
      ...(integrations.health.publicUrl ? { publicUrl: integrations.health.publicUrl } : {})
    } : undefined,
    location: integrations.location?.agents.includes(profile.id) ? {
      storagePath: resolve(integrations.location.storage),
      ...(integrations.location.amapApiKeyEnv ? {
        amapApiKey: requiredEnv(environment, integrations.location.amapApiKeyEnv)
      } : {}),
      ...(integrations.location.publicUrl ? {
        publicUrl: validUrl(integrations.location.publicUrl, "integrations.location.publicUrl")
      } : {})
    } : undefined,
    channel: profile.channel,
    web: profile.web ? {
      ...profile.web, storage: resolve(profile.web.storage),
      transcription: profile.web.transcription ? {
        model: profile.web.transcription.model, apiKey: requiredEnv(environment, profile.web.transcription.apiKeyEnv),
        tos: { accessKeyId: requiredEnv(environment, profile.web.transcription.tos.accessKeyEnv),
          accessKeySecret: requiredEnv(environment, profile.web.transcription.tos.secretKeyEnv),
          endpoint: profile.web.transcription.tos.endpoint, region: profile.web.transcription.tos.region, bucket: profile.web.transcription.tos.bucket }
      } : undefined,
      speech: profile.web.speech && optionalEnv(environment, profile.web.speech.apiKeyEnv)
        ? { model: profile.web.speech.model, apiKey: requiredEnv(environment, profile.web.speech.apiKeyEnv) } : undefined,
      passwordHash: optionalEnv(environment, `${prefix}_WEB_PASSWORD_HASH`),
      ownerUserId,
      ownerPrincipalId: optionalEnv(environment, `${prefix}_WEB_OWNER_PRINCIPAL_ID`) ?? (profile.id === "deepmind" ? optionalEnv(environment, "HEALTH_OWNER_PRINCIPAL_ID") : undefined) ?? optionalEnv(environment, `${prefix}_WEB_OWNER_USER_ID`) ?? `web:${profile.id}:owner`
    } : undefined,
    feishu: optionalEnv(environment, `${prefix}_FEISHU_APP_ID`) && optionalEnv(environment, `${prefix}_FEISHU_APP_SECRET`) ? {
      appId: requiredEnv(environment, `${prefix}_FEISHU_APP_ID`),
      appSecret: requiredEnv(environment, `${prefix}_FEISHU_APP_SECRET`)
    } : undefined,
    providers: models
      ? Object.fromEntries(models.map((model) => [model.name, {
          apiKey: model.apiKey,
          model: model.apiModel,
          baseUrl: model.baseUrl,
          maxTokens: model.maxTokens,
          reasoningEffort: model.reasoningEffort
        }])) as AgentConfig["providers"]
      : readProviderConfig(profile, environment),
    modelConnectTimeoutMs: modelRuntime.modelConnectTimeoutMs,
    modelFirstProgressTimeoutMs: modelRuntime.modelFirstProgressTimeoutMs,
    modelProgressIdleTimeoutMs: modelRuntime.modelProgressIdleTimeoutMs,
    modelCircuitBreakerMs: modelRuntime.modelCircuitBreakerMs,
    modelRetryAttempts: modelRuntime.modelRetryAttempts,
    modelNetworkRetryAttempts: modelRuntime.modelNetworkRetryAttempts,
    modelRetryDelayMs: modelRuntime.modelRetryDelayMs,
    imageGenerationTimeoutMs: modelRuntime.imageGenerationTimeoutMs ?? DEFAULT_IMAGE_GENERATION_TIMEOUT_MS,
    videoGenerationTimeoutMs: positiveInteger(environment, `${prefix}_VIDEO_GENERATION_TIMEOUT_MS`, 300_000),
    memoryStoragePath: resolve(profile.storage.sqlite),
    longTermMemoryPath: resolve(profile.storage.longTermMemory),
    sessionInactivityMinutes: profile.sessionInactivityMinutes,
    memoryContextWindowTokens: profile.memoryContextWindowTokens,
    memoryCompressionRatio: profile.memoryCompressionRatio,
    failureMessage: profile.failureMessage ?? `${profile.name} 暂时无法完成这次请求，请稍后再试。`
  };
}
