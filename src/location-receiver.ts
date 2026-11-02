import { loadCodexBrokerConfigs, loadLocationReceiverConfig } from "./config.js";
import { CodexService } from "./codex/service.js";
import { createCodexHttp } from "./codex/http.js";
import { createDashboardGateway } from "./dashboard/gateway.js";
import { UserLocationReceiver } from "./location/service.js";

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
  const config = await loadLocationReceiverConfig();
  if (!config) throw new Error("Location receiver is not configured");
  const receiver = await UserLocationReceiver.create(config);
  const services = new Map<string, CodexService>();
  for (const options of await loadCodexBrokerConfigs()) services.set(options.agentId, new CodexService(options));
  const codex = createCodexHttp(services), dashboard = await createDashboardGateway();
  receiver.attachExtension({
    async handle(req, res) { return Boolean(await dashboard?.handle(req, res)) || codex.handle(req, res); },
    close() { dashboard?.close(); codex.close(); }
  });
  try {
    await receiver.start();
    await waitForShutdownSignal();
  } finally {
    await receiver.close();
    for (const service of services.values()) service.close();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
);
