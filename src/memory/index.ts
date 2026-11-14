import type { AgentConfig } from "../config.js";
import { FileLongTermMemoryRepository } from "./long-term.js";
import { MemoryOrchestrator } from "./orchestrator.js";
import { SessionManager } from "./session-manager.js";
import { SQLiteMemoryStore } from "./store.js";

export async function createMemoryOrchestrator(config: AgentConfig,
  longTermMemory = new FileLongTermMemoryRepository(config.longTermMemoryPath, config.id)): Promise<MemoryOrchestrator> {
  const store = new SQLiteMemoryStore(config.memoryStoragePath, config.id);
  await Promise.all([store.initialize(), longTermMemory.initialize()]);
  return new MemoryOrchestrator(
    new SessionManager(store, config.sessionInactivityMinutes * 60_000),
    longTermMemory
  );
}
