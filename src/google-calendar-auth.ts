import { spawn } from "node:child_process";
import { loadAgentConfig } from "./config.js";
import { authorizeGoogleCalendar } from "./productivity/google-oauth.js";

process.umask(0o077);

async function main(): Promise<void> {
  const agentId = process.argv[2];
  if (!agentId || process.argv.length !== 3) throw new Error("Usage: npx tsx src/google-calendar-auth.ts <agent-id>");
  const agent = await loadAgentConfig(agentId);
  const config = agent.toolSettings?.google_calendar;
  if (!agent.allowedTools.includes("google_calendar") || !config) throw new Error("Google Calendar is not enabled for this Agent");
  await authorizeGoogleCalendar(config, url => {
    console.log(`Complete Google Calendar authorization in the browser. If it does not open, visit:\n${url}`);
    const command = process.platform === "win32" ? ["rundll32.exe", "url.dll,FileProtocolHandler"] : process.platform === "darwin" ? ["open"] : ["xdg-open"];
    const child = spawn(command[0]!, [...command.slice(1), url], { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  });
  console.log("Google Calendar authorization saved for the selected Agent. No calendar events were changed.");
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Google Calendar setup failed"); process.exitCode = 1; });
