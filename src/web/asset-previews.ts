import sharp from "sharp";
import { prepareSql } from "../sqlite.js";
import type { WebStore } from "./store.js";

type Preview = { mime: string; width: number; height: number; available: number };
type Variant = "thumbnail" | "display";
const table = (variant: Variant) => variant === "display" ? "asset_display_previews" : "asset_previews";

/** Private derived media. Native image work is asynchronous, shared and bounded. */
export class WebAssetPreviews {
  private readonly pending = new Map<string, Promise<Preview | undefined>>();
  private readonly waiting: Array<() => void> = [];
  private active = 0;

  constructor(private readonly store: WebStore) {
    for (const variant of ["thumbnail", "display"] as const) store.db.exec(`CREATE TABLE IF NOT EXISTS ${table(variant)} (
      asset_id TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes BLOB, width INTEGER NOT NULL, height INTEGER NOT NULL)`);
  }

  private metadata(id: string, variant: Variant): Preview | undefined {
    return prepareSql(this.store.db, `SELECT mime,width,height,bytes IS NOT NULL AS available FROM ${table(variant)} WHERE asset_id=?`)
      .get(id) as Preview | undefined;
  }

  dimensions(ids: string[]): Record<string, { width: number; height: number }> {
    const unique = [...new Set(ids)];
    if (!unique.length) return {};
    const rows = prepareSql(this.store.db, `SELECT asset_id,width,height FROM asset_previews WHERE width>0 AND asset_id IN (${unique.map(() => "?").join(",")})`)
      .all(...unique) as Array<{ asset_id: string; width: number; height: number }>;
    return Object.fromEntries(rows.map(row => [row.asset_id, { width: row.width, height: row.height }]));
  }

  read(id: string, variant: Variant = "thumbnail") {
    return prepareSql(this.store.db, `SELECT mime,bytes FROM ${table(variant)} WHERE asset_id=? AND bytes IS NOT NULL`)
      .get(id) as { mime: string; bytes: Uint8Array } | undefined;
  }

  prepare(id: string, variant: Variant = "thumbnail"): Promise<Preview | undefined> {
    const cached = this.metadata(id, variant);
    if (cached) return Promise.resolve(cached);
    const key = `${variant}:${id}`;
    const pending = this.pending.get(key);
    if (pending) return pending;
    // Overload falls back to the original without storing a failed conversion.
    if (this.pending.size >= 32) return Promise.resolve(undefined);
    const operation = this.generate(id, variant).catch(() => undefined).finally(() => this.pending.delete(key));
    this.pending.set(key, operation); return operation;
  }

  private async generate(id: string, variant: Variant): Promise<Preview | undefined> {
    if (this.active >= 2) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active++;
    try {
      const asset = this.store.asset(id);
      if (!asset) return undefined;
      let preview: { mime: string; bytes: Buffer | null; width: number; height: number } = { mime: asset.mime, bytes: null, width: 0, height: 0 };
      if (/^image\/(?:png|jpeg|webp|gif|avif|heic|heif)$/.test(asset.mime)) {
        try {
          // Thumbnails use the first frame; the full-screen viewer preserves animated originals.
          const edge = variant === "display" ? 1920 : 960;
          const source = sharp(Buffer.from(asset.bytes), { limitInputPixels: 40_000_000, pages: 1, autoOrient: true });
          if (variant !== "display" || ((await source.metadata()).pages ?? 1) <= 1) {
            const result = await source.resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
              .webp({ quality: variant === "display" ? 84 : 76, effort: 3 }).timeout({ seconds: 5 }).toBuffer({ resolveWithObject: true });
            preview = { mime: "image/webp", bytes: result.data, width: result.info.width, height: result.info.height };
          }
        } catch { /* Unsupported or damaged media keeps its original download path. */ }
      }
      prepareSql(this.store.db, `INSERT OR REPLACE INTO ${table(variant)}(asset_id,mime,bytes,width,height) VALUES (?,?,?,?,?)`)
        .run(id, preview.mime, preview.bytes, preview.width, preview.height);
      return { mime: preview.mime, width: preview.width, height: preview.height, available: preview.bytes ? 1 : 0 };
    } finally {
      const next = this.waiting.shift();
      if (next) next(); else this.active--;
    }
  }
}
