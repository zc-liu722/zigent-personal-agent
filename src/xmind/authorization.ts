import { createXmindAuthBridgeFetch, XmindAuthBridgeClient } from "./auth-bridge.js";
import { FileXmindOAuthProvider } from "./oauth.js";
import type { McpOAuthAccount } from "../mcp/account.js";
import {
  McpAuthorizationCoordinator,
  type McpAuthorizationConfig,
  type McpAuthorizationPrompt,
  type McpAuthorizationOutcome
} from "../mcp/authorization.js";

export type XmindAuthorizationConfig = McpAuthorizationConfig & { account: McpOAuthAccount; bridgeUrl: string; bridgeSecret: string };
export type XmindAuthorizationPrompt = McpAuthorizationPrompt;
export type XmindAuthorizationOutcome = McpAuthorizationOutcome;

export class XmindAuthorizationCoordinator extends McpAuthorizationCoordinator {
  constructor(
    config: XmindAuthorizationConfig,
    bridge = new XmindAuthBridgeClient(
      config.bridgeUrl,
      config.bridgeSecret,
      createXmindAuthBridgeFetch(config.proxyUrl)
    )
  ) {
    super(config, config.account.storagePath, bridge, {
      label: "XMind",
      clientName: "zigent-xmind",
      createProvider: (onAuthorizationUrl, callbackUrl) => new FileXmindOAuthProvider(config.account, onAuthorizationUrl, callbackUrl)
    });
  }
}
