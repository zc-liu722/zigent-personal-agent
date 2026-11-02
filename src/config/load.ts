import { resolve } from "node:path";
import { optionalEnv, requiredEnv, validUrl } from "./environment.js";
import { readManifest } from "./manifest.js";
import { materializeProfile } from "./materialize.js";
import type { AgentConfig, Environment, HealthReceiverConfig, LocationReceiverConfig } from "./types.js";
import { assertAgentIsolation, assertUnique } from "./validation.js";

export async function loadAgentConfigs(
  environment: Environment = process.env,
  manifestPath = environment.AGENTS_CONFIG_PATH ?? "config/agents.json"
): Promise<AgentConfig[]> {
  const manifest = await readManifest(manifestPath);

  assertAgentIsolation(manifest);

  const configs = manifest.agents
    .filter((profile) => profile.enabled)
    .map((profile) => materializeProfile(
      profile,
      manifest.runtime,
      environment,
      manifest.catalog,
      manifest.integrations
    ));
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

  const config = materializeProfile(
    profile,
    manifest.runtime,
    environment,
    manifest.catalog,
    manifest.integrations
  );
  return config;
}

export async function loadLocationReceiverConfig(
  environment: Environment = process.env,
  manifestPath = environment.AGENTS_CONFIG_PATH ?? "config/agents.json"
): Promise<LocationReceiverConfig | undefined> {
  const manifest = await readManifest(manifestPath);
  const location = manifest.integrations.location;
  if (!location) return undefined;
  return {
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
  return manifest.agents.filter(profile => profile.enabled && profile.allowedTools.includes("codex")).map(profile => {
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
  return { storagePath: resolve(health.storage), listenHost: health.listenHost, listenPort: health.listenPort, ingestToken, maxBodyBytes: health.maxBodyBytes };
}
