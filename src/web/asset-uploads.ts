import type { IncomingMessage, ServerResponse } from "node:http";
import { documentName, fileLimit, fileMime } from "../capabilities/documents/files.js";
import { prepareSql, sqliteTransaction } from "../sqlite.js";
import { body, json } from "./http.js";
import type { WebStore } from "./store.js";

const CHUNK_BYTES = 1024 * 1024;
const BLOCK_BYTES = 64 * 1024;
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
type Upload = { total: number; asset_id: string | null; updated_at: number };

/** Authenticated, bounded staging; acknowledgements survive disconnects and releases. */
export class WebAssetUploads {
  private cleanedAt = 0;

  constructor(private readonly store: WebStore, private readonly onSaved?: (id: string) => Promise<void>) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS asset_uploads (
      id TEXT PRIMARY KEY, total INTEGER NOT NULL, asset_id TEXT, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS asset_upload_chunks (
      upload_id TEXT NOT NULL, start INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(upload_id,start));
      CREATE INDEX IF NOT EXISTS asset_uploads_updated ON asset_uploads(updated_at)`);
    store.db.exec("CREATE TABLE IF NOT EXISTS asset_upload_details (id TEXT PRIMARY KEY, name TEXT)");
  }

  discard(id: string): void {
    sqliteTransaction(this.store.db, () => {
      prepareSql(this.store.db, "DELETE FROM asset_upload_chunks WHERE upload_id IN (SELECT id FROM asset_uploads WHERE id=? AND asset_id IS NULL)").run(id);
      prepareSql(this.store.db, "DELETE FROM asset_uploads WHERE id=? AND asset_id IS NULL").run(id);
      prepareSql(this.store.db, "DELETE FROM asset_upload_details WHERE id=? AND NOT EXISTS (SELECT 1 FROM asset_uploads WHERE id=?)").run(id, id);
    });
  }

  async status(id: string, res: ServerResponse): Promise<void> {
    const db = this.store.db;
    const upload = prepareSql(db, "SELECT total,asset_id,updated_at FROM asset_uploads WHERE id=?").get(id) as Upload | undefined;
    if (!upload || upload.updated_at < Date.now() - RETAIN_MS) {
      json(res, 404, { error: "上传记录已过期。" }); return;
    }
    const details = prepareSql(db, "SELECT name FROM asset_upload_details WHERE id=?").get(id) as { name?: string } | undefined;
    const received = prepareSql(db, "SELECT COALESCE(SUM(length(bytes)),0) AS bytes FROM asset_upload_chunks WHERE upload_id=?").get(id) as { bytes: number };
    if (upload.asset_id) await this.onSaved?.(upload.asset_id);
    json(res, 200, { total: upload.total, offset: upload.asset_id ? upload.total : received.bytes,
      complete: Boolean(upload.asset_id), ...(upload.asset_id ? { id: upload.asset_id, mime: this.store.assetMime(upload.asset_id) } : {}), name: details?.name });
  }

  async receive(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const uploadId = req.headers["x-upload-id"], range = req.headers["content-range"];
    let name: string | undefined;
    try { if (typeof req.headers["x-file-name"] === "string") name = documentName(decodeURIComponent(req.headers["x-file-name"])); }
    catch { json(res, 400, { error: "文件名无效，请重新选择。" }); return; }
    const maxBytes = fileLimit(name);
    // Older open tabs can still finish their single-request uploads.
    if (uploadId === undefined && range === undefined) {
      const bytes = await body(req, maxBytes), mime = fileMime(bytes, name);
      if (!mime) { json(res, 400, { error: "文件格式无效。" }); return; }
      const id = this.store.addAsset(bytes, mime, name);
      await this.onSaved?.(id);
      json(res, 201, { id, name, mime }); return;
    }
    const match = typeof range === "string" ? /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range) : null;
    if (typeof uploadId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(uploadId) || !match) {
      json(res, 400, { error: "上传参数无效，请重新选择文件。" }); return;
    }
    const [start, end, total] = match.slice(1).map(Number) as [number, number, number];
    if (![start, end, total].every(Number.isSafeInteger) || total < 1 || total > maxBytes || start < 0 || start >= total
      || end < start || end >= total || end - start + 1 > CHUNK_BYTES
      || start % BLOCK_BYTES !== 0 || end + 1 < total && (end + 1) % BLOCK_BYTES !== 0) {
      json(res, 400, { error: "文件分块无效或超过大小限制。" }); return;
    }
    const bytes = await body(req, CHUNK_BYTES);
    if (bytes.length !== end - start + 1) { json(res, 400, { error: "文件分块不完整，请重试。" }); return; }
    const result = sqliteTransaction(this.store.db, () => {
      const db = this.store.db, now = Date.now();
      if (now - this.cleanedAt >= 60_000) {
        prepareSql(db, "DELETE FROM asset_upload_chunks WHERE upload_id IN (SELECT id FROM asset_uploads WHERE updated_at<?)").run(now - RETAIN_MS);
        prepareSql(db, "DELETE FROM asset_uploads WHERE updated_at<?").run(now - RETAIN_MS);
        prepareSql(db, "DELETE FROM asset_upload_details WHERE id NOT IN (SELECT id FROM asset_uploads)").run();
        this.cleanedAt = now;
      }
      const upload = prepareSql(db, "SELECT total,asset_id FROM asset_uploads WHERE id=?").get(uploadId) as Upload | undefined;
      if (upload && upload.total !== total) return { status: 409, error: "文件内容已变化，请重新选择。" };
      const details = prepareSql(db, "SELECT name FROM asset_upload_details WHERE id=?").get(uploadId) as { name?: string } | undefined;
      if (upload && (details?.name ?? undefined) !== name) return { status: 409, error: "文件名称已变化，请重新选择。" };
      if (upload?.asset_id) return { status: 200, id: upload.asset_id, offset: total, complete: true, name, mime: this.store.assetMime(upload.asset_id) };
      if (!upload) {
        // Expired staging restarts from zero; never persist a gap.
        if (start !== 0) return { status: 200, offset: 0, complete: false };
        const reserved = prepareSql(db, "SELECT COALESCE(SUM(total),0) AS bytes FROM asset_uploads WHERE asset_id IS NULL").get() as { bytes: number };
        if (reserved.bytes + total > 256 * 1024 * 1024) return { status: 429, error: "待上传文件过多，请稍后重试。" };
        prepareSql(db, "INSERT INTO asset_uploads(id,total,updated_at) VALUES (?,?,?)").run(uploadId, total, now);
        prepareSql(db, "INSERT OR REPLACE INTO asset_upload_details VALUES (?,?)").run(uploadId, name ?? null);
      }
      const received = prepareSql(db, "SELECT COALESCE(SUM(length(bytes)),0) AS bytes FROM asset_upload_chunks WHERE upload_id=?").get(uploadId) as { bytes: number };
      if (start > received.bytes) return { status: 200, offset: received.bytes, complete: false };
      if (start < received.bytes) {
        const chunk = prepareSql(db, "SELECT bytes FROM asset_upload_chunks WHERE upload_id=? AND start=?").get(uploadId, start) as { bytes: Uint8Array } | undefined;
        if (!chunk || !bytes.equals(chunk.bytes)) return { status: 409, error: "文件内容已变化，请重新选择。" };
      } else {
        if (start === 0 && !fileMime(bytes, name, false)) {
          prepareSql(db, "DELETE FROM asset_uploads WHERE id=?").run(uploadId);
          prepareSql(db, "DELETE FROM asset_upload_details WHERE id=?").run(uploadId);
          return { status: 400, error: "请选择图片、录音或文档。" };
        }
        prepareSql(db, "INSERT INTO asset_upload_chunks VALUES (?,?,?)").run(uploadId, start, bytes);
      }
      prepareSql(db, "UPDATE asset_uploads SET updated_at=? WHERE id=?").run(now, uploadId);
      const offset = Math.max(received.bytes, end + 1);
      if (offset < total) return { status: 200, offset, complete: false };
      const chunks = prepareSql(db, "SELECT bytes FROM asset_upload_chunks WHERE upload_id=? ORDER BY start").all(uploadId) as Array<{ bytes: Uint8Array }>;
      const original = Buffer.concat(chunks.map(chunk => chunk.bytes), total);
      const mime = fileMime(original, name);
      if (!mime) {
        prepareSql(db, "DELETE FROM asset_upload_chunks WHERE upload_id=?").run(uploadId);
        prepareSql(db, "DELETE FROM asset_uploads WHERE id=?").run(uploadId);
        prepareSql(db, "DELETE FROM asset_upload_details WHERE id=?").run(uploadId);
        return { status: 400, error: "文件格式无效，请重新选择。" };
      }
      const id = this.store.addAsset(original, mime, name);
      // Saving the asset and receipt in the same transaction prevents duplicate assets on retry.
      prepareSql(db, "UPDATE asset_uploads SET asset_id=? WHERE id=?").run(id, uploadId);
      prepareSql(db, "DELETE FROM asset_upload_chunks WHERE upload_id=?").run(uploadId);
      return { status: 201, id, offset: total, complete: true, name, mime };
    });
    const { status, ...response } = result;
    if ("id" in response && typeof response.id === "string") await this.onSaved?.(response.id);
    json(res, status, response);
  }
}
