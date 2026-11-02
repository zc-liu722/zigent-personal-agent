import { loadHealthReceiverConfig } from "./config.js";
import { UserHealthReceiver } from "./health/service.js";
process.umask(0o077);
async function main(): Promise<void> {
  const config = await loadHealthReceiverConfig();
  if (!config) throw new Error("Health receiver is not configured");
  const receiver = await UserHealthReceiver.create(config);
  try {
    await receiver.start();
    console.info("Private health receiver is listening on localhost");
    await new Promise<void>((resolve) => {
      const shutdown = () => { process.off("SIGINT", shutdown); process.off("SIGTERM", shutdown); resolve(); };
      process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
    });
  } finally { await receiver.close(); }
}
main().catch(() => { console.error("Health receiver failed; check private operator configuration and storage access"); process.exitCode = 1; });
