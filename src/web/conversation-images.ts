import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { conversationOutputSchema, type ConversationOutput } from "../channels/output.js";
import { closeSqlite, prepareSql, sqliteTransaction } from "../sqlite.js";
import { backfillConversationImages } from "./conversation-image-index.js";
import type { WebStore } from "./store.js";

const RETENTION_MS = 24 * 60 * 60_000;
const BATCH_SIZE = 20;

export type ConversationImage = {
  assetId: string;
  width: number;
  height: number;
  mime: string;
  sha256: string;
  sourceUrl?: string;
  sourceKind: "web" | "screenshot" | "workspace";
  capturedAt: number;
};
type ImageSource = Pick<ConversationImage, "sourceKind" | "sourceUrl">;
type Candidate = { record: string; bytes: Uint8Array };
type PendingDelivery = { rowid: number; reply_id: string; output: string };

/** The web data service owns reply-scoped candidates and durable inline snapshots. */
export class ConversationImages {
  private candidates?: DatabaseSync;
  private timer?: NodeJS.Timeout;
  private unreadableCursor = 0;
  private unreadableRetryAt = 0;
  private deliveryCursor = 0;
  private warned = false;

  constructor(private readonly store: WebStore, private readonly candidatePath: string) {}

  private candidateStore(): DatabaseSync {
    if (this.candidates) return this.candidates;
    const db = new DatabaseSync(this.candidatePath);
    try {
      db.exec(`PRAGMA auto_vacuum=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS image_candidate_replies(reply_id TEXT PRIMARY KEY, touched_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS image_candidate_replies_age ON image_candidate_replies(touched_at);
        CREATE TABLE IF NOT EXISTS image_candidates(
          asset_id TEXT PRIMARY KEY, reply_id TEXT NOT NULL REFERENCES image_candidate_replies(reply_id) ON DELETE CASCADE,
          sha256 TEXT NOT NULL, source_kind TEXT NOT NULL, source_url TEXT NOT NULL, record TEXT NOT NULL, bytes BLOB NOT NULL,
          UNIQUE(reply_id,sha256,source_kind,source_url));
      `);
      this.candidates = db;
      return db;
    } catch (error) {
      closeSqlite(db);
      throw error;
    }
  }

  startMaintenance(retry: (replyId: string, output: ConversationOutput) => void, isActive: (replyId: string) => boolean) {
    const schedule = (delay: number) => {
      this.timer = setTimeout(() => {
        let more = false;
        try {
          more = this.recoverDeliveries(retry);
          more = this.backfill() || more;
          this.expireAssets();
        } catch {
          console.warn("CONVERSATION_IMAGE_MAINTENANCE_RETRY");
        }
        try {
          more = this.expireCandidates(isActive) || more;
        } catch {
          console.warn("CONVERSATION_IMAGE_CANDIDATE_CLEANUP_RETRY");
        }
        schedule(more ? 250 : 60_000);
      }, delay);
      this.timer.unref();
    };
    schedule(1000);
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    if (this.candidates) closeSqlite(this.candidates);
  }

  private permanentImage(conversationId: string, assetId: string): ConversationImage | undefined {
    const row = prepareSql(this.store.db, `SELECT record FROM conversation_images
      WHERE asset_id=? AND conversation_id=?`).get(assetId, conversationId);
    return row ? JSON.parse(String(row.record)) as ConversationImage : undefined;
  }

  private requireReply(conversationId: string, replyId: string) {
    if (this.store.resolveConversation(this.store.publicId(conversationId)) !== conversationId
      || this.replyState(replyId)?.conversation_id !== conversationId) throw new Error("对话已关闭。");
  }

