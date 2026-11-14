import type { CodexModelService } from "../../models/codex-contract.js";
import { CodexProcessPool, invokeCodexAppServerRound } from "./app-server.js";

export function create() {
  const pool = new CodexProcessPool();
  const codexModel: CodexModelService = {
    invoke(config, route, request, onUpdate, signal, record, executeTool) {
      return invokeCodexAppServerRound(config, route, request, onUpdate, signal, executeTool, record, undefined, pool);
    },
    imageRound(config, route, request, signal, record, task, performance) {
      // Image turns retain their own workspace and phased timeout lifecycle.
      return invokeCodexAppServerRound(config, route, request, undefined, signal, undefined, record, task, undefined, performance);
    },
    keepWarm: (config, targets) => pool.keepWarm(config, targets)
  };
  return { pinForTurn: true, services: { codexModel }, async ready() {},
    pause: () => pool.setTargets([]), dispose: () => pool.close() };
}
