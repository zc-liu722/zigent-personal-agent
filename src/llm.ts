import { currentPerformance } from "./performance/store.js";
import type { PerformanceStore } from "./performance/store.js";
import type { ModelDeployment, Provider, WebSearchConfig } from "./config.js";
import type { ReferenceImage } from "./image-generation.js";
import { renderMessageForSummary } from "./memory/transcript.js";
import type { ChatMessage, TokenUsage } from "./memory/types.js";
import { missingCapabilities, modelCapabilities, requestedCapabilities, routeSupportsRequest } from "./models/capabilities.js";
import { CodexAppServerError, CodexWarmPool, invokeCodexAppServerRound } from "./models/codex-app-server.js";
import { invokeClaudeCodeRound } from "./models/claude-code.js";
import { ModelError, ModelFallbackRequiredError, ModelHardStopError, ModelUnsupportedInputError, ProviderUnavailableError, classifyModelFailure } from "./models/errors.js";
import type { ModelGatewayConfig } from "./models/gateway-config.js";
import { requestStreamText } from "./models/http-transport.js";
import { isNetworkFailure } from "./models/network-retry.js";
import {
  anthropicMessagesEndpoint,
  buildProtocolRequest,
  responseEndpoint
} from "./models/protocol-adapters.js";
import { streamReaderFor } from "./models/stream-reader.js";
import type { StreamUpdate } from "./models/stream-types.js";
import { SupplierHealthRegistry, type SupplierFailure } from "./models/supplier-health.js";
import { executeSupplierWebSearch } from "./models/web-search-service.js";
import type {
  ModelRoundRequest,
  ModelRoundResult,
  ModelRoundUpdate,
  ModelRouteMetadata,
  ModelToolExecutor,
  ModelUrlCitation,
  ModelWebSearchCall,
  ModelWebSearchTool
} from "./models/types.js";
import type { RequestRecorder, UsageRecorder } from "./usage/types.js";
import { ModelContextManager } from "./models/context-manager.js";
import { compactNative } from "./models/context-native.js";
import { contextPolicy } from "./models/context-policy.js";
import { addTokenUsage, SUMMARY_INSTRUCTION, summarizeTranscript } from "./models/context-summary.js";
import { ModelContextOverflowError } from "./models/errors.js";

function inferredBrand(name: string): string {
  if (name === "gpt") return "openai";
  if (name === "claude") return "anthropic";
  return name;
}

function inferredSupplier(name: string, baseUrl: string): string {
  const hostname = new URL(baseUrl).hostname.toLowerCase();
  if (hostname === "zenmux.ai" || hostname.endsWith(".zenmux.ai")) return "zenmux";
  return `${inferredBrand(name)}-official`;
}

function legacyDeployment(config: ModelGatewayConfig, name: Provider): ModelDeployment | undefined {
  const endpoint = config.providers[name];
  if (!endpoint) return undefined;
  const supplier = inferredSupplier(name, endpoint.baseUrl);
  return {
    name,
    brand: inferredBrand(name),
    supplier,
    apiKey: endpoint.apiKey,
    apiModel: endpoint.model,
    baseUrl: endpoint.baseUrl,
    protocol: name === "claude" ? "anthropic-messages" : "openai-responses",
    network: supplier === "zenmux" ? "proxy" : "direct",
    cost: supplier.startsWith("lemon-") ? { type: "free" } : { type: "official", multiplier: 1 },
    maxTokens: endpoint.maxTokens,
    reasoningEffort: endpoint.reasoningEffort,
    capabilities: {
      imageInput: name !== "deepseek" || endpoint.model.toLowerCase().includes("vision"),
      functionTools: true,
      hostedTools: [],
      delegatedTools: [],
      reasoningReplay: name === "gpt"
    }
  };
}

function configuredModelOrder(config: ModelGatewayConfig): Provider[] {
  return config.modelOrder ?? config.providerOrder;
}