  forConversation(conversationId: string) {
    return {
      get: (replyId: string, assetId: string) => {
        this.requireReply(conversationId, replyId);
        const permanent = this.permanentImage(conversationId, assetId);
        if (permanent) return permanent;
        const db = this.candidateStore();
        const row = prepareSql(db, "SELECT record FROM image_candidates WHERE reply_id=? AND asset_id=?").get(replyId, assetId);
        if (!row) throw new Error("当前回复没有这张候选图，请重新获取。");
        this.touchCandidates(db, replyId);
        return JSON.parse(String(row.record)) as ConversationImage;
      },
      read: (replyId: string, assetId: string) => {
        this.requireReply(conversationId, replyId);
        const asset = this.permanentImage(conversationId, assetId)
          ? this.store.asset(assetId) : this.candidateBytes(replyId, assetId);
        if (!asset) throw new Error("图片已过期，请重新获取。");
        return Buffer.from(asset.bytes);
      },
      saveCandidate: async (replyId: string, bytes: Buffer, source: ImageSource, signal?: AbortSignal) => {
        this.requireReply(conversationId, replyId);
        if (!bytes.length || bytes.length > 20 * 1024 ** 2) throw new Error("请选择不超过 20 MB 的图片。");
        // Rasterize before inspection or delivery. The authenticated attachment serves these exact bytes.
        const result = await sharp(bytes, { limitInputPixels: 40_000_000, pages: 1, autoOrient: true })
          .resize({ width: 6000, height: 6000, fit: "inside", withoutEnlargement: true })
          .png().timeout({ seconds: 10 }).toBuffer({ resolveWithObject: true });
        if (result.data.length > 32 * 1024 ** 2) throw new Error("图片解码后过大。");
        signal?.throwIfAborted();
        this.requireReply(conversationId, replyId);
        const sha256 = createHash("sha256").update(result.data).digest("hex");
        const db = this.candidateStore();
        return sqliteTransaction(db, () => {
          const existing = prepareSql(db, `SELECT record FROM image_candidates
            WHERE reply_id=? AND sha256=? AND source_kind=? AND source_url=?`).get(replyId, sha256, source.sourceKind, source.sourceUrl ?? "");
          this.touchCandidates(db, replyId);
          if (existing) return JSON.parse(String(existing.record)) as ConversationImage;
          const record: ConversationImage = { assetId: randomUUID(), width: result.info.width, height: result.info.height,
            mime: "image/png", sha256, ...source, capturedAt: Date.now() };
          prepareSql(db, "INSERT INTO image_candidates VALUES (?,?,?,?,?,?,?)")
            .run(record.assetId, replyId, sha256, source.sourceKind, source.sourceUrl ?? "", JSON.stringify(record), result.data);
          return record;
        });
      }
    };
  }

  /** Commit the selected bytes and the exact reply output before the channel attempts delivery. */
  prepareDelivery(conversationId: string, replyId: string, output: ConversationOutput): ConversationOutput {
    this.requireReply(conversationId, replyId);
    const block = output.blocks[0];
    if (output.blocks.length !== 1 || block?.type !== "image") throw new Error("图片交付需要一张已选图片。");
    const permanent = this.permanentImage(conversationId, block.assetId);
    const candidate = permanent ? undefined : this.candidateBytes(replyId, block.assetId);
    const image = candidate ? JSON.parse(candidate.record) as ConversationImage : permanent;
    if (!image) throw new Error("图片已过期，请重新获取。");
    return sqliteTransaction(this.store.db, () => {
      const db = this.store.db;
      const existing = candidate && prepareSql(db, `SELECT i.asset_id FROM conversation_images i JOIN assets a ON a.id=i.asset_id
        LEFT JOIN conversation_image_origins o ON o.asset_id=i.asset_id
        WHERE i.conversation_id=? AND i.sha256=? AND json_extract(i.record,'$.sourceKind')=?
        AND COALESCE(json_extract(i.record,'$.sourceUrl'),'')=?
        AND (o.delivered=1 OR o.reply_id=? OR (o.asset_id IS NULL AND i.presented=1)) LIMIT 1`)
        .get(conversationId, image.sha256, image.sourceKind, image.sourceUrl ?? "", replyId);
      let assetId = existing ? String(existing.asset_id) : image.assetId;
      if (!existing && candidate) {
        assetId = this.store.addAsset(Buffer.from(candidate.bytes), image.mime);
        // Older releases use presented as their retention flag. The actual receipt is committed with the reply.
        prepareSql(db, "INSERT INTO conversation_images VALUES (?,?,?,?,1,?)")
          .run(assetId, conversationId, image.sha256, JSON.stringify({ ...image, assetId }), Date.now());
        prepareSql(db, "INSERT INTO conversation_image_origins(asset_id,reply_id) VALUES (?,?)").run(assetId, replyId);
      } else if (!this.store.assetMime(assetId)) throw new Error("图片已过期，请重新获取。");
      const delivery = { ...output, blocks: [{ ...block, assetId }] };
      prepareSql(db, `INSERT INTO conversation_image_deliveries VALUES (?,?,?,?,?)
        ON CONFLICT(reply_id,output_id) DO UPDATE SET asset_id=excluded.asset_id,output=excluded.output,created_at=excluded.created_at`)
        .run(replyId, output.id, assetId, JSON.stringify(delivery), Date.now());
      return delivery;
    });
  }

