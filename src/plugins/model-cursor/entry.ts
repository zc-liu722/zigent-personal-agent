import { AcpWarmPool } from "../../models/acp/warm-pool.js";
import { createCursorModelService } from "./round.js";

export function create(services: Readonly<Record<string, unknown>>) {
  const { version } = services.pluginIdentity as import("../contracts.js").PluginManifest;
  const pool = new AcpWarmPool("Cursor");
  return { pinForTurn: true, services: { cursorModel: createCursorModelService(pool, version) },
    async ready() {}, pause: () => pool.setTargets([]), dispose: () => pool.close() };
}
