import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { AcpError, acpProcessEnvironment } from "../../models/acp/client.js";
import { array, invokeAcpRound, modelOptions, object, prepareAcpConversation } from "../../models/acp/round.js";
import type { AcpWarmPool } from "../../models/acp/warm-pool.js";
import type { ModelGatewayConfig } from "../../models/gateway-config.js";
import { nativeModelProxyOrder, withNativeProxyFailover } from "../../models/network-retry.js";
import { effectiveReasoningEffort } from "../../models/reasoning.js";
import type { ModelRoundRequest, NativeModelService } from "../../models/types.js";
import type { ModelDeployment } from "../../config.js";

const models = new Map([
  ["gemini-4argon-antigravity", "gemini-4-argon"],
  ["gemini-4hydrogen-antigravity", "gemini-4-hydrogen"],
  ["gemini-3.8flash-antigravity", "gemini-3.8-flash"]
]);
const denied = ["read_file(*)", "write_file(*)", "command(*)", "read_url(*)", "execute_url(*)", "download_url(*)"];

async function requireProfile(directory: string): Promise<string> {
  let settings: Record<string, unknown>;
  let profile: string;
  try {
    profile = await readFile(join(directory, "antigravity-cli", "settings.json"), "utf8");
    settings = object(JSON.parse(profile));
  } catch {
    throw new AcpError("authentication", "请在服务端初始化 Antigravity 专用目录并登录 Google 账号。");
  }
  const permissions = object(settings.permissions);
  const denyRules = permissions.deny;
  if (settings.toolPermission !== "request-review" || settings.allowNonWorkspaceAccess !== false
    || settings.agentMode !== "" || settings.modelProvider
    || !Array.isArray(permissions.allow) || permissions.allow.length !== 1 || permissions.allow[0] !== "mcp(zigent/*)"
    || !Array.isArray(denyRules) || !denied.every(rule => denyRules.includes(rule))) {
    throw new AcpError("configuration", "Antigravity 专用目录的权限或登录方式配置无效。");
  }
  const accountRevision = await readFile(join(directory, "zigent-account-generation"), "utf8").catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  return createHash("sha256").update(profile).update("\0").update(accountRevision).digest("hex");
}

function choices(options: unknown): Record<string, unknown>[] {
  return array(options).flatMap(item => Array.isArray(item.options) ? choices(item.options) : [item]);
}

const effortName = (value: string) => value.trim().toLowerCase() === "extra" ? "xhigh" : value.trim().toLowerCase();
const effortOption = (options: unknown) => array(options).find(item => item.category === "thought_level")
  ?? array(options).find(item => ["effort", "thinking", "thinking_level", "thinkingLevel", "reasoning", "reasoning_effort"].includes(String(item.id))
    || /^(?:thinking|reasoning)(?: level| effort)?$/i.test(String(item.name)));
const matchesEffort = (option: Record<string, unknown>, effort: string) =>
  [option.value, option.name].some(value => typeof value === "string" && effortName(value) === effort);

