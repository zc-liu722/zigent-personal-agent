import { createAntigravityModelService } from "./round.js";
import { AcpWarmPool } from "../../models/acp/warm-pool.js";

export function create(services: Readonly<Record<string, unknown>>) {
  const { version } = services.pluginIdentity as import("../contracts.js").PluginManifest;
  const pool = new AcpWarmPool("Antigravity");
  return { pinForTurn: true, services: { antigravityModel: createAntigravityModelService(pool, version) },
    async ready() {}, pause: () => pool.setTargets([]), dispose: () => pool.close() };
}