function configuredDeployments(config: ModelGatewayConfig): ModelDeployment[] {
  const deployments = config.models ?? configuredModelOrder(config)
    .map((name) => legacyDeployment(config, name))
    .filter((model): model is ModelDeployment => Boolean(model));
  const modelRanks = new Map(configuredModelOrder(config).map((name, index) => [name, index]));
  return [...deployments].sort((left, right) => {
    return (modelRanks.get(left.name) ?? Number.MAX_SAFE_INTEGER)
      - (modelRanks.get(right.name) ?? Number.MAX_SAFE_INTEGER);
  });
}

function routeMetadata(route: ModelDeployment): ModelRouteMetadata {
  return {
    name: route.name,
    brand: route.brand,
    supplier: route.supplier,
    apiModel: route.apiModel,
    protocol: route.protocol,
    cost: route.cost,
    capabilities: modelCapabilities(route)
  };
}

async function invokeModelRoundFromDeployment(
  config: ModelGatewayConfig,
  route: ModelDeployment,
  request: ModelRoundRequest,
  onUpdate?: (update: ModelRoundUpdate) => void,
  signal?: AbortSignal,
  executeTool?: ModelToolExecutor,
  record?: RequestRecorder,
  codexWarmPool?: CodexWarmPool
): Promise<ModelRoundResult> {
  const wantsUpdates = Boolean(onUpdate);
  const outputStarted = performance.now();
  let firstOutput = false;
  let firstToolArguments = false, firstReasoning = false;
  const publish = onUpdate;
  onUpdate = update => {
    if (!firstOutput && update.type === "assistant_text.delta" && update.text.trim()) {
      firstOutput = true;
      currentPerformance()?.store.record("model.first_output", performance.now() - outputStarted, route.name);
    }
    publish?.(update);
  };
  if (route.protocol === "claude-code") {
    return invokeClaudeCodeRound(config, route, request, onUpdate, signal, record);
  }
  if (!routeSupportsRequest(route, request)) {
    throw new ModelUnsupportedInputError(
      `${route.apiModel} does not support required capabilities: ${missingCapabilities(route, request).join(", ")}`
    );
  }
  const preparingVisuals = new Set<string>();
  const observe = (update: StreamUpdate): void => {
    if (update.reset) preparingVisuals.clear();
    if (request.toolChoice !== "none" && request.tools.some(tool => tool.type === "function" && tool.name === "present_output")) {
      for (const call of update.toolCalls ?? []) {
        if (call.name !== "present_output" || preparingVisuals.has(call.key)) continue;
        preparingVisuals.add(call.key);
        onUpdate?.({ provider: route.name, ...routeMetadata(route), type: "visual.preparing", itemId: call.key });
      }
    }
    if (!firstToolArguments && update.toolCalls?.some(call => Boolean(call.argumentsDelta?.length || call.arguments?.length))) {
      firstToolArguments = true;
      currentPerformance()?.store.record("model.first_tool_arguments", performance.now() - outputStarted, route.name);
    }
    if (!firstReasoning && update.thoughts?.some(thought => thought.text.trim())) {
      firstReasoning = true;
      currentPerformance()?.store.record("model.first_reasoning", performance.now() - outputStarted, route.name);
    }
    const metadata = { provider: route.name, ...routeMetadata(route) };
    if (update.reset) onUpdate?.({ ...metadata, type: "attempt.reset" });
    if (update.retry) onUpdate?.({
      ...metadata,
      type: "route",
      status: "retrying",
      failureKind: update.retry.failureKind,
      retryAttempt: update.retry.attempt,
      maxAttempts: update.retry.maxAttempts
    });
    for (const thought of update.thoughts ?? []) onUpdate?.({
      ...metadata,
      type: "thought.delta",
      ...thought
    });
    if (update.assistantText) onUpdate?.({
      ...metadata,
      type: "assistant_text.delta",
      ...update.assistantText
    });
    if (update.webSearchCalls?.length) onUpdate?.({
      ...metadata,
      type: "web_search.update",
      calls: update.webSearchCalls
    });
  };

  if (route.protocol === "codex-app-server") {
    try {
      return await invokeCodexAppServerRound(config, route, request, onUpdate, signal, executeTool, record, undefined, codexWarmPool);
    } catch (error) {
      if (!(error instanceof CodexAppServerError)) throw error;
      if (error.kind === "unavailable" || error.kind === "rate-limit" || error.kind === "invalid-response") {
        throw new ProviderUnavailableError(error.message, error.status);
      }
      throw new ModelError(error.message, error.status);
    }
  }

  const transport = buildProtocolRequest(route, request, wantsUpdates);
  const result = await requestStreamText(
    config,
    transport.url,
    route.apiKey!,
    transport.payload,
    () => streamReaderFor(transport.protocol),
    transport.headers,
    observe,
    route.network,
    signal,
    record
  );
  const { nativeItems, ...normalized } = result;
  // Opaque native replay remains supplier-specific. Hosted search evidence in
  // normalized.webSearchCalls/citations is independently saved by the executor;
  // disabling reasoning replay must never erase that portable execution record.
  return {
    ...normalized,
    ...(modelCapabilities(route).reasoningReplay && nativeItems.length > 0 ? {
      nativeState: {
        protocol: route.protocol,
        brand: route.brand,
        supplier: route.supplier,
        apiModel: route.apiModel,
        items: nativeItems
      }
    } : {})
  };
}

