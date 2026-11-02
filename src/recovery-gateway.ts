import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startRecoveryGateway } from "./recovery/gateway.js";
import { validateConfig } from "./recovery/service.js";

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = validateConfig(JSON.parse(await readFile(process.argv[2]!, "utf8")));
  const gateway = await startRecoveryGateway(config);
  console.info(`RECOVERY_READY port=${gateway.port}`);
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void gateway.close().then(() => process.exit(0)); });
}
