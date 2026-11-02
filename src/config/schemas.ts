import { win32 } from "node:path";
import { z } from "zod";
import { notificationSettingsSchema } from "../notifications/config.js";
import { REASONING_EFFORTS } from "./types.js";
import { validateManifest } from "./validation.js";

const providerSchema = z.enum(["claude", "gpt", "deepseek"]);
const modelNameSchema = z.string().trim().min(1).regex(/^[a-z][a-z0-9._-]*$/);
const identityPartSchema = z.string().trim().min(1);
const apiKeyEnvSchema = z.string().trim().regex(/^(?:\{ENV_PREFIX\}|[A-Z])[A-Z0-9_]*$/);
const endpointSchema = z.object({
  model: z.string().trim().min(1),
  baseUrl: z.string().trim().url()
});
const providerSettingsSchema = z.object({
  claude: endpointSchema.extend({
    maxTokens: z.number().int().positive(),
    reasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high")
  }).optional(),
  gpt: endpointSchema.extend({
    reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).default("high")
  }).optional(),
  deepseek: endpointSchema.extend({
    reasoningEffort: z.enum(["low", "high", "max"]).default("high")
  }).optional()
});
const costPolicySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("free") }),
  z.object({ type: z.literal("subscription") }),
  z.object({ type: z.literal("official"), multiplier: z.number().positive().default(1) })
]);
const modelReasoningSchema = z.object({
  levels: z.array(z.enum(REASONING_EFFORTS)).min(1).refine(levels => new Set(levels).size === levels.length, "reasoning levels cannot contain duplicates")
    .refine(levels => levels.every((level, index) => !index || REASONING_EFFORTS.indexOf(level) > REASONING_EFFORTS.indexOf(levels[index - 1]!)), "reasoning levels must be ordered from lowest to highest"),
  mode: z.enum(["effort", "fixed"]),
  sources: z.array(z.string().url()),
  checkedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().trim().min(1).optional()
}).superRefine((reasoning, context) => {
  if (reasoning.mode === "effort" && !reasoning.sources.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "adjustable reasoning requires supplier documentation sources" });
  if (reasoning.mode === "fixed" && (reasoning.levels.length !== 1 || !reasoning.note)) context.addIssue({ code: z.ZodIssueCode.custom, message: "fixed reasoning requires one level and an explanation" });
});
const modelContextSchema = z.object({
  windowTokens: z.number().int().min(4096),
  maxInputTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  strategy: z.enum(["summary", "openai-native", "anthropic-native", "runtime"]),
  confidence: z.enum(["verified", "conservative"]),
  limitSource: z.enum(["supplier", "manufacturer", "runtime"]).optional(),
  sources: z.array(z.string().url()).min(1),
  checkedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().trim().min(1).optional(),
  discoveryUrl: z.string().url().optional(),
  triggerRatio: z.number().min(0.4).max(0.9).optional(),
  keepRecentTokens: z.number().int().positive().optional(),
  summaryTokens: z.number().int().min(512).optional(),
  safetyTokens: z.number().int().positive().optional(),
  protectedTools: z.array(z.string().trim().min(1)).optional()
}).strict();
const modelDeploymentSchema = z.object({
  name: modelNameSchema,
  brand: identityPartSchema,
  supplier: identityPartSchema,
  apiModel: z.string().trim().min(1),
  // Legacy route-level connection fields remain readable during migration.
  apiKeyEnv: apiKeyEnvSchema.optional(),
  optional: z.boolean().default(false),
  baseUrl: z.string().trim().url().optional(),
  protocol: z.enum(["anthropic-messages", "openai-responses", "codex-app-server", "claude-code"]),
  network: z.enum(["direct", "proxy"]).optional(),
  cost: costPolicySchema.optional(),
  maxTokens: z.number().int().positive().optional(),
  context: modelContextSchema.optional(),
  reasoningEffort: z.enum(REASONING_EFFORTS).default("high"),
  reasoning: modelReasoningSchema.optional(),
  webSearch: z.object({ supplier: identityPartSchema }).optional(),
  capabilities: z.object({
    imageInput: z.boolean().default(false),
    functionTools: z.boolean().default(true),
    hostedTools: z.array(z.literal("web_search")).default([]).refine(
      (tools) => new Set(tools).size === tools.length,
      "capabilities.hostedTools cannot contain duplicates"
    ),
    delegatedTools: z.array(z.literal("web_search")).default([]).refine(
      (tools) => new Set(tools).size === tools.length,
      "capabilities.delegatedTools cannot contain duplicates"
    ),
    serviceTools: z.array(z.literal("web_search")).max(1).default([]),
    reasoningReplay: z.boolean().default(false)
  }).refine(capabilities => {
    const tools = [...capabilities.hostedTools, ...capabilities.delegatedTools, ...capabilities.serviceTools];
    return new Set(tools).size === tools.length;
  }, "a tool must have exactly one execution path on a model route").default({})
});
const supplierSchema = z.object({
  transport: z.enum(["http", "codex-app-server", "claude-code"]).default("http"),
  apiKeyEnv: z.union([
    apiKeyEnvSchema,
    z.array(apiKeyEnvSchema).min(1)
  ]).optional(),
  optional: z.boolean().default(false),
  network: z.enum(["direct", "proxy"]).default("direct"),
  cost: costPolicySchema,
  endpoints: z.object({
    "anthropic-messages": z.string().trim().url().optional(),
    "openai-responses": z.string().trim().url().optional(),
    "openai-images": z.string().trim().url().optional(),
    "native-videos": z.string().trim().url().optional(),
    "web-search": z.string().trim().url().optional()
  }).default({}),
  imageModel: z.string().trim().min(1).optional(),
  command: z.string().trim().min(1).optional(),
  codexHome: z.string().trim().min(1).refine(path => path.startsWith("/") || win32.isAbsolute(path), "codexHome must be absolute").optional(),
  args: z.array(z.string()).default([])
}).superRefine((supplier, context) => {
  if (supplier.transport === "http" && !supplier.apiKeyEnv) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["apiKeyEnv"],
      message: "HTTP model suppliers require apiKeyEnv"
    });
  }
  if (supplier.transport === "claude-code" && (!supplier.command || !supplier.args.length || supplier.apiKeyEnv || Object.keys(supplier.endpoints).length)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Claude Code requires an explicit restricted SSH command and no HTTP credentials/endpoints" });
  }
  if (supplier.transport !== "http" && supplier.cost.type !== "subscription") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cost"],
      message: "Official-client suppliers must use subscription cost accounting"
    });
  }
});
const imageModelSchema = z.object({
  name: modelNameSchema,
  brand: identityPartSchema,
  supplier: identityPartSchema,
  apiModel: z.string().trim().min(1),
  driverModel: modelNameSchema.optional(),
  driverReasoningEffort: z.enum(REASONING_EFFORTS).optional()
});
const modelCatalogSchema = z.object({
  suppliers: z.record(identityPartSchema, supplierSchema),
  models: z.array(modelDeploymentSchema.extend({ reasoning: modelReasoningSchema, reasoningEffort: z.enum(REASONING_EFFORTS) })
    .refine(model => model.reasoning.levels.includes(model.reasoningEffort),
      "catalogue models require a supported default reasoningEffort")).min(1),
  imageModels: z.array(imageModelSchema).default([]),
  videoModels: z.array(imageModelSchema).default([])
});
const runtimeSettingsSchema = z.object({
  zenmuxProxyUrl: z.string().trim().url().optional(),
  modelConnectTimeoutMs: z.number().int().positive(),
  modelFirstProgressTimeoutMs: z.number().int().positive(),
  modelProgressIdleTimeoutMs: z.number().int().positive(),
  imageGenerationTimeoutMs: z.number().int().positive().optional(),
  modelCircuitBreakerMs: z.number().int().positive(),
  modelRetryAttempts: z.number().int().positive().default(2),
  modelNetworkRetryAttempts: z.number().int().min(0).max(10).default(5),
  modelRetryDelayMs: z.number().int().nonnegative().default(1000)
});
const integrationsSchema = z.object({
  dashboard: z.object({
    publicUrl: z.string().url().refine(value => { try { const url = new URL(value); return url.protocol === 'https:' && url.pathname === '/dashboard/' && !url.username && !url.password && !url.search && !url.hash; } catch { return false; } }, 'Dashboard must use HTTPS and /dashboard/'),
    storage: z.string().trim().min(1),
    passwordHashEnv: z.literal('DASHBOARD_PASSWORD_HASH').default('DASHBOARD_PASSWORD_HASH')
  }).optional(),
  productivity: z.object({
    authorizationBridgeUrl: z.string().trim().url().startsWith("https://"),
    authorizationTimeoutMs: z.number().int().min(60_000).max(15 * 60_000).default(5 * 60_000),
    todoist: z.object({
      network: z.enum(["direct", "proxy"]).optional()
    }).optional()
  }).optional(),
  health: z.object({
    agents: z.array(z.literal("deepmind")).length(1),
    storage: z.string().trim().min(1),
    listenHost: z.literal("127.0.0.1").default("127.0.0.1"),
    listenPort: z.number().int().min(1024).max(65535).default(8789),
    tokenEnv: z.literal("HEALTH_INGEST_TOKEN").default("HEALTH_INGEST_TOKEN"),
    initialSkillPath: z.string().trim().min(1).optional(),
    publicUrl: z.string().trim().url().startsWith("https://").optional(),
    maxBodyBytes: z.number().int().min(1024).max(4 * 1024 * 1024).default(4 * 1024 * 1024)
  }).optional(),
  notion: z.object({
    serverUrl: z.literal("https://mcp.notion.com/mcp").default("https://mcp.notion.com/mcp"),
    authorizationBridgeUrl: z.string().trim().url().optional(),
    authorizationTimeoutMs: z.number().int().min(60_000).max(15 * 60_000).default(15 * 60_000)
  }).optional(),
  xmind: z.object({
    serverUrl: z.string().trim().url().default("https://app.xmind.com/api/mcp"),
    authorizationBridgeUrl: z.string().trim().url(),
    authorizationTimeoutMs: z.number().int().min(60_000).max(15 * 60_000).default(5 * 60_000)
  }).optional(),
  location: z.object({
    webProxyPort: z.number().int().min(1024).max(65535).optional(),
    agents: z.array(z.string().trim().regex(/^[a-z][a-z0-9-]*$/)).min(1).refine(
      (agents) => new Set(agents).size === agents.length,
      "location agents cannot contain duplicates"
    ),
    listenHost: z.literal("127.0.0.1").default("127.0.0.1"),
    listenPort: z.number().int().min(1024).max(65_535).default(8788),
    storage: z.string().trim().min(1),
    username: z.string().trim().min(1).max(128),
    passwordEnv: z.string().trim().regex(/^[A-Z][A-Z0-9_]*$/),
    amapApiKeyEnv: z.string().trim().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
    publicUrl: z.string().trim().url().startsWith("https://").optional(),
    maxBodyBytes: z.number().int().min(1024).max(65_536).default(16_384)
  }).optional()
}).default({});
const webSearchConfigSchema = z.object({
  search_context_size: z.enum(["low", "medium", "high"]).default("medium"),
  filters: z.object({
    allowed_domains: z.array(z.string().trim().min(1)).min(1)
  }).optional(),
  user_location: z.object({
    type: z.literal("approximate"),
    country: z.string().trim().min(1).optional(),
    city: z.string().trim().min(1).optional(),
    region: z.string().trim().min(1).optional(),
    timezone: z.string().trim().min(1).optional()
  }).optional(),
  external_web_access: z.boolean().optional(),
  delegateModel: modelNameSchema.optional()
});
const profileSchema = z.object({
  id: z.string().trim().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().trim().min(1),
  enabled: z.boolean().default(true),
  envPrefix: z.string().trim().regex(/^[A-Z][A-Z0-9_]*$/),
  channel: z.literal("web").default("web"),
  web: z.object({
    listenHost: z.literal("127.0.0.1").default("127.0.0.1"),
    listenPort: z.number().int().min(1024).max(65535),
    publicUrl: z.string().url().refine(value => { try { const url = new URL(value); return url.protocol === "https:" && /^\/[a-z][a-z0-9-]{0,63}\/$/.test(url.pathname) && !url.username && !url.password && !url.search && !url.hash; } catch { return false; } }, "Web URL must use HTTPS and an Agent base path"),
    storage: z.string().min(1),
    transcription: z.object({
      model: z.literal("doubao-seedasr2.0-official"),
      apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*_API_KEY$/),
      tos: z.object({ accessKeyEnv: z.string().min(1), secretKeyEnv: z.string().min(1),
        endpoint: z.string().regex(/^tos-[a-z0-9-]+\.volces\.com$/), region: z.string().min(1), bucket: z.string().min(1) }).strict()
    }).strict().optional(),
    speech: z.object({
      model: z.literal("doubao-seedasr2.0-official"),
      apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*_API_KEY$/)
    }).strict().optional()
  }).optional(),
  providerOrder: z.array(providerSchema).min(1).optional().refine(
    (providers) => !providers || new Set(providers).size === providers.length,
    "providerOrder cannot contain duplicates"
  ),
  providers: providerSettingsSchema.default({}),
  modelOrder: z.array(modelNameSchema).min(1).optional().refine(
    (models) => !models || new Set(models).size === models.length,
    "modelOrder cannot contain duplicates"
  ),
  suppliers: z.record(z.string().trim().min(1), supplierSchema).optional(),
  models: z.array(modelDeploymentSchema).min(1).optional(),
  imageModel: z.object({
    name: modelNameSchema,
    brand: identityPartSchema,
    supplier: identityPartSchema
  }).optional(),
  videoModel: z.object({
    name: modelNameSchema,
    brand: identityPartSchema,
    supplier: identityPartSchema
  }).optional(),
  officialVideoModel: z.object({
    name: modelNameSchema,
    brand: identityPartSchema,
    supplier: identityPartSchema
  }).optional(),
  highResolutionVideoModel: z.object({
    name: modelNameSchema,
    brand: identityPartSchema,
    supplier: identityPartSchema
  }).optional(),
  modelRuntime: runtimeSettingsSchema.partial().optional(),
  fileWorkbench: z.object({
    enabled: z.boolean().default(true),
    stateDirectory: z.string().trim().min(1),
    executionEndpoint: z.string().url().optional(),
    executionPreviousEndpoint: z.string().url().optional(),
    executionTokenEnv: apiKeyEnvSchema.optional(),
    executionTokenFile: z.string().trim().min(1).optional()
  }).strict().optional(),
  allowedTools: z.array(z.string().trim().min(1)).default([]).refine(
    (tools) => new Set(tools).size === tools.length,
    "allowedTools cannot contain duplicates"
  ),
  toolSettings: z.object({ web_search: webSearchConfigSchema.optional() }).default({}),
  notifications: notificationSettingsSchema.optional(),
  storage: z.object({
    sqlite: z.string().trim().min(1),
    longTermMemory: z.string().trim().min(1)
  }),
  sessionInactivityMinutes: z.number().int().positive().default(15),
  memoryContextWindowTokens: z.number().int().min(4096).optional(),
  memoryCompressionRatio: z.number().min(0.1).max(0.95).optional(),
  failureMessage: z.string().trim().min(1).optional()
}).superRefine((profile, context) => {
  if (profile.enabled && (!profile.web || !URL.canParse(profile.web.publicUrl) || new URL(profile.web.publicUrl).pathname !== `/${profile.id}/`)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["web"], message: "The web channel requires a dedicated /<agent-id>/ URL" });

  if (Boolean(profile.officialVideoModel) !== Boolean(profile.highResolutionVideoModel)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["officialVideoModel"],
      message: "officialVideoModel and highResolutionVideoModel must be configured together"
    });
  } else if (profile.officialVideoModel?.supplier !== profile.highResolutionVideoModel?.supplier) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["highResolutionVideoModel", "supplier"],
      message: "official video models must use the same supplier"
    });
  }
  if (profile.models && !profile.modelOrder) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["modelOrder"],
      message: "modelOrder is required when agent-local models are configured"
    });
  }
  if (profile.modelOrder && profile.models) {
    for (const [index, model] of profile.models.entries()) {
      const policy = model.context;
      if (policy && (policy.strategy === "openai-native" && model.protocol !== "openai-responses"
        || policy.strategy === "anthropic-native" && model.protocol !== "anthropic-messages"
        || policy.strategy === "runtime" && !["codex-app-server", "claude-code"].includes(model.protocol))) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["models", index, "context"], message: "compaction strategy must match the route transport" });
      }
    }
    const configuredNames = new Set(profile.models.map((model) => model.name));
    for (const name of profile.modelOrder) {
      if (!configuredNames.has(name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["models"],
          message: `modelOrder enables ${name}, but no deployment is configured`
        });
      }
    }
    for (const name of configuredNames) {
      if (!profile.modelOrder.includes(name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["modelOrder"],
          message: `modelOrder is missing configured model ${name}`
        });
      }
    }
    const names = profile.models.map((model) => model.name);
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["models"],
        message: "canonical model identity names must be unique"
      });
    }
    if (profile.suppliers) {
      for (const model of profile.models) {
        const supplier = profile.suppliers[model.supplier];
        if (!supplier) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["models"],
            message: `model ${model.name} references unknown supplier ${model.supplier}`
          });
        } else if ((model.protocol === "codex-app-server" || model.protocol === "claude-code") && supplier.transport !== model.protocol) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["suppliers", model.supplier, "transport"],
            message: `${model.supplier} is not a ${model.protocol} supplier for model ${model.name}`
          });
        } else if (model.protocol !== "codex-app-server" && model.protocol !== "claude-code" && !supplier.endpoints[model.protocol]) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["suppliers", model.supplier, "endpoints", model.protocol],
            message: `${model.supplier} has no ${model.protocol} endpoint for model ${model.name}`
          });
        }
      }
    } else {
      for (const model of profile.models) {
        if (!model.apiKeyEnv || !model.baseUrl || !model.network || !model.cost) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["models"],
            message: "legacy model routes require apiKeyEnv, baseUrl, network, and cost"
          });
          break;
        }
      }
    }
    return;
  }
  if (profile.modelOrder) return;
  if (!profile.providerOrder) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["modelOrder"],
      message: "configure modelOrder/models or the legacy providerOrder/providers"
    });
    return;
  }
  for (const provider of profile.providerOrder) {
    if (!profile.providers[provider]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["providers", provider],
        message: `providerOrder enables ${provider}, but its non-secret configuration is missing`
      });
    }
  }
});

const manifestShapeSchema = z.object({
  runtime: runtimeSettingsSchema,
  integrations: integrationsSchema,
  catalog: modelCatalogSchema.optional(),
  agents: z.array(profileSchema).min(1)
});

export type AgentProfile = z.infer<typeof profileSchema>;
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;
export type Manifest = z.infer<typeof manifestShapeSchema>;
export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;
export type Integrations = z.infer<typeof integrationsSchema>;
export const manifestSchema = manifestShapeSchema.superRefine(validateManifest);