export type ModelInvocation<T> = {
  value: T;
  provider: Provider;
  fallbackFrom?: Provider;
  route: ModelRouteMetadata;
};

export type GeneratedSessionSummary = {
  text: string;
  usage: TokenUsage;
  provider: Provider;
  model: string;
  route: ModelRouteMetadata;
};

export type WebSearchExecutionResult = {
  result: {
    query: string;
    answer: string;
    sources: readonly { type: "url"; url: string; title?: string }[];
    searchModel?: Provider;
    searchSupplier?: string;
  };
  usage?: TokenUsage;
  webSearchCalls: readonly ModelWebSearchCall[];
  citations: readonly ModelUrlCitation[];
};

function webSearchToolFromConfig(settings: WebSearchConfig | undefined): ModelWebSearchTool {
  return {
    type: "web_search",
    search_context_size: settings?.search_context_size ?? "medium",
    ...(settings?.filters ? { filters: settings.filters } : {}),
    ...(settings?.user_location ? { user_location: settings.user_location } : {}),
    ...(settings?.external_web_access !== undefined
      ? { external_web_access: settings.external_web_access }
      : {})
  };
}

function uniqueSearchSources(
  calls: readonly ModelWebSearchCall[],
  citations: readonly ModelUrlCitation[]
): Array<{ type: "url"; url: string; title?: string }> {
  const sources = [
    ...calls.flatMap((call) => call.sources),
    ...citations.map((citation) => ({
      type: "url" as const,
      url: citation.url,
      ...(citation.title ? { title: citation.title } : {})
    }))
  ];
  return [...new Map(sources.map((source) => [source.url, source])).values()];
}

export class ModelGateway {
  private readonly contextManager: ModelContextManager;
  private readonly codexWarmPool = new CodexWarmPool();
  private codexWarmupEnabled = false;
  performance?: PerformanceStore;
  private readonly deployments: ModelDeployment[];
  private readonly modelOrder: Provider[];

  constructor(
    private readonly config: ModelGatewayConfig,
    private readonly supplierHealth = new SupplierHealthRegistry(),
    private readonly recordUsage?: UsageRecorder
  ) {
    this.deployments = configuredDeployments(config);
    if (new Set(this.deployments.map((route) => route.name)).size !== this.deployments.length) {
      throw new ModelError(`Agent ${config.id} has duplicate canonical model identities`);
    }
    this.modelOrder = configuredModelOrder(config);
    this.contextManager = new ModelContextManager(config,
      (route, transcript, previous, signal, reasoningEfforts, policy) => this.generateContextSummary(route, transcript, previous, signal, reasoningEfforts, policy),
      (route, request, signal) => compactNative(config, route, request, contextPolicy(route, config).summary, signal, this.meter(route)));
    this.warmContextPolicy(this.defaultProvider);
  }

