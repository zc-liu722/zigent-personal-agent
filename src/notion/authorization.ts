import { XmindAuthBridgeClient } from "../xmind/auth-bridge.js";
import { notionFetch, withNotionConnection } from "./connection.js";
import { FileNotionOAuthProvider } from "./oauth.js";
import type { McpOAuthAccount } from "../mcp/account.js";
import {
  McpAuthorizationCoordinator,
  type McpAuthorizationConfig,
  type McpAuthorizationPrompt,
  type McpAuthorizationOutcome,
  type McpAuthorizationCallback
} from "../mcp/authorization.js";

export type NotionAuthorizationConfig = McpAuthorizationConfig & { account: McpOAuthAccount; bridgeUrl?: string; bridgeSecret?: string };
export type NotionAuthorizationPrompt = McpAuthorizationPrompt;
export type NotionAuthorizationOutcome = McpAuthorizationOutcome;

export class NotionAuthorizationCoordinator extends McpAuthorizationCoordinator {
  constructor(
    config: NotionAuthorizationConfig,
    bridge?: McpAuthorizationCallback
  ) {
    if (!bridge) {
      if (!config.bridgeUrl || !config.bridgeSecret) throw new Error("Notion authorization callback is not configured");
      bridge = new XmindAuthBridgeClient(config.bridgeUrl, config.bridgeSecret, notionFetch(config.proxyUrl), "notion");
    }
    super(config, config.account.storagePath, bridge, {
      label: "Notion",
      clientName: "zigent-notion",
      verificationCallbackUrl: bridge.callbackUrl,
      request: notionFetch(config.proxyUrl),
      withConnection: action => withNotionConnection(config.account.storagePath, action),
      createProvider: (onAuthorizationUrl, callbackUrl) => new FileNotionOAuthProvider(config.account, onAuthorizationUrl, callbackUrl)
    });
  }
}
