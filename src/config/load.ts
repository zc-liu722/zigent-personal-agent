import { basename, resolve } from "node:path";
import { optionalEnv, requiredEnv, validUrl } from "./environment.js";
import { modelCatalogSnapshot } from "../models/catalog.js";
import { manifestSchema, type AgentProfile, type Manifest } from "./schemas.js";
import { readManifest } from "./manifest.js";
import { materializeProfile } from "./materialize.js";
import type { AgentConfig, Environment, HealthReceiverConfig, LocationReceiverConfig } from "./types.js";
import { assertAgentIsolation, assertUnique } from "./validation.js";

function loadProfile(profile: AgentProfile, manifest: Manifest, environment: Environment, manifestPath: string): AgentConfig {
  const config = materializeProfile(profile, manifest.runtime, environment, manifest.catalog, manifest.integrations);
  const variant = resolve(manifestPath) === resolve("config/agents.json") ? "local"
    : basename(manifestPath) === "agents.production.json" && environment.NODE_ENV === "production" ? "production" : undefined;
  if (!variant || !manifest.catalog || profile.models || !profile.modelOrder) return config;

  config.modelCatalogBinding = {
    variant,
    bind(data) {
      const { models, orders } = data as { models: unknown; orders: Record<string, unknown> };
      if (!orders || Object.keys(orders).length !== manifest.agents.length
        || manifest.agents.some(agent => !Object.hasOwn(orders, agent.id))) {
        throw new Error("MODEL_CATALOG_AGENT_MISMATCH");
      }
      const result = manifestSchema.safeParse({
        ...manifest, catalog: { ...manifest.catalog, models },
        agents: manifest.agents.map(agent => ({ ...agent, modelOrder: orders[agent.id] }))
      });
      if (!result.success) {
        const issues = result.error.issues.map(issue => issue.path.join(".")).join(", ");
        throw new Error(`MODEL_CATALOG_INVALID: ${issues}`);
      }
      const next = result.data;
      const nextProfile = next.agents.find(agent => agent.id === profile.id)!;
      return modelCatalogSnapshot(materializeProfile(nextProfile, next.runtime, environment, next.catalog, next.integrations));
    }
  };
  return config;
}

export async function loadAgentConfigs(
  environment: Environment = process.env,
  manifestPath = environment.AGENTS_CONFIG_PATH ?? "config/agents.json"
): Promise<AgentConfig[]> {
  const manifest = await readManifest(manifestPath);

  assertAgentIsolation(manifest);

  const configs = manifest.agents
    .filter((profile) => profile.enabled)
    .map(profile => loadProfile(profile, manifest, environment, manifestPath));
  assertUnique(configs.map((config) => ({ value: config.memoryStoragePath, agentId: config.id })), "SQLite path");
  assertUnique(configs.map((config) => ({ value: config.longTermMemoryPath, agentId: config.id })), "Long-term memory path");
  return configs;
}

export async function loadAgentConfig(
  agentId: string,
  environment: Environment = process.env,
  manifestPath = environment.AGENTS_CONFIG_PATH ?? "config/agents.json"
): Promise<AgentConfig> {
  const manifest = await readManifest(manifestPath);

  assertAgentIsolation(manifest);

  const profile = manifest.agents.find((candidate) => candidate.id === agentId);
  if (!profile) {
    throw new Error(`Unknown agent ${agentId}; available agents: ${manifest.agents.map(({ id }) => id).join(", ")}`);
  }
  if (!profile.enabled) throw new Error(`Agent ${agentId} is disabled`);

  return loadProfile(profile, manifest, environment, manifestPath);
}

export async function loadLocationReceiverConfig(
  environment: Environment = process.env,
  manifestPath = environment.AGENTS_CONFIG_PATH ?? "config/agents.json"
): Promise<LocationReceiverConfig | undefined> {
  const manifest = await readManifest(manifestPath);
  const location = manifest.integrations.location;
  if (!location) return undefined;
  const projectMcp = manifest.integrations.projectMcp;
  return {
    projectMcp: projectMcp ? { credentialFile: resolve(projectMcp.credentialFile),
      agents: manifest.agents.filter(agent => projectMcp.agents.includes(agent.id)).map(agent => ({ id: agent.id, port: agent.web!.listenPort })) } : undefined,
    webProxyPort: location.webProxyPort,
    webProxyRoutes: manifest.agents.filter(agent => agent.enabled && agent.channel === "web" && agent.web).map(agent => ({ basePath: new URL(agent.web!.publicUrl).pathname, port: agent.web!.listenPort })),
    listenHost: location.listenHost,
    listenPort: location.listenPort,
    storagePath: resolve(location.storage),
    username: location.username,
    password: requiredEnv(environment, location.passwordEnv),
    ...(location.publicUrl ? { publicUrl: validUrl(location.publicUrl, "integrations.location.publicUrl") } : {}),
    maxBodyBytes: location.maxBodyBytes
  };
}

/** The device broker must not depend on model keys, speech or Feishu startup. */
export async function loadCodexBrokerConfigs(environment: Environment = process.env,
  manifestPath = environment.AGENTS_CONFIG_PATH ?? "config/agents.json") {
  const manifest = await readManifest(manifestPath, "zod");
  assertAgentIsolation(manifest, false);
  return manifest.agents.filter(profile => profile.id === "deepmind" && profile.enabled && profile.allowedTools.includes("codex")).map(profile => {
    const ownerUserId = optionalEnv(environment, `${profile.envPrefix}_WEB_OWNER_USER_ID`)
      ?? optionalEnv(environment, `${profile.envPrefix}_NOTIFICATION_OWNER_USER_ID`) ?? optionalEnv(environment, "HEALTH_OWNER_USER_ID");
    if (!ownerUserId) throw new Error(`${profile.id}: Codex owner is not configured`);
    return { agentId: profile.id, ownerUserId, databasePath: resolve(profile.storage.sqlite) + ".codex.sqlite" };
  });
}

export async function loadHealthReceiverConfig(
  environment: Environment = process.env,
  manifestPath = environment.AGENTS_CONFIG_PATH ?? "config/agents.json"
): Promise<HealthReceiverConfig | undefined> {
  const manifest = await readManifest(manifestPath, "health");
  const health = manifest.integrations.health;
  if (!health) return undefined;
  const ingestToken = requiredEnv(environment, health.tokenEnv);
  if (ingestToken.length < 32 || /\s/.test(ingestToken)) throw new Error("HEALTH_INGEST_TOKEN must contain at least 32 characters without whitespace");
  const additionalAccounts = health.additionalAccounts.map(account => ({ agentId: account.agentId,
    storagePath: resolve(account.storage), ingestToken: requiredEnv(environment, account.tokenEnv) }));
  const tokens = [ingestToken, ...additionalAccounts.map(account => account.ingestToken)];
  if (tokens.some(token => token.length < 32 || /\s/.test(token)) || new Set(tokens).size !== tokens.length)
    throw new Error("Health ingestion credentials must be valid and unique per Agent");
  return { additionalAccounts, storagePath: resolve(health.storage), listenHost: health.listenHost, listenPort: health.listenPort, ingestToken, maxBodyBytes: health.maxBodyBytes };
}