  /** Start optional catalogue discovery early; actual requests still await the same validated policy. */
  warmContextPolicy(provider: Provider): void {
    const selected = this.deployments.find(candidate => candidate.name === provider);
    if (this.codexWarmupEnabled && selected?.protocol === "codex-app-server") this.codexWarmPool.warm(this.config, selected);
    const route = this.deployments.find(candidate => candidate.name === provider && candidate.context?.discoveryUrl);
    if (route) void this.contextManager.policy(route).catch(() => undefined);
  }

  enableCodexWarmup(): void { this.codexWarmupEnabled = true; this.warmContextPolicy(this.defaultProvider); }
  async close(): Promise<void> { this.codexWarmupEnabled = false; await this.codexWarmPool.close(); }

  async contextPolicy(provider: Provider = this.defaultProvider, signal?: AbortSignal) {
    const route = this.deployments.find(route => route.name === provider);
    if (!route) throw new ModelError("Unknown context-budget model");
    return this.contextManager.policy(route, signal);
  }

  async contextInfo(provider: Provider = this.defaultProvider, signal?: AbortSignal) {
    const route = this.deployments.find(route => route.name === provider);
    if (!route) throw new ModelError("Unknown context-budget model");
    return { model: route.name, supplier: route.supplier, apiModel: route.apiModel, protocol: route.protocol,
      ...await this.contextManager.policy(route, signal), confidence: route.context?.confidence ?? "conservative",
      sources: route.context?.sources ?? [], checkedAt: route.context?.checkedAt };
  }

  private async generateContextSummary(route: ModelDeployment, transcript: string, previous?: string,
    signal?: AbortSignal, reasoningEfforts?: ModelRoundRequest["reasoningEfforts"], preparedPolicy?: Awaited<ReturnType<ModelContextManager["policy"]>>
  ): Promise<{ text: string; usage: TokenUsage }> {
    const policy = preparedPolicy ?? await this.contextManager.policy(route, signal);
    const outputReserve = Math.min(policy.output, policy.summary * 4);
    return summarizeTranscript(transcript, previous, policy.inputLimit, policy.summary, (text, maxOutputTokens) =>
      invokeModelRoundFromDeployment(this.config, route, { systemPrompt: `${SUMMARY_INSTRUCTION} Keep the checkpoint below ${policy.summary} tokens.`,
        messages: [{ role: "user", text }], tools: [], toolChoice: "none", maxOutputTokens, reasoningEfforts },
      undefined, signal, undefined, this.meter(route)), signal, outputReserve);
  }

  private meter(route: ModelDeployment): RequestRecorder | undefined {
    return this.recordUsage ? meter => this.recordUsage!({ ...meter, model: route.name,
      supplier: route.supplier, apiModel: route.apiModel, cost: route.cost, kind: "text" }) : undefined;
  }

  private preferredDefault?: Provider;
  setDefaultProvider(model: Provider): void {
    if (!this.modelOrder.includes(model)) throw new Error("Unknown default model");
    this.preferredDefault = model;
    this.warmContextPolicy(model);
  }
  get defaultProvider(): Provider {
    return this.preferredDefault ?? this.modelOrder[0]!;
  }

  resetCircuit(provider?: Provider): void {
    if (!provider) this.supplierHealth.reset();
    else for (const route of this.deployments.filter(route => route.name === provider)) this.supplierHealth.reset(route.supplier);
  }

  async generateSessionSummary(
    input: { previousSummary?: string; messages: ChatMessage[] },
    provider: Provider = this.defaultProvider,
    options: { automaticFallback?: boolean; signal?: AbortSignal; reasoningEfforts?: ModelRoundRequest["reasoningEfforts"] } = {}
  ): Promise<GeneratedSessionSummary> {
    const result = await this.invokeModel(
      (route) => this.generateContextSummary(route, input.messages.map(renderMessageForSummary).join("\n\n"), input.previousSummary, options.signal, options.reasoningEfforts),
      provider,
      options
    );
    return {
      text: result.value.text,
      usage: result.value.usage,
      provider: result.provider,
      model: result.route.apiModel,
      route: result.route
    };
  }

