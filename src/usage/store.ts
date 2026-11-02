import { prepareSql, closeSqlite } from "../sqlite.js";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { USD_REFERENCE } from "../models/currency.js";
import type { AgentConfig } from "../config.js";
import { priceImage, priceVideo } from "./media-pricing.js";
import { canonicalMediaModel, configuredUsageModels, type UsageModelIdentity } from "./media-identity.js";
import { priceTokens, priceFromCatalog, type PriceCatalog } from "./pricing.js";
import type { UsageObservation, UsageReport, UsageKind } from "./types.js";
import { accountedUsage, readUsageReport, usageDateKey, type UsagePeriod } from "./report.js";

export type BillingRow = { id: string; model: string; supplier: string; kind: UsageKind; generation_id: string; attempts: number };
/** Independent of session lifetimes: edits, branches and deletions cannot change a paid request. */
export class UsageStore {
  private readonly db: DatabaseSync;
  private catalog: PriceCatalog = new Map();
  private readonly configuredModels: UsageModelIdentity[];
  setPrices(catalog: PriceCatalog): void { this.catalog = catalog; this.backfillPrices(); }
  constructor(path: string, readonly agentId: string, config?: AgentConfig, readOnly = false) {
    this.configuredModels = config ? configuredUsageModels(config) : [];
    this.db = new DatabaseSync(path, { readOnly });
    this.db.exec(readOnly ? "PRAGMA busy_timeout = 250" : "PRAGMA busy_timeout = 5000");
    try {
      const owner = prepareSql(this.db, "SELECT agent_id FROM agent_metadata WHERE singleton=1").get() as { agent_id: string } | undefined;
      if (owner?.agent_id !== agentId) throw new Error("Usage database owner mismatch");
    } catch (error) { closeSqlite(this.db); throw error; }
    if (readOnly) return;
    this.db.exec(`CREATE TABLE IF NOT EXISTS model_usage (
      id TEXT PRIMARY KEY, model TEXT NOT NULL, supplier TEXT NOT NULL, kind TEXT NOT NULL,
      created_at INTEGER NOT NULL, time_known INTEGER NOT NULL DEFAULT 1, day TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      cached_tokens INTEGER NOT NULL, write_tokens INTEGER NOT NULL, output_seconds REAL NOT NULL,
      outcome TEXT NOT NULL, missing_usage INTEGER NOT NULL, estimated_tokens INTEGER NOT NULL,
      currency TEXT, amount_nano INTEGER, price_status TEXT NOT NULL, price_source TEXT,
      generation_id TEXT, next_check INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS model_usage_time ON model_usage(created_at,model,supplier);
      CREATE UNIQUE INDEX IF NOT EXISTS model_usage_generation ON model_usage(supplier,generation_id) WHERE generation_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS model_usage_pending ON model_usage(price_status,next_check);
      CREATE TABLE IF NOT EXISTS model_usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    if (!prepareSql(this.db, "PRAGMA table_info(model_usage)").all().some(row => row.name === "time_known")) {
      this.db.exec("ALTER TABLE model_usage ADD COLUMN time_known INTEGER NOT NULL DEFAULT 1");
    }
    const columns = new Set(prepareSql(this.db, "PRAGMA table_info(model_usage)").all().map(row => row.name));
    for (const [name, type] of [["api_model", "TEXT"], ["cost_multiplier", "REAL"], ["cache_reported", "INTEGER"],
      ["write_5m_tokens", "INTEGER"], ["write_1h_tokens", "INTEGER"], ["output_images", "INTEGER NOT NULL DEFAULT 0"],
      ["output_videos", "INTEGER NOT NULL DEFAULT 0"], ["historical", "INTEGER NOT NULL DEFAULT 0"], ["media_record_id", "TEXT"], ["media_usage", "TEXT"]]) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE model_usage ADD COLUMN ${name} ${type}`);
    }
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS model_usage_media_record ON model_usage(kind,supplier,media_record_id) WHERE media_record_id IS NOT NULL");
    // Atomic and idempotent: convert existing amounts once, without repricing token usage.
    prepareSql(this.db, "UPDATE model_usage SET amount_nano=ROUND(amount_nano / ?),currency='USD' WHERE currency='CNY'")
      .run(USD_REFERENCE.cnyPerUsd);
    this.discardUnusable();
    // Narrow catalogue scans and selected-model time ranges, without copying ledger bodies.
    this.db.exec(`CREATE INDEX IF NOT EXISTS model_usage_catalogue ON model_usage(model,supplier,kind) WHERE ${accountedUsage};
      CREATE INDEX IF NOT EXISTS model_usage_report ON model_usage(model,supplier,created_at) WHERE ${accountedUsage}`);
  }
  close(): void { closeSqlite(this.db); }
  private discardUnusable(): void {
    this.db.exec(`DELETE FROM model_usage WHERE NOT (${accountedUsage})`);
  }
  record(event: UsageObservation): void {
    const count = (n: number | undefined) => Number.isSafeInteger(n) && n! >= 0 ? n! : 0;
    const usage = event.estimatedTokens ? undefined : event.usage;
    const completeVideo = !!event.videoUsage && Number.isFinite(event.videoUsage.outputSeconds) && event.videoUsage.outputSeconds >= 0
      && typeof event.videoUsage.resolution === "string" && Number.isSafeInteger(event.videoUsage.inputImageCount) && event.videoUsage.inputImageCount >= 0;
    const missingUsage = event.kind === "video" ? !completeVideo
      : !usage || !event.usageComplete || event.kind === "image" && !event.imageUsage?.breakdownComplete;
    // A subscription has a known zero price even when its provider omits image tokens.
    // Preserve the request with missing_usage set; never estimate its token counts.
    if (!event.supplier.trim() || event.supplier === "unknown"
      || ((missingUsage || event.estimatedTokens) && event.cost?.type !== "subscription") || event.outcome === "rejected") return;
    const input = count(usage?.inputTokens), output = count(usage?.outputTokens);
    const cached = Math.min(input, count(usage?.cachedInputTokens));
    const model = event.kind === "image" || event.kind === "video"
      ? canonicalMediaModel(event.model,event.supplier,event.kind,this.configuredModels) : event.model;
    const proposedQuote = event.kind === "image" ? priceImage(model,event.supplier,event.cost,event.imageUsage)
      : event.kind === "video" ? priceVideo(model,event.supplier,event.cost,event.videoUsage)
      : priceTokens(model, event.cost, usage, event.createdAt)
        ?? (event.kind === "text" && event.supplier === "zenmux" && event.apiModel && usage && event.cost?.type === "official"
          ? priceFromCatalog(this.catalog, event.apiModel, usage, event.cost.multiplier) : undefined);
    const quote = proposedQuote && Number.isFinite(proposedQuote.amount) && proposedQuote.amount >= 0
      && Number.isSafeInteger(Math.round(proposedQuote.amount * 1e9))
      && (event.usageComplete || event.kind === "video" || proposedQuote.source === "free" || proposedQuote.source === "subscription") ? proposedQuote : undefined;
    const historical = event.kind === "historical" || event.historical || event.outcome === "historical";
    const fixed = quote?.source === "free" || quote?.source === "subscription";
    const status = fixed ? quote!.source : quote ? historical ? "historical-estimated" : "estimated" : historical ? "historical" : "unpriced";
    const amount = event.kind === "historical" ? undefined : quote?.amount;
    const mediaUsage = event.kind === "image" ? event.imageUsage : event.kind === "video" ? event.videoUsage : undefined;
    prepareSql(this.db, `INSERT OR IGNORE INTO model_usage
      (id,model,supplier,kind,created_at,time_known,day,input_tokens,output_tokens,cached_tokens,write_tokens,output_seconds,
        outcome,missing_usage,estimated_tokens,currency,amount_nano,price_status,price_source,generation_id,next_check,api_model,cost_multiplier,cache_reported,write_5m_tokens,write_1h_tokens,
        output_images,output_videos,historical,media_record_id,media_usage)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(event.id ?? randomUUID(), model, event.supplier,
      event.kind, event.createdAt, event.timeKnown === false ? 0 : 1, usageDateKey(event.createdAt), input, output, cached,
      usage?.cacheWriteTokens !== undefined ? count(usage.cacheWriteTokens) : count(usage?.cacheWriteTokens5m) + count(usage?.cacheWriteTokens1h),
      Math.max(0,Number.isFinite(event.outputSeconds) ? event.outputSeconds! : 0), event.outcome,
      missingUsage ? 1 : 0,
      event.estimatedTokens ? 1 : 0, amount !== undefined ? quote!.currency : null,
      amount !== undefined && Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 1e9) : null,
      status, quote?.source ?? null, event.generationId ?? null, event.createdAt + 5 * 60_000, event.apiModel ?? null,
      event.cost ? event.cost.type === "official" ? event.cost.multiplier ?? 1 : 0 : null,
      usage?.cacheHitTokensReported === undefined ? null : usage.cacheHitTokensReported ? 1 : 0,
      usage?.cacheWriteTokens5m ?? null, usage?.cacheWriteTokens1h ?? null,
      event.kind === "image" ? count(event.outputImages) : 0,event.kind === "video" ? count(event.outputVideos) : 0,
      historical ? 1 : 0,event.mediaRecordId ?? null,mediaUsage ? JSON.stringify(mediaUsage) : null);
  }
  /** Metadata and counters only. Historical combined turns cannot be reconstructed as exact calls. */
  importHistory(): void {
    if (prepareSql(this.db, "SELECT 1 FROM model_usage_meta WHERE key='history-v1'").get()) { this.importMediaHistory(); return; }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = prepareSql(this.db, `SELECT id,model_id,model_name,model_supplier,model_cost_multiplier,cache_hit_tokens_reported,input_tokens,output_tokens,cached_input_tokens,created_at
        FROM messages WHERE model_id IS NOT NULL AND input_tokens+output_tokens>0`).all();
      const importRow = (row: Record<string, unknown>, id: string, at: number, timeKnown = true) => this.record({ id,
        model: String(row.model_name ?? row.modelName ?? row.model_id ?? row.model),
        supplier: String(row.model_supplier ?? row.modelSupplier ?? "unknown"),
        apiModel: typeof row.model_id === "string" ? row.model_id : undefined,
        cost: typeof (row.model_cost_multiplier ?? row.modelCostMultiplier) === "number"
          ? { type: "official", multiplier: Number(row.model_cost_multiplier ?? row.modelCostMultiplier) } : undefined,
        kind: "historical", createdAt: at, timeKnown, outcome: "historical", usageComplete: !row.estimated, estimatedTokens: Boolean(row.estimated),
        usage: { inputTokens: Number(row.input_tokens ?? row.inputTokens ?? 0), outputTokens: Number(row.output_tokens ?? row.outputTokens ?? 0),
          cachedInputTokens: Number(row.cached_input_tokens ?? row.cachedInputTokens ?? 0),
          cacheHitTokensReported: (row.cache_hit_tokens_reported ?? row.cacheHitTokensReported) === undefined ? undefined
            : Boolean(row.cache_hit_tokens_reported ?? row.cacheHitTokensReported) } });
      for (const row of rows) importRow(row, `history:${row.id}`, Number(row.created_at));
      for (const row of prepareSql(this.db, `SELECT r.session_id,r.usage_json,s.created_at FROM session_rewinds r
        JOIN sessions s ON s.session_id=r.session_id`).all()) {
        const entries = JSON.parse(String(row.usage_json)) as Record<string, unknown>[];
        entries.forEach((entry, i) => { if (entry.model) importRow(entry, `rewind:${row.session_id}:${i}`, Number(row.created_at), false); });
      }
      prepareSql(this.db, "INSERT INTO model_usage_meta VALUES ('history-v1',?)").run(String(Date.now()));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.importMediaHistory(true);
  }
  /** Upgrade the first import in place. Post-ledger legacy records were already metered live. */
  private importMediaHistory(importAll = false): void {
    if (prepareSql(this.db, "SELECT 1 FROM model_usage_meta WHERE key='media-history-v2'").get()) return;
    const cutoff = Number(prepareSql(this.db, "SELECT value FROM model_usage_meta WHERE key='history-v1'").get()?.value ?? Date.now());
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // The old gateway enforced singleton outputs and recorded only API-completed generations.
      this.db.exec("UPDATE model_usage SET output_images=1 WHERE kind='image' AND outcome='completed' AND output_images=0; UPDATE model_usage SET output_videos=1 WHERE kind='video' AND outcome='completed' AND output_videos=0");
      const importMedia = (event: UsageObservation, legacyId: string) => {
        const old = prepareSql(this.db, "SELECT * FROM model_usage WHERE id=?").get(legacyId);
        const live = prepareSql(this.db, "SELECT * FROM model_usage WHERE id=? OR (kind=? AND supplier=? AND media_record_id=?) OR (supplier=? AND generation_id=?)")
          .get(`${event.kind}:${event.supplier}:${event.mediaRecordId}`,event.kind,event.supplier,event.mediaRecordId ?? null,event.supplier,event.generationId ?? null);
        if (live && old?.id !== live.id) {
          if (event.kind === "video") prepareSql(this.db, "UPDATE model_usage SET media_record_id=COALESCE(media_record_id,?),media_usage=COALESCE(media_usage,?) WHERE id=?")
            .run(event.mediaRecordId ?? null,event.videoUsage ? JSON.stringify(event.videoUsage) : null,live.id);
          if (old) {
            // Keep a proven invoice even when a previous version also imported the same task.
            if (old.amount_nano !== null && (live.amount_nano === null || old.price_status === "billed")) {
              prepareSql(this.db, "UPDATE model_usage SET amount_nano=?,currency=?,price_status=?,price_source=? WHERE id=?")
                .run(old.amount_nano,old.currency,old.price_status,old.price_source,live.id);
            }
            prepareSql(this.db, "DELETE FROM model_usage WHERE id=?").run(legacyId);
          }
          return;
        }
        if (!old && !importAll && event.createdAt >= cutoff) return;
        const id = old ? legacyId : event.id!;
        if (old) {
          const model = canonicalMediaModel(event.model,event.supplier,event.kind as "image"|"video",this.configuredModels);
          prepareSql(this.db, `UPDATE model_usage SET kind=?,model=?,outcome=?,historical=1,output_images=?,output_videos=?,output_seconds=?,
            media_record_id=?,media_usage=?,api_model=?,cost_multiplier=?,missing_usage=?,estimated_tokens=? WHERE id=?`)
            .run(event.kind,model,event.outcome,event.outputImages ?? 0,event.outputVideos ?? 0,event.outputSeconds ?? 0,event.mediaRecordId ?? null,
              JSON.stringify(event.imageUsage ?? event.videoUsage ?? null),event.apiModel ?? null,event.cost?.type === "official" ? event.cost.multiplier ?? 1 : null,
              (event.kind === "image" ? !event.usageComplete || event.estimatedTokens || !event.imageUsage?.breakdownComplete : !event.videoUsage) ? 1 : 0,event.estimatedTokens ? 1 : 0,id);
          // Failed historical records contain fallback guesses, never measured consumption.
          if (event.estimatedTokens) prepareSql(this.db, "UPDATE model_usage SET input_tokens=0,output_tokens=0,cached_tokens=0,write_tokens=0 WHERE id=?").run(id);
          if (event.outcome === "rejected") prepareSql(this.db, "UPDATE model_usage SET price_status='excluded',missing_usage=0 WHERE id=? AND amount_nano IS NULL").run(id);
        } else this.record(event);
      };
      for (const row of prepareSql(this.db, `SELECT generation_id,model_id,model_supplier,model_cost_multiplier,input_tokens,input_text_tokens,input_image_tokens,
        cached_input_tokens,output_tokens,output_text_tokens,output_image_tokens,estimated,status,billing_details_json,created_at FROM image_generations`).all()) {
        const failed = row.status === "failed", estimated = Boolean(row.estimated) || failed;
        const imageUsage = { model:String(row.model_id), inputTokens:Number(row.input_tokens),inputTextTokens:Number(row.input_text_tokens),inputImageTokens:Number(row.input_image_tokens),
          cachedInputTokens:Number(row.cached_input_tokens),outputTokens:Number(row.output_tokens),outputTextTokens:Number(row.output_text_tokens),outputImageTokens:Number(row.output_image_tokens),
          estimated,cacheBilling:"none" as const,breakdownComplete:false,
          ...(row.billing_details_json ? JSON.parse(String(row.billing_details_json)) : {}) };
        importMedia({id:`history-image:${row.generation_id}`,mediaRecordId:String(row.generation_id),model:String(row.model_id),apiModel:String(row.model_id),supplier:String(row.model_supplier ?? "unknown"),
          cost:typeof row.model_cost_multiplier === "number" ? {type:"official",multiplier:row.model_cost_multiplier} : undefined,
          kind:"image",createdAt:Number(row.created_at),outcome:failed ? "failed" : "historical",historical:true,outputImages:failed ? 0 : 1,
          usage:imageUsage,imageUsage,usageComplete:!estimated,estimatedTokens:estimated},`history-image:${row.generation_id}`);
      }
      for (const row of prepareSql(this.db, "SELECT generation_id,record_json,created_at FROM video_generations").all()) {
        let video; try { video=JSON.parse(String(row.record_json)); } catch { continue; }
        if (!video || typeof video.model !== "string") continue;
        const secondsKnown = typeof video.outputSeconds === "number" && Number.isFinite(video.outputSeconds) && video.outputSeconds >= 0;
        const outputSeconds = secondsKnown ? video.outputSeconds : 0;
        const usageComplete=secondsKnown && typeof video.resolution === "string" && Number.isSafeInteger(video.inputImageCount) && video.inputImageCount >= 0;
        const supplier=String(video.modelSupplier ?? "unknown");
        importMedia({id:`history-video:${row.generation_id}`,mediaRecordId:String(row.generation_id),model:video.model,apiModel:video.model,supplier,
          generationId:supplier === "zenmux" ? String(row.generation_id) : undefined,
          cost:typeof video.modelCostMultiplier === "number" ? {type:"official",multiplier:video.modelCostMultiplier} : undefined,
          kind:"video",createdAt:Number(row.created_at),outcome:"historical",historical:true,outputVideos:1,outputSeconds,
          videoUsage:usageComplete ? {outputSeconds,resolution:video.resolution,inputImageCount:video.inputImageCount} : undefined},`history-video:${row.generation_id}`);
      }
      for (const row of prepareSql(this.db, "SELECT id,model,supplier,kind FROM model_usage WHERE kind IN ('image','video')").all()) {
        const model=canonicalMediaModel(String(row.model),String(row.supplier),row.kind as "image"|"video",this.configuredModels);
        prepareSql(this.db, "UPDATE model_usage SET model=? WHERE id=?").run(model,row.id);
      }
      // Correct the one superseded algorithm which omitted H3 Max reference-image fees.
      // Real supplier invoices and all other frozen quotes remain untouched.
      for (const row of prepareSql(this.db, "SELECT * FROM model_usage WHERE kind='video' AND price_source='video-tariff' AND price_status='estimated' AND media_usage IS NOT NULL").all()) {
        let media; try { media=JSON.parse(String(row.media_usage)); } catch { continue; }
        const quote=priceVideo(String(row.model),String(row.supplier),{type:"official",multiplier:Number(row.cost_multiplier ?? 1)},media);
        if (quote && Number.isFinite(quote.amount) && quote.amount >= 0 && Number.isSafeInteger(Math.round(quote.amount*1e9))) {
          prepareSql(this.db, "UPDATE model_usage SET amount_nano=?,currency=?,price_source=? WHERE id=?")
            .run(Math.round(quote.amount*1e9),quote.currency,quote.source,row.id);
        }
      }
      prepareSql(this.db, "INSERT INTO model_usage_meta VALUES ('media-history-v2',?)").run(String(Date.now()));
      this.discardUnusable();
      this.db.exec("COMMIT");
    } catch(error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /** Reprice only previously unpriced, identified rows. Existing quotes and invoices are immutable. */
  backfillPrices(): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.discardUnusable();
      if (!prepareSql(this.db, "SELECT 1 FROM model_usage_meta WHERE key='pricing-metadata-v2'").get()) {
        this.db.exec(`UPDATE model_usage SET
          api_model=(SELECT model_id FROM messages m WHERE m.id=substr(model_usage.id,9)),
          cost_multiplier=(SELECT model_cost_multiplier FROM messages m WHERE m.id=substr(model_usage.id,9)),
          cache_reported=(SELECT cache_hit_tokens_reported FROM messages m WHERE m.id=substr(model_usage.id,9))
          WHERE kind='historical' AND id LIKE 'history:%' AND api_model IS NULL AND EXISTS(SELECT 1 FROM messages m WHERE m.id=substr(model_usage.id,9))`);
        for (const row of prepareSql(this.db, "SELECT session_id,usage_json FROM session_rewinds").all()) {
          const entries = JSON.parse(String(row.usage_json)) as Array<{modelCostMultiplier?: number; cacheHitTokensReported?: boolean}>;
          entries.forEach((entry,index) => prepareSql(this.db, `UPDATE model_usage SET cost_multiplier=?,cache_reported=?
            WHERE id=? AND cost_multiplier IS NULL`).run(entry.modelCostMultiplier ?? null,
              entry.cacheHitTokensReported === undefined ? null : entry.cacheHitTokensReported ? 1 : 0, `rewind:${row.session_id}:${index}`));
        }
        prepareSql(this.db, "INSERT INTO model_usage_meta VALUES ('pricing-metadata-v2',?)").run(String(Date.now()));
      }
      let changed = 0;
      for (const row of prepareSql(this.db, "SELECT * FROM model_usage WHERE kind IN ('image','video') AND supplier<>'unknown' AND amount_nano IS NULL AND price_status<>'excluded'").all()) {
        let media; try { media=JSON.parse(String(row.media_usage)); } catch { continue; }
        const policy = Number(row.cost_multiplier ?? 1) === 0 ? {type:"free" as const} : {type:"official" as const,multiplier:Number(row.cost_multiplier ?? 1)};
        const quote = row.kind === "image" ? row.estimated_tokens || row.missing_usage ? undefined : priceImage(String(row.model),String(row.supplier),policy,media)
          : priceVideo(String(row.model),String(row.supplier),policy,media);
        if (!quote || !Number.isFinite(quote.amount) || quote.amount < 0 || !Number.isSafeInteger(Math.round(quote.amount*1e9))) continue;
        changed += Number(prepareSql(this.db, "UPDATE model_usage SET amount_nano=?,currency=?,price_status=?,price_source=? WHERE id=? AND amount_nano IS NULL")
          .run(Math.round(quote.amount*1e9),quote.currency,policy.type === "free" ? "free" : row.historical ? "historical-estimated" : "estimated",quote.source,row.id).changes);
      }
      const rows = prepareSql(this.db, `SELECT u.*,
        COALESCE((SELECT input_tokens FROM messages prompt WHERE prompt.session_id=m.session_id AND prompt.turn_id=m.turn_id
          AND prompt.role='user'),u.input_tokens) context_input_tokens
        FROM model_usage u LEFT JOIN messages m ON u.id LIKE 'history:%' AND m.id=substr(u.id,9)
        WHERE u.amount_nano IS NULL AND u.supplier<>'unknown' AND u.price_status<>'excluded'
          AND u.missing_usage=0 AND u.estimated_tokens=0 AND u.kind IN ('text','historical')`).all();
      for (const row of rows) {
        const historical = row.kind === "historical";
        const policy = Number(row.cost_multiplier ?? 1) === 0 ? {type:"free" as const}
          : {type:"official" as const, multiplier:Number(row.cost_multiplier ?? 1)};
        const usage = {inputTokens:Number(row.input_tokens), outputTokens:Number(row.output_tokens), cachedInputTokens:Number(row.cached_tokens),
          cacheWriteTokens5m:Number(row.write_5m_tokens ?? row.write_tokens), cacheWriteTokens1h:Number(row.write_1h_tokens ?? 0),
          cacheHitTokensReported:row.cache_reported === null ? undefined : Boolean(row.cache_reported)};
        const quote = priceTokens(String(row.model),policy,usage,Number(row.created_at),
          {historical,contextInputTokens:Number(row.context_input_tokens)})
          ?? (row.supplier === "zenmux" && row.api_model ? priceFromCatalog(this.catalog,String(row.api_model),historical ? {...usage,cacheHitTokensReported:undefined} : usage,policy.type === "official" ? policy.multiplier : 0) : undefined);
        if (!quote || !Number.isFinite(quote.amount) || quote.amount < 0 || !Number.isSafeInteger(Math.round(quote.amount*1e9))) continue;
        const status = policy.type === "free" ? "free" : historical ? "historical-estimated" : "estimated";
        changed += Number(prepareSql(this.db, `UPDATE model_usage SET amount_nano=?,currency=?,price_status=?,price_source=?
          WHERE id=? AND amount_nano IS NULL`).run(Math.round(quote.amount*1e9),quote.currency,status,quote.source,row.id).changes);
      }
      this.db.exec("COMMIT"); return changed;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  pending(now = Date.now()): BillingRow[] {
    return prepareSql(this.db, `SELECT id,model,supplier,kind,generation_id,attempts FROM model_usage
      WHERE ${accountedUsage} AND supplier='zenmux' AND generation_id IS NOT NULL AND price_status IN ('estimated','unpriced','historical-estimated','historical') AND next_check<=?
      ORDER BY next_check LIMIT 40`).all(now) as unknown as BillingRow[];
  }
  defer(id: string, attempts: number, now = Date.now()): void {
    prepareSql(this.db, "UPDATE model_usage SET attempts=attempts+1,next_check=? WHERE id=?")
      .run(now + Math.min(24 * 60, 2 ** Math.min(attempts, 10)) * 60_000, id);
  }
  settle(id: string, amountUsd: number): void {
    if (!Number.isFinite(amountUsd) || amountUsd < 0 || !Number.isSafeInteger(Math.round(amountUsd * 1e9))) return;
    prepareSql(this.db, `UPDATE model_usage SET currency='USD',amount_nano=?,price_status='billed',price_source='zenmux-generation' WHERE id=?`)
      .run(Math.round(amountUsd * 1e9), id);
  }
  report(period: UsagePeriod, selected?: string, now = Date.now(), _catalog: AgentConfig["models"] | AgentConfig = [], chartInterval: "day" | "hour" = "day"): UsageReport {
    return readUsageReport(this.db, period, selected ? { key: selected } : undefined, now, chartInterval);
  }
  reportForModel(period: UsagePeriod, model: string, now = Date.now(), chartInterval: "day" | "hour" = "day"): UsageReport {
    return readUsageReport(this.db, period, model ? { model } : undefined, now, chartInterval);
  }
}
