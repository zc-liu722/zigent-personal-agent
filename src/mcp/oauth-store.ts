import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpOAuthAccount } from "./account.js";

export type McpOAuthStore = {
  agentId?: string;
  ownerUserId?: string;
  serverUrl?: string;
  clientInformation?: OAuthClientInformationMixed;
  clientRedirectUrl?: string;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
  discoveryState?: OAuthDiscoveryState;
};

// This queue serializes updates within one provider, as before. It is not a cross-process lock.
export class McpOAuthFileStore {
  private updateQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly account: McpOAuthAccount,
    private readonly label: string,
    private readonly writeMode: "atomic" | "direct"
  ) {}

  async read(): Promise<McpOAuthStore> {
    try {
      const value: unknown = JSON.parse(await readFile(this.account.storagePath, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${this.label} OAuth storage is not a JSON object`);
      }
      const stored = value as McpOAuthStore;
      if (stored.agentId !== this.account.agentId || stored.ownerUserId !== this.account.ownerUserId) return {};
      return stored;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
      if (error instanceof SyntaxError) throw new Error(`${this.label} OAuth storage is not valid JSON`);
      throw error;
    }
  }

  async update(change: (current: McpOAuthStore) => McpOAuthStore): Promise<void> {
    const operation = this.updateQueue.then(async () => {
      const current = await this.read();
      const next = { ...change(current), agentId: this.account.agentId, ownerUserId: this.account.ownerUserId };
      const storagePath = this.account.storagePath;
      await mkdir(dirname(storagePath), { recursive: true });
      const content = `${JSON.stringify(next, null, 2)}\n`;
      if (this.writeMode === "direct") {
        await writeFile(storagePath, content, { encoding: "utf8", mode: 0o600 });
        return;
      }
      // Readers of this account must never see a half-written rotated token.
      const temporary = `${storagePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporary, storagePath);
      } finally { await rm(temporary, { force: true }); }
    });
    this.updateQueue = operation.catch(() => undefined);
    await operation;
  }
}