  pendingForReply(replyId: string, outputId?: string): ConversationOutput[] {
    const db = this.store.db;
    const rows = outputId === undefined
      ? prepareSql(db, "SELECT output FROM conversation_image_deliveries WHERE reply_id=? ORDER BY rowid").all(replyId)
      : prepareSql(db, "SELECT output FROM conversation_image_deliveries WHERE reply_id=? AND output_id=?").all(replyId, outputId);
    return rows.map(row => conversationOutputSchema.parse(JSON.parse(String(row.output))));
  }

  finishReply(replyId: string, delivered: boolean) {
    if (this.candidates) prepareSql(this.candidates, "UPDATE image_candidate_replies SET touched_at=? WHERE reply_id=?")
      .run(delivered ? 0 : Date.now(), replyId);
  }

  private candidateBytes(replyId: string, assetId: string): Candidate | undefined {
    return prepareSql(this.candidateStore(), "SELECT record,bytes FROM image_candidates WHERE reply_id=? AND asset_id=?")
      .get(replyId, assetId) as Candidate | undefined;
  }

  private touchCandidates(db: DatabaseSync, replyId: string) {
    prepareSql(db, `INSERT INTO image_candidate_replies VALUES (?,?)
      ON CONFLICT(reply_id) DO UPDATE SET touched_at=excluded.touched_at`).run(replyId, Date.now());
  }

  private replyState(replyId: string) {
    return prepareSql(this.store.db, `SELECT m.conversation_id,json_extract(m.payload,'$.snapshot.status') AS status,
      COALESCE(json_extract(q.payload,'$.resume') AND json_extract(q.payload,'$.status')='queued',0) AS resuming
      FROM web_messages m JOIN conversations c ON c.id=m.conversation_id
      LEFT JOIN web_message_queue q ON q.id=json_extract(m.payload,'$.replyTo') AND q.conversation_id=m.conversation_id
      WHERE m.id=? AND m.deleted_at IS NULL AND c.deleted_at IS NULL`).get(replyId);
  }

  private recoverDeliveries(retry: (replyId: string, output: ConversationOutput) => void): boolean {
    const rows = prepareSql(this.store.db, `SELECT rowid,reply_id,output FROM conversation_image_deliveries
      WHERE rowid>? ORDER BY rowid LIMIT ?`).all(this.deliveryCursor, BATCH_SIZE) as PendingDelivery[];
    let failures = 0;
    for (const row of rows) {
      this.deliveryCursor = row.rowid;
      try {
        const state = this.replyState(row.reply_id);
        if (state && state.status !== "cancelled") retry(row.reply_id, conversationOutputSchema.parse(JSON.parse(row.output)));
      } catch {
        failures++;
      }
    }
    if (failures) console.warn("CONVERSATION_IMAGE_DELIVERY_RETRY", { count: failures });
    if (rows.length === BATCH_SIZE) return true;
    this.deliveryCursor = 0;
    return false;
  }

  private expireCandidates(isActive: (replyId: string) => boolean): boolean {
    const db = this.candidateStore();
    const cutoff = Date.now() - RETENTION_MS;
    const rows = prepareSql(db, "SELECT reply_id FROM image_candidate_replies WHERE touched_at<=? ORDER BY touched_at LIMIT ?")
      .all(cutoff, BATCH_SIZE) as { reply_id: string }[];
    for (const { reply_id } of rows) {
      if (this.replyState(reply_id)?.resuming || isActive(reply_id)) this.touchCandidates(db, reply_id);
      else prepareSql(db, "DELETE FROM image_candidate_replies WHERE reply_id=? AND touched_at<=?").run(reply_id, cutoff);
    }
    return rows.length === BATCH_SIZE;
  }

