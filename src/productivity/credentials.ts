import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { PersonalIntegrationConfig } from "./config.js";

export class ProductivityAuthorizationRequiredError extends Error {
  constructor(service: string, detail = "authorization expired or invalid; reconnect the account") { super(`${service}: ${detail}`); this.name = "ProductivityAuthorizationRequiredError"; }
}
export type CredentialConfig = PersonalIntegrationConfig & { tokenPath?: string; clientId?: string };
export type OAuthGrant = {
  agentId: string; ownerUserId: string; clientId: string; clientSecret?: string;
  accessToken?: string; refreshToken?: string; expiresAt?: number; scopes?: string[];
};
export async function readGrant(config: CredentialConfig): Promise<OAuthGrant | undefined> {
  if (!config.tokenPath || !config.ownerUserId) return undefined;
  try {
    const grant = JSON.parse(await readFile(config.tokenPath, "utf8")) as OAuthGrant;
    if (!grant || grant.agentId !== config.agentId || grant.ownerUserId !== config.ownerUserId || typeof grant.clientId !== "string"
      || config.clientId && config.clientId !== grant.clientId) return undefined;
    return grant;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ProductivityAuthorizationRequiredError("Account", "authorization storage is invalid; reconnect the account");
  }
}
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value) + "\n"); } finally { await handle.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
/** Serialize rotating tokens across processes. Never steal a lock from an uncertain refresh. */
export async function withTokenLock<T>(path: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const lock = `${path}.token-lock`, deadline = Date.now() + 35_000;
  while (true) {
    signal?.throwIfAborted();
    try { const handle = await open(lock, "wx", 0o600); await handle.close(); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("Account connection is busy; try again later");
      await delay(100, undefined, { signal });
    }
  }
  try { return await action(); } finally { await rm(lock, { force: true }); }
}