  modelId(provider: Provider): string {
    const route = this.deployments.find((candidate) => candidate.name === provider);
    if (!route) throw new ModelError(`${provider} is not configured for agent ${this.config.id}`);
    return route.apiModel;
  }

  async executeWebSearch(
    sourceProvider: Provider,
    input: unknown,
    signal?: AbortSignal
  ): Promise<WebSearchExecutionResult> {
    const sourceRoute = this.deployments.find(route => route.name === sourceProvider);
    if (sourceRoute?.capabilities?.serviceTools?.includes("web_search")) {
      const query = input && typeof input === "object" && !Array.isArray(input)
        ? (input as { query?: unknown }).query : undefined;
      if (typeof query !== "string" || !query.trim()) throw new ModelError("web_search query must be a non-empty string");
      return executeSupplierWebSearch(this.config, sourceRoute, query.trim(), signal);
    }
    return this.executeDelegatedWebSearch(sourceProvider, input, signal);
  }

  async executeDelegatedWebSearch(
    sourceProvider: Provider,
    input: unknown,
    signal?: AbortSignal
  ): Promise<WebSearchExecutionResult> {
    const sourceRoute = this.deployments.find((route) => route.name === sourceProvider);
    if (!sourceRoute?.capabilities?.delegatedTools?.includes("web_search")) {
      throw new ModelError(`${sourceProvider} is not configured to delegate web_search`);
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new ModelError("web_search input must be an object");
    }
    const query = (input as { query?: unknown }).query;
    if (typeof query !== "string" || !query.trim()) {
      throw new ModelError("web_search query must be a non-empty string");
    }
    const settings = this.config.toolSettings?.web_search;
    const delegateModel = settings?.delegateModel;
    if (!delegateModel) throw new ModelError("web_search delegateModel is not configured");
    const delegateRoute = this.deployments.find((route) => route.name === delegateModel);
    if (!delegateRoute || !modelCapabilities(delegateRoute).hostedTools.includes("web_search")) {
      throw new ModelError(`web_search delegate ${delegateModel} does not provide native web_search`);
    }

    const invocation = await this.invokeRound(delegateModel, {
      systemPrompt: [
        "You are a web-search retrieval worker for another model.",
        "Use the native web_search tool for the supplied query.",
        "When the supplied query contains one or more URLs, use each exact URL as a direct retrieval target together with the surrounding information need and keywords; when it contains no URL, search by the supplied keywords.",
        "Return a compact factual digest with direct source citations; do not discuss the delegation mechanism."
      ].join(" "),
      messages: [{ role: "user", text: query.trim() }],
      tools: [webSearchToolFromConfig(settings)],
      reasoningEffort: "default",
      toolChoice: "required"
    }, { automaticFallback: false, signal });
    const sources = uniqueSearchSources(invocation.value.webSearchCalls, invocation.value.citations);
    if (invocation.value.webSearchCalls.length === 0 && sources.length === 0) {
      throw new ModelError(`web_search delegate ${delegateModel} returned no search evidence`);
    }
    const calls = invocation.value.webSearchCalls.map((call) => ({
      ...call,
      query: call.query ?? query.trim()
    }));
    const citations = [...new Map([
      ...invocation.value.citations,
      ...sources.map((source): ModelUrlCitation => ({
        type: "url_citation",
        url: source.url,
        ...(source.title ? { title: source.title } : {})
      }))
    ].map((citation) => [citation.url, citation])).values()];
    return {
      result: {
        query: query.trim(),
        answer: invocation.value.text,
        sources,
        searchModel: invocation.provider
      },
      usage: invocation.value.usage,
      webSearchCalls: calls,
      citations
    };
  }

