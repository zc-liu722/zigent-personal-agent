import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadAgentConfig } from "./config.js";
import {
  FileXmindOAuthProvider,
  XMIND_OAUTH_CALLBACK_URL
} from "./xmind/oauth.js";

process.umask(0o077);

function openBrowser(url: string): void {
  const command = process.platform === "win32"
    ? { file: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] }
    : process.platform === "darwin"
      ? { file: "open", args: [url] }
      : { file: "xdg-open", args: [url] };
  const child = spawn(command.file, command.args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

async function callbackCode(provider: FileXmindOAuthProvider): Promise<string> {
  const callback = new URL(XMIND_OAUTH_CALLBACK_URL);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("XMind authorization timed out after five minutes"));
    }, 5 * 60_000);
    const finish = (action: () => void) => {
      clearTimeout(timeout);
      server.close(() => action());
    };
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? "/", XMIND_OAUTH_CALLBACK_URL);
        if (url.pathname !== callback.pathname) {
          response.writeHead(404).end("Not found");
          return;
        }
        const oauthError = url.searchParams.get("error");
        const code = url.searchParams.get("code");
        const actualState = url.searchParams.get("state");
        const expectedState = await provider.expectedState();
        if (oauthError) throw new Error(`XMind authorization failed: ${oauthError}`);
        if (!code) throw new Error("XMind authorization callback did not include a code");
        if (!expectedState || actualState !== expectedState) throw new Error("XMind authorization state did not match");
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("XMind authorization succeeded. You can close this page and return to the terminal.");
        finish(() => resolve(code));
      } catch (error) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("XMind authorization failed. Return to the terminal for details.");
        finish(() => reject(error));
      }
    });
    server.on("error", (error) => finish(() => reject(error)));
    server.listen(Number(callback.port), callback.hostname);
  });
}

async function verify(provider: FileXmindOAuthProvider, serverUrl: string): Promise<number> {
  const client = new Client({ name: "zigent-xmind", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: provider });
  try {
    await client.connect(transport, { timeout: 60_000 });
    const tools = await client.listTools(undefined, { timeout: 60_000 });
    return tools.tools.length;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const [agentId, ...extra] = process.argv.slice(2);
  if (!agentId || extra.length) throw new Error("Usage: npm run xmind:auth -- <agent-id>");
  const config = await loadAgentConfig(agentId);
  const settings = config.toolSettings?.xmind;
  if (!settings) throw new Error("XMind is not configured for this Agent");
  const { account, serverUrl } = settings;
  const quietProvider = new FileXmindOAuthProvider(account);
  await quietProvider.selectServer(serverUrl);

  try {
    const count = await verify(quietProvider, serverUrl);
    console.log(`XMind is already authorized. ${count} capabilities are available.`);
    return;
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
  }

  let authorizationUrl: URL | undefined;
  const provider = new FileXmindOAuthProvider(account, async (url) => {
    authorizationUrl = url;
    console.log(`Open this URL if the browser does not open automatically:\n${url.toString()}`);
    openBrowser(url.toString());
  });
  await provider.selectServer(serverUrl);
  await provider.resetForAuthorization();
  const codePromise = callbackCode(provider);
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: provider });
  const client = new Client({ name: "zigent-xmind", version: "1.0.0" });
  try {
    await client.connect(transport, { timeout: 60_000 });
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
  }
  if (!authorizationUrl) throw new Error("XMind did not provide an authorization URL");
  const code = await codePromise;
  await transport.finishAuth(code);
  await provider.resetTransientState();
  await client.close().catch(() => undefined);
  const count = await verify(provider, serverUrl);
  console.log(`XMind authorization completed for ${agentId}. ${count} capabilities are available.`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
);