function processConfiguration(route: ModelDeployment, proxy?: string) {
  const { command, antigravityDataDir: dataDir } = route;
  if (route.supplier !== "antigravity" || route.cost.type !== "subscription" || !command || route.apiKey
    || !dataDir || !isAbsolute(dataDir) || models.get(route.name) !== route.apiModel) {
    throw new AcpError("configuration", "此 Antigravity 模型未获服务端配置授权。");
  }
  if (route.network === "proxy" && !proxy) throw new AcpError("configuration", "Antigravity 代理未配置。");
  return {
    key: JSON.stringify([command, dataDir, proxy]),
    async identity() {
      const [profile, binary] = await Promise.all([requireProfile(dataDir), isAbsolute(command) ? stat(command) : undefined]);
      return JSON.stringify([command, binary?.size, binary?.mtimeMs, profile]);
    },
    async launch(workspace: string, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const env = { ...acpProcessEnvironment(proxy), HOME: workspace, USERPROFILE: workspace,
        LOCALAPPDATA: workspace, APPDATA: workspace, TEMP: workspace, TMP: workspace, AGY_CLI_DISABLE_AUTO_UPDATE: "true" };
      return spawn(command, ["acp", "--process-per-session", "--sandbox", "--disable-telemetry",
        "--include-default-customizations=false", "--gemini-dir", dataDir],
        { cwd: workspace, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    }
  };
}

export function createAntigravityModelService(pool: AcpWarmPool, version: string): NativeModelService {
  const proxies = (config: ModelGatewayConfig, route: ModelDeployment) => nativeModelProxyOrder(config, route, route.antigravityProxyUrl);
  const failure = (error: unknown) =>
    error instanceof AcpError && error.acpFailure === "connection" ? "connection-error" as const : undefined;
  return {
    keepWarm(config, targets) {
      pool.setTargets(targets.flatMap(({ route, expiresAt }) => {
        try { return [pool.target(processConfiguration(route, proxies(config, route)[0]), config.modelConnectTimeoutMs, expiresAt)]; }
        catch { return []; }
      }));
    },
    async prepare(config, route, request, signal) {
      return withNativeProxyFailover(config, route, proxies(config, route), async proxy =>
        prepareAcpConversation(await driver(pool, version, route, request, proxy), config, route, request, signal), failure, undefined, signal);
    },
    async invoke(...args) {
      const [config, route, request, onUpdate, signal] = args;
      return withNativeProxyFailover(config, route, proxies(config, route), async proxy =>
        invokeAcpRound(await driver(pool, version, route, request, proxy), ...args), failure, onUpdate, signal);
    }
  };
}

async function driver(pool: AcpWarmPool, version: string, route: ModelDeployment,
  request: Pick<ModelRoundRequest, "systemPrompt" | "reasoningEfforts" | "reasoningEffort">, proxy?: string) {
  const process = processConfiguration(route, proxy);
  const processIdentity = await process.identity();
  const effort = effectiveReasoningEffort(route, request);
  const desired = [`${route.apiModel}-${effort}`, ...(effort === "xhigh" ? [`${route.apiModel}-extra`] : [])];
  const instructions = [request.systemPrompt,
    "Reply inside Zigent. Use only the tools mounted by Zigent for this request."].filter(Boolean).join("\n\n");
  const modelUnavailable = () => new AcpError("model", "Antigravity 账号未确认所选模型和推理档位，请检查订阅权限。");
  return {
    label: "Antigravity",
    pool, process, version, account: route.antigravityDataDir!, stateKey: effort, processIdentity,
    sessionMeta: {
      agy: { enabledTools: ["zigent"] },
      antigravity: { systemPrompt: { append: instructions }, eagerMcpServers: ["zigent"] }
    },
    usesSystemInstructions: true,
    runtimeContextWindow: true,
    mountedToolName(toolCall: unknown) {
      const name = object(toolCall).name;
      const prefix = "mcp_zigent_";
      return typeof name === "string" && name.startsWith(prefix) ? name.slice(prefix.length) : undefined;
    },
    async selectModel(client: import("../../models/acp/client.js").AcpClient,
      session: { sessionId: string; configOptions?: unknown; models?: { currentModelId?: string; availableModels?: unknown } }, signal: AbortSignal) {
      let options = session.configOptions;
      let model = modelOptions(options)[0];
      const sessionId = session.sessionId;
      if (typeof model?.id === "string") {
        const values = choices(model.options).map(choice => choice.value);
        const value = desired.find(id => values.includes(id)) ?? (values.includes(route.apiModel) ? route.apiModel : undefined);
        if (!value) throw modelUnavailable();
        if (model.currentValue !== value) {
          ({ configOptions: options } = await client.request<{ configOptions?: unknown }>(
            "session/set_config_option", { sessionId, configId: model.id, value }, signal));
          model = modelOptions(options)[0];
        }
        if (typeof model?.currentValue === "string" && desired.includes(model.currentValue)) return;
        const thinking = effortOption(options);
        if (model?.currentValue !== route.apiModel || typeof thinking?.id !== "string") throw modelUnavailable();
        const levels = choices(thinking.options);
        const valueForEffort = levels.find(level => level.value === effort)?.value
          ?? levels.find(level => matchesEffort(level, effort))?.value;
        if (typeof valueForEffort !== "string") throw modelUnavailable();
        if (thinking.currentValue === valueForEffort) return;
        ({ configOptions: options } = await client.request<{ configOptions?: unknown }>(
          "session/set_config_option", { sessionId, configId: thinking.id, value: valueForEffort }, signal));
        if (modelOptions(options)[0]?.currentValue !== route.apiModel || effortOption(options)?.currentValue !== valueForEffort) {
          throw modelUnavailable();
        }
        return;
      }
      if (session.models?.currentModelId && desired.includes(session.models.currentModelId)) return;
      const modelId = desired.find(id => array(session.models?.availableModels).some(option => option.modelId === id));
      if (!modelId) throw modelUnavailable();
      // Some ACP clients expose the effort-specific model IDs through the older model picker.
      const selected = await client.request<{ configOptions?: unknown; models?: { currentModelId?: string }; currentModelId?: string }>(
        "session/set_model", { sessionId, modelId }, signal);
      if (selected.currentModelId !== modelId && selected.models?.currentModelId !== modelId
        && modelOptions(selected.configOptions)[0]?.currentValue !== modelId) throw modelUnavailable();
    },
    modelChanged(options: unknown) {
      const model = modelOptions(options)[0]?.currentValue;
      const thinking = effortOption(options);
      if (typeof model === "string" && desired.includes(model)) return false;
      return (model !== undefined && model !== route.apiModel)
        || Boolean(thinking?.currentValue !== undefined && !choices(thinking.options).some(option =>
          option.value === thinking.currentValue && matchesEffort(option, effort)));
    }
  };
}
