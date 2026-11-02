import { modelCostMultiplier, type AgentConfig } from "../config.js";
import type { ModelGateway } from "../llm.js";
import { RollingSummaryCompressor } from "./compressor.js";
import { FileLongTermMemoryRepository } from "./long-term.js";
import { MemoryOrchestrator } from "./orchestrator.js";
import { SessionManager } from "./session-manager.js";
import { SQLiteMemoryStore } from "./store.js";

export async function createMemoryOrchestrator(config: AgentConfig, model: ModelGateway,
  longTermMemory = new FileLongTermMemoryRepository(config.longTermMemoryPath, config.id)): Promise<MemoryOrchestrator> {
  const store = new SQLiteMemoryStore(config.memoryStoragePath, config.id);
  await Promise.all([store.initialize(), longTermMemory.initialize()]);
  return new MemoryOrchestrator(
    new SessionManager(store, config.sessionInactivityMinutes * 60_000),
    new RollingSummaryCompressor(
      async (input, provider) => {
        const result = await model.generateSessionSummary(input, provider, { automaticFallback: false, signal: input.signal, reasoningEfforts: input.reasoningEfforts });
        return { ...result, modelIdentity: { model: result.model, name: result.provider, brand: result.route.brand,
          supplier: result.route.supplier, costMultiplier: modelCostMultiplier(result.route.cost) } };
      },
      (provider, signal) => model.contextPolicy(provider, signal)
    ),
    longTermMemory
  );
}
