import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export const legacyTaskModel = "deepseek-v4.1flash-lemon";

/** Operational task creation uses the same saved web default as the running Agent. */
export function persistedTaskModelOptions(modelOrder: readonly string[], webStoragePath: string) {
  const fallback = modelOrder[0];
  if (!fallback) throw new Error("TASK_MODEL_ORDER_REQUIRED");
  return {
    legacyDefaultModel: modelOrder.includes(legacyTaskModel) ? legacyTaskModel : fallback,
    defaultModel(): string {
      if (!existsSync(webStoragePath)) return fallback;
      const db = new DatabaseSync(webStoragePath, { readOnly: true });
      try {
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000");
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get()) return fallback;
        const saved = db.prepare("SELECT value FROM settings WHERE key='default_model'").get()?.value;
        return typeof saved === "string" && modelOrder.includes(saved) ? saved : fallback;
      } finally { db.close(); }
    }
  };
}
