import { spawn } from "node:child_process";
import { loadAgentConfig } from "./config.js";
import { GOOGLE_DRIVE_SCOPES } from "./productivity/google-drive.js";
import { authorizeGoogleAccount } from "./productivity/google-oauth.js";

process.umask(0o077);

async function main(): Promise<void> {
  const agentId = process.argv[2];
  if (!agentId || process.argv.length !== 3) throw new Error("Usage: npx tsx src/google-drive-auth.ts <agent-id>");
  const agent = await loadAgentConfig(agentId);
  const config = agent.toolSettings?.google_drive;
  if (!agent.allowedTools.includes("google_drive") || !config) throw new Error("Google Drive is not enabled for this Agent");
  await authorizeGoogleAccount(config, "Google Drive", GOOGLE_DRIVE_SCOPES, url => {
    console.log(`Complete Google Drive read/write authorization in the browser. If it does not open, visit:\n${url}`);
    const command = process.platform === "win32" ? ["rundll32.exe", "url.dll,FileProtocolHandler"] : process.platform === "darwin" ? ["open"] : ["xdg-open"];
    const child = spawn(command[0]!, [...command.slice(1), url], { stdio: "ignore", detached: true });
    child.on("error", () => undefined); child.unref();
  });
  console.log("Read-only Google Drive authorization saved for the selected Agent. No files were changed.");
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Google Drive setup failed"); process.exitCode = 1; });
