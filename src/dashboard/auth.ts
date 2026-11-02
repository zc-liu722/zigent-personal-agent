import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const derive = promisify(scrypt), lifetime = 24 * 60 * 60_000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const validHash = (value: string) => /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(value);
const cookieName = '__Secure-zigent-dashboard';
export class DashboardAuth {
  private readonly db: DatabaseSync;
  constructor(path: string, initialHash?: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=250;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices(token TEXT PRIMARY KEY,version TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);`);
    if (initialHash && validHash(initialHash)) this.db.prepare("INSERT OR IGNORE INTO settings VALUES('password',?)").run(initialHash);
  }
  private password() { return (this.db.prepare("SELECT value FROM settings WHERE key='password'").get() as { value: string } | undefined)?.value; }
  get ready() { return Boolean(this.password()); }
  private token(cookies = '') { return cookies.split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? ''; }
  private async verify(password: string) {
    const hash = this.password();
    if (!hash || !validHash(hash) || password.length > 256) return false;
    const [, salt, expected] = hash.split(':');
    return timingSafeEqual(await derive(password, salt!, 64) as Buffer, Buffer.from(expected!, 'hex'));
  }
  allow(client: string) {
    const now = Date.now(); this.db.prepare('DELETE FROM attempts WHERE expires<=?').run(now);
    for (const key of ['global', digest(client)]) {
      const row = this.db.prepare('SELECT count FROM attempts WHERE key=?').get(key) as { count: number } | undefined;
      if ((row?.count ?? 0) >= (key === 'global' ? 40 : 10)) return false;
    }
    for (const key of ['global', digest(client)]) this.db.prepare('INSERT INTO attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key, now + 15 * 60_000);
    return true;
  }
  authenticate(cookies?: string) {
    const token = this.token(cookies), password = this.password();
    return Boolean(password && /^[\w-]{43}$/.test(token) && this.db.prepare('SELECT 1 FROM devices WHERE token=? AND version=? AND expires>?').get(digest(token), digest(password), Date.now()));
  }
  private create() {
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('DELETE FROM devices WHERE expires<=?').run(Date.now());
    this.db.prepare('INSERT INTO devices VALUES(?,?,?)').run(digest(token), digest(this.password()!), Date.now() + lifetime);
    return this.cookie(token);
  }
  async login(password: string) { return await this.verify(password) ? this.create() : undefined; }
  async change(current: string, password: string) {
    if (!await this.verify(current)) return;
    const salt = randomBytes(16).toString('hex');
    const hash = `scrypt:${salt}:${(await derive(password, salt, 64) as Buffer).toString('hex')}`;
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.prepare("UPDATE settings SET value=? WHERE key='password'").run(hash); this.db.exec('DELETE FROM devices; COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.create();
  }
  logout(cookies?: string) { this.db.prepare('DELETE FROM devices WHERE token=?').run(digest(this.token(cookies))); return this.cookie(''); }
  private cookie(token: string) { return `${cookieName}=${token}; Path=/dashboard/; HttpOnly; Secure; SameSite=Strict; Max-Age=${token ? lifetime / 1000 : 0}`; }
  close() { this.db.close(); }
}