  async invokeRound(
    provider: Provider,
    request: ModelRoundRequest,
    options: {
      automaticFallback?: boolean;
      onUpdate?: (update: ModelRoundUpdate) => void;
      signal?: AbortSignal;
      executeTool?: ModelToolExecutor;
    } = {}
  ): Promise<ModelInvocation<ModelRoundResult>> {
    if (!this.isProviderConfigured(provider)) {
      throw new ModelError(`${provider} is not configured for agent ${this.config.id}`);
    }
    const acceptsRoute = (route: ModelDeployment): boolean => routeSupportsRequest(route, request);
    if (this.deployments.some(route => route.name === provider && route.protocol === "claude-code" && !acceptsRoute(route))) {
      throw new ModelHardStopError("boundary-violation", "Claude 当前接入不支持此任务所需能力");
    }
    const providerIndex = this.modelOrder.indexOf(provider);
    const eligibleProviders = providerIndex >= 0 ? this.modelOrder.slice(providerIndex) : [];
    const required = requestedCapabilities(request);
    if (!this.deployments.some((route) =>
      eligibleProviders.includes(route.name) && acceptsRoute(route)
    )) {
      const labels = [
        ...(required.imageInput ? ["image_input"] : []),
        ...(required.functionTools ? ["function_tools"] : []),
        ...required.hostedTools
      ];
      throw new ModelUnsupportedInputError(
        `Agent ${this.config.id} has no configured route supporting required capabilities ${labels.join(", ") || "text"}`
      );
    }
    return this.invokeModel(
      async (route) => {
        let prepared = await this.contextManager.prepare(route, request, options.signal);
        let compactionUsage = prepared.usage;
        let result: ModelRoundResult;
        try {
          result = await invokeModelRoundFromDeployment(this.config, route, prepared.request,
            options.onUpdate, options.signal, options.executeTool, this.meter(route), this.codexWarmupEnabled ? this.codexWarmPool : undefined);
        } catch (error) {
          const nativeReplayRejected = Boolean(prepared.request.nativeContext && error instanceof ModelError
            && [400, 409, 422].includes(error.status ?? 0));
          if (!(error instanceof ModelContextOverflowError) && !nativeReplayRejected) throw error;
          prepared = await this.contextManager.prepare(route, request, options.signal, {
            reason: nativeReplayRejected ? "native-replay" : "overflow",
            window: nativeReplayRejected ? undefined : (error as ModelContextOverflowError).contextWindowTokens,
            rejectedEstimate: prepared.estimated
          });
          compactionUsage = addTokenUsage(compactionUsage, prepared.usage);
          result = await invokeModelRoundFromDeployment(this.config, route, prepared.request,
            options.onUpdate, options.signal, options.executeTool, this.meter(route), this.codexWarmupEnabled ? this.codexWarmPool : undefined);
        }
        this.contextManager.observe(route, prepared, result);
        return { ...result, usage: addTokenUsage(result.usage, compactionUsage) };
      },
      provider,
      options,
      acceptsRoute,
      options.onUpdate
    );
  }

  private isProviderConfigured(provider: Provider): boolean {
    return this.modelOrder.includes(provider)
      && this.deployments.some((route) => route.name === provider);
  }

  private configuredFallbackOrder(provider: Provider): Provider[] {
    const index = this.modelOrder.indexOf(provider);
    return index >= 0 ? this.modelOrder.slice(index + 1) : [];
  }

