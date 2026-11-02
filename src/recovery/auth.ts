import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

const derive = promisify(scrypt);
export const deviceCookie = "__Secure-deepmind-device";
export const recoveryCookie = "__Secure-deepmind-recovery";
const duration = 24 * 60 * 60 * 1000;
export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
export type RecoveryIdentity = { key: string; passwordVersion: string };
export class RecoveryAuth {
  constructor(private readonly webPath: string, private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS recovery_devices(token_hash TEXT PRIMARY KEY,password_version TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_revoked(token_hash TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS recovery_attempts(key TEXT PRIMARY KEY,count INTEGER NOT NULL,resets_at INTEGER NOT NULL);`);
  }
  private read<T>(read: (web: DatabaseSync) => T): T | undefined {
    let web: DatabaseSync | undefined;
    try { web = new DatabaseSync(this.webPath, { readOnly: true }); return read(web); }
    catch { return undefined; }
    finally { web?.close(); }
  }
  private password(): string | undefined {
    return this.read(web => (web.prepare("SELECT value FROM settings WHERE key='password'").get() as { value: string } | undefined)?.value);
  }
  authenticate(cookies: string | undefined, now = Date.now()): RecoveryIdentity | undefined {
    const password = this.password(); if (!password) return;
    const version = digest(password), values = parseCookies(cookies);
    const main = values[deviceCookie];
    if (main && /^[A-Za-z0-9_-]{43}$/.test(main) && !this.db.prepare("SELECT 1 FROM recovery_revoked WHERE token_hash=?").get(digest(main))) {
      const valid = this.read(web => web.prepare("SELECT 1 FROM devices WHERE token_hash=? AND expires_at>?").get(digest(main), now));
      if (valid) return { key: digest(main), passwordVersion: version };
    }
    const local = values[recoveryCookie];
    if (local && /^[A-Za-z0-9_-]{43}$/.test(local) && this.db.prepare("SELECT 1 FROM recovery_devices WHERE token_hash=? AND password_version=? AND expires_at>?").get(digest(local), version, now))
      return { key: digest(local), passwordVersion: version };
  }
  async login(password: unknown, client: string, now = Date.now()): Promise<string | undefined> {
    this.db.prepare("DELETE FROM recovery_attempts WHERE resets_at<=?").run(now);
    for (const bucket of ["global", digest(client)]) {
      const entry = this.db.prepare("SELECT count FROM recovery_attempts WHERE key=?").get(bucket) as { count: number } | undefined;
      if ((entry?.count ?? 0) >= (bucket === "global" ? 40 : 10)) throw new Error("RATE_LIMIT");
    }
    for (const bucket of ["global", digest(client)]) this.db.prepare("INSERT INTO recovery_attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1").run(bucket, now + 900000);
    const expected = this.password();
    if (typeof password !== "string" || !password.length || password.length > 256 || !expected || !/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(expected)) return;
    const [, salt, hash] = expected.split(":");
    if (!timingSafeEqual(await derive(password, salt!, 64) as Buffer, Buffer.from(hash!, "hex"))) return;
    const token = randomBytes(32).toString("base64url");
    this.db.prepare("DELETE FROM recovery_devices WHERE expires_at<=?").run(now);
    this.db.prepare("INSERT INTO recovery_devices VALUES(?,?,?)").run(digest(token), digest(expected), now + duration);
    return token;
  }
  logout(cookies: string | undefined): void {
    for (const [name, token] of Object.entries(parseCookies(cookies))) {
      if (![deviceCookie, recoveryCookie].includes(name) || !/^[A-Za-z0-9_-]{43}$/.test(token)) continue;
      this.db.prepare("DELETE FROM recovery_devices WHERE token_hash=?").run(digest(token));
      this.db.prepare("INSERT OR IGNORE INTO recovery_revoked VALUES(?)").run(digest(token));
      this.db.prepare("DELETE FROM recovery_tickets WHERE device=?").run(digest(token));
    }
  }
}
export function parseCookies(value: string | undefined): Record<string, string> {
  return Object.fromEntries((value ?? "").split(";").map(value => value.trim().split("=", 2)).filter(([key, token]) => key && token));
}
export function cookie(name: string, value: string, basePath: string, clear = false): string {
  return `${name}=${value}; Path=${basePath}; HttpOnly; Secure; SameSite=Strict; Max-Age=${clear ? 0 : duration / 1000}`;
}
