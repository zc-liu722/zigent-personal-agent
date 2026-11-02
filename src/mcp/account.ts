import { createHash } from "node:crypto";
import { resolve } from "node:path";

export type McpOAuthAccount = {
  agentId: string;
  ownerUserId: string;
  storagePath: string;
};

/** No legacy shared-file fallback: unbound grants require fresh personal authorization. */
export function mcpOAuthAccount(service: "notion" | "xmind", storageDirectory: string, agentId: string, ownerUserId: string): McpOAuthAccount {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(agentId) || !ownerUserId.trim()) {
    throw new Error("MCP authorization requires an Agent and its owner");
  }
  const ownerKey = createHash("sha256").update(ownerUserId).digest("hex");
  return { agentId, ownerUserId, storagePath: resolve(storageDirectory, "accounts", agentId, ownerKey, `${service}-oauth.json`) };
}
