import type { DatabaseSync } from "node:sqlite";
import { prepareSql, sqliteTransaction } from "../sqlite.js";
import type { WebMessage, WebStore } from "./store.js";

type ImageReferences = Pick<WebMessage, "id" | "assets" | "interactions" | "attachments">;

export function installConversationImageIndex(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_images(asset_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,sha256 TEXT NOT NULL,record TEXT NOT NULL,presented INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS conversation_images_pending ON conversation_images(presented,created_at);
    CREATE INDEX IF NOT EXISTS conversation_images_content ON conversation_images(conversation_id,sha256);
    CREATE TABLE IF NOT EXISTS conversation_image_origins(
      asset_id TEXT PRIMARY KEY, reply_id TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS conversation_image_origins_undelivered ON conversation_image_origins(asset_id) WHERE delivered=0;
    CREATE TABLE IF NOT EXISTS conversation_image_deliveries(
      reply_id TEXT NOT NULL, output_id TEXT NOT NULL, asset_id TEXT NOT NULL, output TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(reply_id,output_id));
    CREATE INDEX IF NOT EXISTS conversation_image_deliveries_asset ON conversation_image_deliveries(asset_id);
    CREATE INDEX IF NOT EXISTS conversation_image_deliveries_age ON conversation_image_deliveries(created_at);
    CREATE TABLE IF NOT EXISTS conversation_image_references(
      message_id TEXT NOT NULL, asset_id TEXT NOT NULL, PRIMARY KEY(message_id,asset_id));
    CREATE INDEX IF NOT EXISTS conversation_image_references_asset ON conversation_image_references(asset_id);
  `);
  const columns = db.prepare("PRAGMA table_info(web_messages)").all();
  if (!columns.some(column => column.name === "image_indexed"))
    db.exec("ALTER TABLE web_messages ADD COLUMN image_indexed INTEGER NOT NULL DEFAULT 0");
  // An older release or a maintenance writer may still update the projection directly.
  db.exec(`
    CREATE INDEX IF NOT EXISTS web_messages_image_backfill ON web_messages(image_indexed,seq) WHERE image_indexed<>1;
    CREATE TRIGGER IF NOT EXISTS web_messages_images_invalidated AFTER UPDATE OF payload ON web_messages
      WHEN OLD.image_indexed<>0 BEGIN UPDATE web_messages SET image_indexed=0 WHERE seq=NEW.seq; END;
    CREATE TRIGGER IF NOT EXISTS web_messages_images_deleted AFTER DELETE ON web_messages BEGIN
      DELETE FROM conversation_image_references WHERE message_id=OLD.id;
    END;
  `);
}

/** Run in the same transaction as the transport projection write. Archived messages also keep their references. */
export function indexConversationImages(db: DatabaseSync, message: ImageReferences): void {
  prepareSql(db, "DELETE FROM conversation_image_references WHERE message_id=?").run(message.id);
  const assets = new Set(message.assets ?? []);
  for (const interaction of message.interactions ?? []) {
    const output = interaction.output;
    if (interaction.kind !== "output" || !output) continue;
    const images = output.blocks.filter(block => block.type === "image");
    if (!images.length) continue;
    for (const block of images) assets.add(block.assetId);
    prepareSql(db, `DELETE FROM conversation_image_deliveries
      WHERE reply_id=? AND output_id=? AND output=?`).run(message.id, output.id, JSON.stringify(output));
  }
  for (const attachment of message.attachments ?? []) {
    for (const block of attachment.output.blocks) {
      if (block.type === "image") assets.add(block.assetId);
    }
  }
  for (const id of assets) {
    prepareSql(db, `INSERT INTO conversation_image_references(message_id,asset_id)
      SELECT ?,asset_id FROM conversation_images WHERE asset_id=?`).run(message.id, id);
    prepareSql(db, "UPDATE conversation_images SET presented=1 WHERE asset_id=? AND presented=0").run(id);
    prepareSql(db, "UPDATE conversation_image_origins SET delivered=1 WHERE asset_id=? AND delivered=0").run(id);
  }
  prepareSql(db, "UPDATE web_messages SET image_indexed=1 WHERE id=?").run(message.id);
}

export function backfillConversationImages(store: WebStore, state: 0 | 2, after: number, limit: number) {
  const { db, conversationStore } = store;
  const rows = prepareSql(db, `SELECT seq,id,payload FROM web_messages
    WHERE image_indexed<>1 AND image_indexed=? AND seq>? ORDER BY seq LIMIT ?`)
    .all(state, after, limit) as { seq: number; id: string; payload: string }[];
  for (const row of rows) {
    let message: ImageReferences;
    try {
      const payload = JSON.parse(row.payload) as WebMessage & { _conversation?: { hash: string } };
      if (payload._conversation) {
        const hash = payload._conversation.hash;
        const objects = conversationStore?.objects;
        if (objects?.field(hash, "id") !== row.id) throw new Error("CONVERSATION_IMAGE_REFERENCE_UNAVAILABLE");
        // Decode only the card collection, leaving text and large activity objects untouched.
        message = { id: row.id, assets: payload.assets,
          interactions: objects?.field(hash, "interactions") as WebMessage["interactions"],
          attachments: objects?.field(hash, "attachments") as WebMessage["attachments"] };
      } else {
        if (payload.id !== row.id || payload.storageUnavailable) throw new Error("CONVERSATION_IMAGE_REFERENCE_UNAVAILABLE");
        message = payload;
      }
      if (message.assets?.some(id => typeof id !== "string")) throw new Error("CONVERSATION_IMAGE_REFERENCE_UNAVAILABLE");
      const outputs = [...(message.interactions ?? []).filter(item => item.kind === "output").map(item => item.output),
        ...(message.attachments ?? []).map(item => item.output)];
      for (const output of outputs) {
        if (!Array.isArray(output?.blocks) || output.blocks.some(block => !block || typeof block.type !== "string" ||
          block.type === "image" && typeof block.assetId !== "string")) throw new Error("CONVERSATION_IMAGE_REFERENCE_UNAVAILABLE");
      }
    } catch {
      // Preserve any previously known references and retry this row in a later pass.
      prepareSql(db, "UPDATE web_messages SET image_indexed=2 WHERE seq=? AND payload=?").run(row.seq, row.payload);
      continue;
    }
    sqliteTransaction(db, () => {
      if (prepareSql(db, "SELECT 1 FROM web_messages WHERE seq=? AND payload=? AND image_indexed=?").get(row.seq, row.payload, state))
        indexConversationImages(db, message);
    });
  }
  return { count: rows.length, lastSeq: rows.at(-1)?.seq ?? after };
}
