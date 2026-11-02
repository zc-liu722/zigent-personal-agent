import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

type AuthorizationLock = {
  id: string;
  path: string;
};

export async function tryAcquireLock(path: string): Promise<AuthorizationLock | undefined> {
  await mkdir(dirname(path), { recursive: true });
  const id = randomUUID();
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ id, createdAt: Date.now(), pid: process.pid })}\n`, "utf8");
    } finally {
      await handle.close();
    }
    return { id, path };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return undefined;
    throw error;
  }
}

export async function lockState(path: string): Promise<{ id?: string; createdAt?: number } | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    return {
      id: typeof record.id === "string" ? record.id : undefined,
      createdAt: typeof record.createdAt === "number" ? record.createdAt : undefined
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    return {};
  }
}

export async function releaseLock(lock: AuthorizationLock): Promise<void> {
  const current = await lockState(lock.path);
  if (current?.id !== lock.id) return;
  await unlink(lock.path).catch((error: unknown) => {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
  });
}

export async function removeStaleLock(path: string, staleAfterMs: number): Promise<boolean> {
  const current = await lockState(path);
  if (!current) return true;
  if (!current.createdAt || Date.now() - current.createdAt <= staleAfterMs) return false;
  const before = current.id;
  const latest = await lockState(path);
  if (latest?.id !== before) return false;
  await unlink(path).catch(() => undefined);
  return true;
}
