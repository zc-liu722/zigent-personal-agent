import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { McpOAuthAccount } from "../mcp/account.js";
import { FileMcpOAuthProvider } from "../mcp/oauth-provider.js";

export const XMIND_MCP_SERVER_URL = "https://app.xmind.com/api/mcp";
export const XMIND_OAUTH_CALLBACK_URL = "http://127.0.0.1:53682/callback";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function configuredXmindMcpServerUrl(
  environment: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const explicit = environment.XMIND_MCP_SERVER_URL?.trim();
  if (explicit) return new URL(explicit).toString().replace(/\/$/, "");
  const manifestPath = resolve(environment.AGENTS_CONFIG_PATH ?? "config/agents.json");
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    if (isRecord(manifest) && isRecord(manifest.integrations) && isRecord(manifest.integrations.xmind)) {
      const configured = manifest.integrations.xmind.serverUrl;
      if (typeof configured === "string" && configured.trim()) {
        return new URL(configured).toString().replace(/\/$/, "");
      }
    }
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
  return XMIND_MCP_SERVER_URL;
}

export class FileXmindOAuthProvider extends FileMcpOAuthProvider {
  constructor(
    account: McpOAuthAccount,
    onAuthorizationUrl: (url: URL) => void | Promise<void> = () => undefined,
    callbackUrl: string = XMIND_OAUTH_CALLBACK_URL
  ) {
    super(account, {
      label: "XMind",
      softwareId: "zigent-xmind",
      defaultServerUrl: XMIND_MCP_SERVER_URL,
      callbackUrl,
      onAuthorizationUrl,
      preserveClientOnAuthorization: false,
      writeMode: "atomic"
    });
  }
}
