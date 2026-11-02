import type { McpOAuthAccount } from "../mcp/account.js";
import { FileMcpOAuthProvider } from "../mcp/oauth-provider.js";

export const NOTION_MCP_SERVER_URL = "https://mcp.notion.com/mcp";
export const NOTION_OAUTH_CALLBACK_URL = "http://127.0.0.1:53683/callback";

export class FileNotionOAuthProvider extends FileMcpOAuthProvider {
  constructor(
    account: McpOAuthAccount,
    onAuthorizationUrl: (url: URL) => void | Promise<void> = () => undefined,
    callbackUrl: string = NOTION_OAUTH_CALLBACK_URL
  ) {
    super(account, {
      label: "Notion",
      softwareId: "zigent-notion",
      defaultServerUrl: NOTION_MCP_SERVER_URL,
      callbackUrl,
      onAuthorizationUrl,
      preserveClientOnAuthorization: true,
      writeMode: "atomic"
    });
  }
}
