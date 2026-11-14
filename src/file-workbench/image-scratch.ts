import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { prepareSql, sqliteTransaction } from "../sqlite.js";
import type { WorkspaceService } from "../workspaces/service.js";

type Row = { session_id: string; turn_id: number; workspace_id: string; path: string };
const scratchTtlMs = 86_400_000;
/** Delivery releases a render path immediately. Age is the fallback when a round never delivers. */
export class ImageScratch {
  private readonly active = new Set<string>();
  constructor(private readonly db: DatabaseSync, private readonly files: WorkspaceService, private readonly assertIdle: (workspace: string) => void) {
    db.exec(`CREATE TABLE IF NOT EXISTS image_scratch(session_id TEXT NOT NULL,turn_id INTEGER NOT NULL,workspace_id TEXT NOT NULL,path TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(session_id,turn_id,workspace_id))`);
    sqliteTransaction(db, () => {
      const columns = db.prepare("PRAGMA table_info(image_scratch)").all();
      if (!columns.some(column => column.name === "released")) {
        db.exec("ALTER TABLE image_scratch ADD COLUMN released INTEGER NOT NULL DEFAULT 0");
        prepareSql(db, "UPDATE image_scratch SET expires_at=?").run(Date.now() + scratchTtlMs);
      }
      if (!columns.some(column => column.name === "cleanup_after"))
        db.exec("ALTER TABLE image_scratch ADD COLUMN cleanup_after INTEGER");
    });
    // Rows stamped with no deadline by the previous release become eligible after 24 hours.
    prepareSql(db, "UPDATE image_scratch SET expires_at=? WHERE expires_at>?").run(Date.now() + scratchTtlMs, Date.now() + scratchTtlMs * 2);
  }
  allocate(sessionId: string, turnId: number, workspaceId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const key = `${sessionId}:${turnId}`;
    if (!this.active.has(key)) {
      this.active.add(key);
      signal?.addEventListener("abort", () => this.active.delete(key), { once: true });
    }
    const expiresAt = Date.now() + scratchTtlMs;
    prepareSql(this.db, "INSERT OR IGNORE INTO image_scratch(session_id,turn_id,workspace_id,path,expires_at) VALUES (?,?,?,?,?)")
      .run(sessionId, turnId, workspaceId, `.scratch/images/${randomUUID()}`, expiresAt);
    prepareSql(this.db, "UPDATE image_scratch SET released=0,expires_at=?,cleanup_after=NULL WHERE session_id=? AND turn_id=? AND workspace_id=?")
      .run(expiresAt, sessionId, turnId, workspaceId);
    return (prepareSql(this.db, "SELECT path FROM image_scratch WHERE session_id=? AND turn_id=? AND workspace_id=?")
      .get(sessionId, turnId, workspaceId) as { path: string }).path;
  }
  async prepare(sessionId: string, turnId: number, workspaceId: string, signal?: AbortSignal) {
    const path = this.allocate(sessionId, turnId, workspaceId, signal);
    await this.files.withWriteLock(workspaceId, async () => {
      signal?.throwIfAborted();
      if (!this.files.executionDirectory(workspaceId) && !this.files.registeredDirectory(workspaceId)) this.assertIdle(workspaceId);
      await mkdir(await this.files.resolvePath(workspaceId, path, { allowMissing: true, initialize: false }), { recursive: true, mode: 0o700 });
    });
    return path;
  }
  finish(sessionId: string, turnId: number, delivered: boolean) {
    this.active.delete(`${sessionId}:${turnId}`);
    if (delivered) prepareSql(this.db, "UPDATE image_scratch SET released=1,cleanup_after=NULL WHERE session_id=? AND turn_id=?").run(sessionId, turnId);
  }
  private removable(row: Row, now: number) {
    const key = `${row.session_id}:${row.turn_id}`;
    if (this.active.has(key)) return false;
    const current = prepareSql(this.db, "SELECT released,expires_at FROM image_scratch WHERE session_id=? AND turn_id=? AND workspace_id=? AND path=?")
      .get(row.session_id, row.turn_id, row.workspace_id, row.path) as { released: number; expires_at: number } | undefined;
    return Boolean(current && (current.released === 1 || current.expires_at <= now));
  }
  private defer(row: Row, now: number) {
    prepareSql(this.db, "UPDATE image_scratch SET cleanup_after=? WHERE session_id=? AND turn_id=? AND workspace_id=? AND path=?")
      .run(now + 15 * 60_000, row.session_id, row.turn_id, row.workspace_id, row.path);
  }
  async cleanup() {
    const now = Date.now();
    const rows = prepareSql(this.db, `SELECT session_id,turn_id,workspace_id,path FROM image_scratch
      WHERE (released=1 OR expires_at<=?) AND (cleanup_after IS NULL OR cleanup_after<=?)
        AND path GLOB '.scratch/images/????????-????-????-????-????????????'
      ORDER BY COALESCE(cleanup_after,expires_at),rowid LIMIT 50`).all(now, now) as Row[];
    for (const row of rows) {
      const key = `${row.session_id}:${row.turn_id}`;
      if (this.active.has(key) || !/^\.scratch\/images\/[a-f0-9-]{36}$/.test(row.path)) { this.defer(row, now); continue; }
      try { this.files.workspace(row.workspace_id); }
      catch (error) {
        if (error instanceof Error && error.message.includes("已清理"))
          prepareSql(this.db, "DELETE FROM image_scratch WHERE session_id=? AND turn_id=? AND workspace_id=? AND path=?").run(row.session_id, row.turn_id, row.workspace_id, row.path);
        else this.defer(row, now);
        continue;
      }
      try {
        await this.files.withWriteLock(row.workspace_id, async () => {
          if (!this.removable(row, Date.now())) return;
          const path = await this.files.resolvePath(row.workspace_id, row.path, { allowMissing: true, initialize: false });
          this.assertIdle(row.workspace_id);
          if (!this.removable(row, Date.now())) return;
          await rm(path, { recursive: true, force: true });
          prepareSql(this.db, "DELETE FROM image_scratch WHERE session_id=? AND turn_id=? AND workspace_id=? AND path=? AND (released=1 OR expires_at<=?)")
            .run(row.session_id, row.turn_id, row.workspace_id, row.path, Date.now());
        });
      } catch { this.defer(row, now); }
    }
  }
}
