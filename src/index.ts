import { startWebChannel } from "./web/server.js";
import { loadAgentConfig } from "./config.js";
import { acquireAgentLock } from "./process-lock.js";
import { createAgentRuntime } from "./runtime.js";

process.umask(0o077);

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    const shutdown = () => {
      for (const signal of signals) process.off(signal, shutdown);
      resolve();
    };
    for (const signal of signals) process.once(signal, shutdown);
  });
}

async function main(): Promise<void> {
  const [agentId, ...extraArgs] = process.argv.slice(2);
  if (!agentId || extraArgs.length > 0) {
    throw new Error("Usage: npm start -- <agent-id> (for example: npm start -- xiaochang)");
  }

  const releaseLock = await acquireAgentLock(agentId);
  const shutdown = waitForShutdownSignal();
  let runtime: Awaited<ReturnType<typeof createAgentRuntime>> | undefined;
  let web: Awaited<ReturnType<typeof startWebChannel>> | undefined;
  try {
    const config = await loadAgentConfig(agentId);
    runtime = await createAgentRuntime(config);
    web = await startWebChannel(runtime);
    runtime.scheduleReminders?.start();
    runtime.notifications?.start();
    await shutdown;
  } finally {
    await web?.close();
    await runtime?.close();
    await releaseLock();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
);