  private backfill(): boolean {
    const db = this.store.db;
    const batch = backfillConversationImages(this.store, 0, 0, BATCH_SIZE);
    let retrying = false;
    if (!batch.count && Date.now() >= this.unreadableRetryAt) {
      const retried = backfillConversationImages(this.store, 2, this.unreadableCursor, BATCH_SIZE);
      retrying = retried.count === BATCH_SIZE;
      this.unreadableCursor = retrying ? retried.lastSeq : 0;
      if (!retrying) this.unreadableRetryAt = Date.now() + RETENTION_MS;
    }
    const unreadable = Boolean(prepareSql(db, "SELECT 1 FROM web_messages WHERE image_indexed<>1 AND image_indexed=2 LIMIT 1").get());
    if (unreadable && !this.warned) {
      const count = prepareSql(db, "SELECT count(*) AS count FROM web_messages WHERE image_indexed<>1 AND image_indexed=2").get()?.count;
      console.warn("CONVERSATION_IMAGE_REFERENCES_UNAVAILABLE", { count });
    }
    this.warned = unreadable;
    return batch.count === BATCH_SIZE || retrying;
  }

  private expireAssets() {
    const db = this.store.db;
    const core = this.store.conversationStore;
    const cutoff = Date.now() - RETENTION_MS;
    // Pending projections and incomplete legacy indexing may still contain old references, including in branches.
    const legacyVerified = !prepareSql(db, "SELECT 1 FROM web_messages WHERE image_indexed<>1 LIMIT 1").get()
      && !(core && prepareSql(core.db, "SELECT 1 FROM conversation_outbox WHERE channel='web' AND delivered_at IS NULL LIMIT 1").get());
    sqliteTransaction(db, () => {
      // An accepted delivery stays retryable while its reply exists. Deleted, rewound and cancelled replies age out.
      prepareSql(db, `DELETE FROM conversation_image_deliveries WHERE rowid IN (
        SELECT d.rowid FROM conversation_image_deliveries d WHERE d.created_at<=? AND NOT EXISTS (
          SELECT 1 FROM web_messages m JOIN conversations c ON c.id=m.conversation_id
          WHERE m.id=d.reply_id AND m.deleted_at IS NULL AND c.deleted_at IS NULL
          AND CASE WHEN json_valid(m.payload) THEN json_extract(m.payload,'$.snapshot.status') IS NOT 'cancelled' ELSE 1 END
        ) ORDER BY d.created_at LIMIT ?)`).run(cutoff, BATCH_SIZE);
      if (!legacyVerified) return;
      const unused = prepareSql(db, `WITH unpresented AS (
        SELECT asset_id FROM conversation_images WHERE presented=0 AND created_at<=?
        UNION ALL
        SELECT o.asset_id FROM conversation_image_origins o JOIN conversation_images i ON i.asset_id=o.asset_id
          WHERE o.delivered=0 AND i.created_at<=?
      ) SELECT asset_id FROM unpresented i
      WHERE NOT EXISTS (SELECT 1 FROM conversation_image_references r WHERE r.asset_id=i.asset_id)
        AND NOT EXISTS (SELECT 1 FROM conversation_image_deliveries d WHERE d.asset_id=i.asset_id)
      LIMIT ?`).all(cutoff, cutoff, BATCH_SIZE) as { asset_id: string }[];
      for (const { asset_id } of unused) {
        for (const table of ["asset_previews", "asset_display_previews"]) {
          if (prepareSql(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
            prepareSql(db, `DELETE FROM ${table} WHERE asset_id=?`).run(asset_id);
        }
        prepareSql(db, "DELETE FROM conversation_image_origins WHERE asset_id=?").run(asset_id);
        prepareSql(db, "DELETE FROM conversation_images WHERE asset_id=?").run(asset_id);
        prepareSql(db, "DELETE FROM assets WHERE id=?").run(asset_id);
      }
    });
  }
}