  private async invokeModel<T>(
    operation: (route: ModelDeployment) => Promise<T>,
    provider: Provider,
    options: { automaticFallback?: boolean },
    acceptsRoute: (route: ModelDeployment) => boolean = () => true,
    onUpdate?: (update: ModelRoundUpdate) => void
  ): Promise<ModelInvocation<T>> {
    const automaticFallback = options.automaticFallback ?? true;
    if (!this.isProviderConfigured(provider)) {
      throw new ModelError(`${provider} is not configured for agent ${this.config.id}`);
    }

    const fallbackProvider = this.configuredFallbackOrder(provider)
      .find((candidate) => this.isProviderConfigured(candidate)
        && this.deployments.some((route) => route.name === candidate && acceptsRoute(route)));
    const routes = this.deployments.filter((route) => route.name === provider && acceptsRoute(route));
    const startedAt = Date.now();
    let lastError: ModelError | undefined = routes.length === 0
      ? new ModelUnsupportedInputError(`${provider} has no compatible deployment`)
      : undefined;
    let attemptedRoute = false;
    let failedSupplier: string | undefined;
    let lastFailure: SupplierFailure | undefined;
    for (const [index, route] of routes.entries()) {
      failedSupplier = route.supplier;
      lastFailure = undefined;
      const hasAlternativeRoute = index < routes.length - 1 || Boolean(fallbackProvider);
      if (this.supplierHealth.isOpen(route.supplier) && hasAlternativeRoute) {
        lastError = new ProviderUnavailableError(`${route.supplier} is temporarily unavailable after repeated failures`);
        lastFailure = this.supplierHealth.failure(route.supplier);
        if (index < routes.length - 1) {
          onUpdate?.({ provider, ...routeMetadata(route), type: "route", status: "switching", failureKind: "circuit-open" });
        }
        continue;
      }
      attemptedRoute = true;
      onUpdate?.({ provider, ...routeMetadata(route), type: "route", status: "connecting" });
      try {
        const value = await (this.performance ? this.performance.measure("model.call", route.name, () => operation(route), route.name) : operation(route));
        this.supplierHealth.markSuccess(route.supplier);
        onUpdate?.({ provider, ...routeMetadata(route), type: "route", status: "connected" });
        return { value, provider, route: routeMetadata(route) };
      } catch (error) {
        if (!(error instanceof ModelError)) throw error;
        lastError = error;
        const canTryAnotherSupplier = error instanceof ProviderUnavailableError
          || error instanceof ModelUnsupportedInputError || error instanceof ModelContextOverflowError;
        if (!canTryAnotherSupplier) throw error;
        const kind = classifyModelFailure(error);
        if (error instanceof ProviderUnavailableError) {
          this.supplierHealth.markFailure(route.supplier, this.config.modelCircuitBreakerMs, Date.now(), { kind, status: error.status });
        }
        onUpdate?.({ provider, ...routeMetadata(route), type: "route", status: "failed", failureKind: kind });
        if (index < routes.length - 1) {
          const next = routes[index + 1]!;
          onUpdate?.({ provider, ...routeMetadata(next), type: "route", status: "switching", failureKind: kind });
          console.warn(`${this.config.id}:${provider}:${route.supplier} failed; retrying with ${next.supplier}.`);
        }
      }
    }

    if (!lastError) throw new ModelError(`${provider} has no available deployment`);
    const healthyFallbackProvider = this.configuredFallbackOrder(provider)
      .find((candidate) => this.isProviderConfigured(candidate)
        && this.deployments.some((route) => route.name === candidate
          && acceptsRoute(route) && !this.supplierHealth.isOpen(route.supplier)));
    const kind = routes.length === 0
      ? classifyModelFailure(lastError)
      : !attemptedRoute ? "circuit-open" : classifyModelFailure(lastError);
    const networkRecovery = isNetworkFailure(kind) || kind === "circuit-open" && lastFailure && isNetworkFailure(lastFailure.kind);
    const selectableProviders = this.modelOrder.filter(candidate => this.deployments.some(route => route.name === candidate
      && acceptsRoute(route) && route.supplier !== failedSupplier));
    if (!automaticFallback && (healthyFallbackProvider || networkRecovery)) {
      throw new ModelFallbackRequiredError(
        lastError.message,
        provider,
        networkRecovery ? selectableProviders[0] ?? provider : healthyFallbackProvider!,
        kind,
        lastError.status,
        attemptedRoute ? Date.now() - startedAt : 0,
        failedSupplier,
        lastFailure,
        networkRecovery ? selectableProviders : undefined
      );
    }
    if (!healthyFallbackProvider) throw lastError;
    console.warn(`${this.config.id}:${provider} failed; retrying with model ${healthyFallbackProvider}.`);
    const fallback = await this.invokeModel(operation, healthyFallbackProvider, options, acceptsRoute, onUpdate);
    return { ...fallback, fallbackFrom: provider };
  }
}

export const endpoints = { responseEndpoint, anthropicMessagesEndpoint };

export { ModelError, ModelFallbackRequiredError, type ModelFailureKind } from "./models/errors.js";
export type { ModelGatewayConfig } from "./models/gateway-config.js";
export { modelRequestDispatcher } from "./models/http-transport.js";
export type ModelInputImage = ReferenceImage;
