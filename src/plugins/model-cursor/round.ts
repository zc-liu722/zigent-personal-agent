import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { AcpError } from "../../models/acp/client.js";
import { invokeAcpRound, modelOptions, prepareAcpConversation } from "../../models/acp/round.js";
import type { AcpWarmPool } from "../../models/acp/warm-pool.js";
import type { ModelGatewayConfig } from "../../models/gateway-config.js";
import type { NativeModelService } from "../../models/types.js";
import type { ModelDeployment } from "../../config.js";
import { cursorProcess } from "./process.js";

const models = new Map([["composer-2.5-cursor", "composer-2.5"], ["grok-4.7-cursor", "grok-4.7"]]);

const cursorSettings = JSON.stringify({
  version: 1, editor: { vimMode: false },
  permissions: { allow: ["Mcp(zigent:*)"], deny: ["Shell(*)", "Read(**)", "Write(**)", "WebFetch(*)"] },
  sandbox: { mode: "enabled", readBoundary: "workspace" }
});
const invalidProfile = () => new AcpError("configuration", "Cursor 专用目录的权限配置无效。");

function processConfiguration(config: ModelGatewayConfig, route: ModelDeployment) {
  if (route.supplier !== "cursor" || route.cost.type !== "subscription" || !route.command || !route.apiKey
    || models.get(route.name) !== route.apiModel) {
    throw new AcpError("configuration", "此 Cursor 模型未获服务端配置授权。");
  }
  const proxy = route.network === "proxy" ? config.zenmuxProxyUrl : undefined;
  if (route.network === "proxy" && !proxy) throw new AcpError("configuration", "Cursor 代理未配置。");
  const account = createHash("sha256").update(JSON.stringify([route.apiKey, route.apiModel])).digest("hex");
  const profile = config.memoryStoragePath ? `${config.memoryStoragePath}.cursor-acp` : undefined;
  return {
    key: JSON.stringify([route.command, route.apiModel, account, proxy]),
    account,
    async identity() {
      const installation = await cursorInstallation(route.command!);
      if (profile) {
        const settingsPath = join(profile, account, "cli-config.json");
        const stored = await readFile(settingsPath, "utf8").catch(error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        });
        if (stored !== undefined && stored !== cursorSettings) throw invalidProfile();
      }
      return JSON.stringify([route.command, installation]);
    },
    async launch(workspace: string, signal?: AbortSignal) {
      const cursorDir = profile ? join(profile, account) : join(workspace, ".cursor");
      await mkdir(cursorDir, { mode: 0o700, recursive: true });
      const configPath = join(cursorDir, "cli-config.json");
      // Startup uses an Agent-owned profile. Check the expected policy on
      // every new process without truncating a file another child may read.
      await writeFile(configPath, cursorSettings, { mode: 0o600, flag: "wx" }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      if (await readFile(configPath, "utf8") !== cursorSettings) throw invalidProfile();
      signal?.throwIfAborted();
      return cursorProcess(route, workspace, cursorDir, proxy);
    }
  };
}

async function cursorInstallation(command: string): Promise<string> {
  if (process.platform === "win32" && /\.cmd$/i.test(command)) {
    const directory = join(dirname(command), "versions");
    const versions = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory()
      && /^\d{4}\.\d{2}\.\d{2}-[a-f0-9-]+$/i.test(entry.name)).map(entry => entry.name).sort();
    const version = versions.at(-1);
    if (version) return version;
  }
  const metadata = await stat(command).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && dirname(command) === ".") return undefined;
    throw error;
  });
  if (!metadata) return command;
  return JSON.stringify([metadata.size, metadata.mtimeMs]);
}

export function createCursorModelService(pool: AcpWarmPool, version: string): NativeModelService {
  return {
    keepWarm(config, targets) {
      pool.setTargets(targets.flatMap(({ route, expiresAt }) => {
        try { return [pool.target(processConfiguration(config, route), config.modelConnectTimeoutMs, expiresAt)]; }
        catch { return []; }
      }));
    },
    async prepare(config, route, request, signal) {
      return prepareAcpConversation(await driver(pool, version, config, route), config, route, request, signal);
    },
    async invoke(...args) {
      const [config, route] = args;
      return invokeAcpRound(await driver(pool, version, config, route), ...args);
    }
  };
}

async function driver(pool: AcpWarmPool, version: string, config: ModelGatewayConfig, route: ModelDeployment) {
  const process = processConfiguration(config, route);
  const matches = (id: unknown) => typeof id === "string" && (id === route.apiModel
    || id === `${route.apiModel}-fast` || id.startsWith(`${route.apiModel}[`) && id.endsWith("]"));
  return {
    label: "Cursor",
    pool, process, version, account: process.account, processIdentity: await process.identity(),
    async selectModel(_client: unknown, session: { configOptions?: unknown; models?: { currentModelId?: string } }) {
      const ids = [...modelOptions(session.configOptions).map(item => item.currentValue), session.models?.currentModelId]
        .filter(id => typeof id === "string" && id);
      if (!ids.length || ids.some(id => !matches(id))) {
        throw new AcpError("model", "Cursor 未确认指定模型，已停止发送请求。");
      }
    },
    modelChanged: (options: unknown) => modelOptions(options).some(item => !matches(item.currentValue))
  };
}
