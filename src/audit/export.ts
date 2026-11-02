import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type AuditExportOptions = {
  database: string;
  output: string;
  minutes?: number;
  /** @deprecated Use minutes for new callers. */
  hours?: number;
  agent: string;
  /** Exact persisted session ID, or latest. Exports the complete session. */
  sessionId?: string;
  webDatabase?: string;
};

type Row = Record<string, unknown>;

const SENSITIVE_KEY = /(authorization|cookie|password|secret|token|api.?key)/i;

function cliOptions(argv: readonly string[]): AuditExportOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${key ?? "end"}`);
    if (!["database", "output", "minutes", "hours", "agent", "web-database", "session-id"].includes(key.slice(2))) {
      throw new Error(`Unknown audit argument ${key}`);
    }
    values.set(key.slice(2), value);
  }
  const database = values.get("database");
  const output = values.get("output");
  const minutesArgument = values.get("minutes");
  const hoursArgument = values.get("hours");
  if (minutesArgument !== undefined && hoursArgument !== undefined) {
    throw new Error("Use either --minutes or --hours, not both");
  }
  const minutes = minutesArgument !== undefined
    ? Number(minutesArgument)
    : hoursArgument !== undefined
      ? Number(hoursArgument) * 60
      : 10;
  const agent = values.get("agent") ?? "unknown";
  if (!database || !output || !Number.isInteger(minutes) || minutes < 10 || minutes > 43_200) {
    throw new Error("Usage: audit-export --database <sqlite> --output <dir> [--web-database <sqlite>] [--minutes 10..43200] [--session-id <id|latest>] [--agent id]");
  }
  return {
    database: resolve(database),
    output: resolve(output),
    minutes,
    sessionId: values.get("session-id") || undefined,
    agent,
    webDatabase: values.get("web-database") ? resolve(values.get("web-database")!) : undefined
  };
}

function pseudonym(value: unknown, salt: Buffer): string {
  return createHash("sha256").update(salt).update(String(value ?? "")).digest("hex").slice(0, 12);
}

function redactText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_KEY]")
    .replace(/\b(jwt|token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

function sanitize(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return sanitize(JSON.parse(value));
    } catch {
      return redactText(value);
    }
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Row).map(([key, entry]) => [
    key,
    SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitize(entry)
  ]));
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || !value) return undefined;
  try {
    return sanitize(JSON.parse(value));
  } catch {
    return redactText(value);
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function jsonBlock(value: unknown): string {
  if (value === undefined) return "";
  return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

function tableColumns(database: DatabaseSync, table: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Row[];
  return new Set(rows.map((row) => String(row.name)));
}

type WebAssetRef = {
  sessionId: string;
  turnId: number;
  kind: "input" | "output";
  ordinal: number;
  imageKey: string;
  sha256?: string;
};

function extensionFor(contentType: string): string {
  const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  return ".png";
}

async function exportAssets(
  refs: readonly WebAssetRef[],
  outputRoot: string,
  aliases: ReadonlyMap<string, string>,
  webDatabase: string
): Promise<Row[]> {
  if (refs.length === 0) return [];
  let assets: DatabaseSync;
  try {
    assets = new DatabaseSync(webDatabase, { readOnly: true });
  } catch {
    throw new Error("Audit asset database is unavailable");
  }
  assets.exec("PRAGMA query_only=ON");
  try {
    const exported: Row[] = [];
    for (const ref of refs) {
      const metadata = {
        session: aliases.get(ref.sessionId), turnId: ref.turnId, kind: ref.kind, ordinal: ref.ordinal
      };
      const asset = assets.prepare("SELECT mime,bytes FROM assets WHERE id=?").get(ref.imageKey) as
        { mime: string; bytes: Uint8Array } | undefined;
      if (!asset) {
        exported.push({ ...metadata, available: false, error: "Original image is unavailable" });
        continue;
      }
      const data = Buffer.from(asset.bytes);
      const sha256 = createHash("sha256").update(data).digest("hex");
      if (ref.sha256 && ref.sha256 !== sha256) {
        exported.push({ ...metadata, available: false, error: "Original image hash does not match its record" });
        continue;
      }
      const relativeDirectory = join("assets", aliases.get(ref.sessionId)!, String(ref.turnId));
      const filename = `${ref.kind}-${ref.ordinal}-${sha256}${extensionFor(asset.mime)}`;
      const relativePath = join(relativeDirectory, filename).replaceAll("\\", "/");
      await mkdir(join(outputRoot, relativeDirectory), { recursive: true });
      await writeFile(join(outputRoot, relativePath), data, { mode: 0o600 });
      exported.push({ ...metadata, available: true, path: relativePath, sha256 });
    }
    return exported;
  } finally {
    assets.close();
  }
}

function renderHtml(report: Row): string {
  const sessions = report.sessions as Row[];
  const messages = report.messages as Row[];
  const generations = report.imageGenerations as Row[];
  const messageImages = report.messageImages as Row[];
  const assets = report.assets as Row[];
  const sections = sessions.map((session) => {
    const sessionId = String(session.session);
    const sessionMessages = messages.filter((message) => message.session === sessionId);
    const turns = [...new Set(sessionMessages.map((message) => Number(message.turnId)))].sort((a, b) => a - b);
    const turnHtml = turns.map((turnId) => {
      const turnMessages = sessionMessages.filter((message) => Number(message.turnId) === turnId);
      const turnGenerations = generations.filter((item) => item.session === sessionId && Number(item.turnId) === turnId);
      const turnMessageImages = messageImages.filter((item) => item.session === sessionId && Number(item.turnId) === turnId);
      const turnAssets = assets.filter((item) => item.session === sessionId && Number(item.turnId) === turnId);
      return `<article><h3>Turn ${turnId}</h3>${turnMessages.map((message) => `
        <div class="message ${escapeHtml(message.role)}"><strong>${escapeHtml(message.role)}${message.speaker ? ` · ${escapeHtml(message.speaker)}` : ""}${message.deletedAt ? ` · 已软删除 ${escapeHtml(message.deletedAt)}（编辑起点：${escapeHtml(message.rewindFromTurn)}）` : ""}</strong><p>${escapeHtml(message.content)}</p>
        ${message.questionAnswers ? `<details><summary>User question answers</summary>${jsonBlock(message.questionAnswers)}</details>` : ""}
        ${message.toolTrace ? `<details><summary>Tool trace</summary>${jsonBlock(message.toolTrace)}</details>` : ""}
        ${message.activityTrace ? `<details open><summary>User-visible thoughts and activity</summary>${jsonBlock(message.activityTrace)}</details>` : ""}</div>`).join("")}
        ${turnGenerations.length ? `<details open><summary>Image generation records</summary>${jsonBlock(turnGenerations)}</details>` : ""}
        ${turnMessageImages.length ? `<details><summary>Conversation image memory</summary>${jsonBlock(turnMessageImages)}</details>` : ""}
        <div class="gallery">${turnAssets.map((asset) => asset.available
          ? `<figure><img src="${escapeHtml(asset.path)}"><figcaption>${escapeHtml(asset.kind)} · ${escapeHtml(asset.path)}</figcaption></figure>`
          : `<figure><figcaption>${escapeHtml(asset.kind)} image unavailable: ${escapeHtml(asset.error)}</figcaption></figure>`).join("")}</div></article>`;
    }).join("");
    return `<section><h2>Session ${escapeHtml(sessionId)}</h2><p>${escapeHtml(session.user)} · ${escapeHtml(session.conversation)} · ${escapeHtml(session.status)} · ${escapeHtml(session.createdAt)} — ${escapeHtml(session.lastActiveAt)}</p>${turnHtml}</section>`;
  }).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Zigent audit export</title><style>
  body{font:15px/1.55 system-ui,sans-serif;max-width:1200px;margin:auto;padding:32px;background:#f5f5f2;color:#20201e}h1,h2,h3{line-height:1.2}section,article,.message,details{background:white;border:1px solid #ddd;border-radius:10px;padding:14px;margin:14px 0}.user{border-left:5px solid #4d78cc}.assistant{border-left:5px solid #6b9b65}pre{white-space:pre-wrap;word-break:break-word;background:#f4f4f4;padding:12px;border-radius:6px}.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.gallery img{width:100%;height:auto;border-radius:8px}figcaption{font-size:12px;word-break:break-all}</style></head><body>
  <h1>Zigent audit export</h1><p>Agent: ${escapeHtml(report.agent)} · Window: ${escapeHtml(report.from)} — ${escapeHtml(report.to)}</p>${sections}</body></html>`;
}

export async function exportAudit(options: AuditExportOptions): Promise<void> {
  const minutes = options.minutes ?? (options.hours === undefined ? 10 : options.hours * 60);
  if (!Number.isInteger(minutes) || minutes < 10 || minutes > 43_200) {
    throw new Error("Audit lookback must be an integer from 10 to 43200 minutes");
  }
  const exportedAt = Date.now();
  const cutoff = exportedAt - minutes * 60_000;
  const database = new DatabaseSync(options.database, { readOnly: true });
  database.exec("PRAGMA query_only = ON; BEGIN");
  try {
    const owner = tableColumns(database, "agent_metadata").size
      ? database.prepare("SELECT agent_id FROM agent_metadata WHERE singleton=1").get() as Row | undefined : undefined;
    if (owner && options.agent !== "unknown" && owner.agent_id !== options.agent) throw new Error("Audit Agent does not match database");
    const selectedSession = options.sessionId === "latest"
      ? database.prepare("SELECT session_id FROM sessions ORDER BY last_active_at DESC, created_at DESC, session_id LIMIT 1").get()?.session_id as string | undefined
      : options.sessionId;
    if (options.sessionId && (!selectedSession || !database.prepare("SELECT 1 FROM sessions WHERE session_id=?").get(selectedSession))) {
      throw new Error("Audit session was not found");
    }
    const scope = (alias = "") => selectedSession ? `${alias}session_id = ?` : `${alias}created_at >= ?`;
    const scopeValue = selectedSession ?? cutoff;
    const messageColumns = tableColumns(database, "messages");
    const deletedSelect = messageColumns.has("deleted_at") ? "deleted_at" : "NULL AS deleted_at";
    const rewindSelect = messageColumns.has("rewind_from_turn") ? "rewind_from_turn" : "NULL AS rewind_from_turn";
    const answersSelect = messageColumns.has("question_answers_json") ? "question_answers_json" : "NULL AS question_answers_json";
    const activitySelect = messageColumns.has("activity_trace_json") ? "activity_trace_json" : "NULL AS activity_trace_json";
    const inputRefsSelect = messageColumns.has("input_image_refs_json") ? "input_image_refs_json" : "NULL AS input_image_refs_json";
    const senderSelect = messageColumns.has("sender_user_id") ? "sender_user_id" : "NULL AS sender_user_id";
    const rawMessages = database.prepare(`SELECT id, message_id, session_id, turn_id, role, content, model_id, model_name,
      model_brand, model_supplier, tool_trace_json, ${activitySelect}, ${inputRefsSelect}, ${senderSelect}, ${deletedSelect}, ${rewindSelect}, ${answersSelect}, created_at
      FROM messages WHERE ${scope()} AND role IN ('user', 'assistant', 'compressor') ORDER BY turn_id, created_at`).all(scopeValue) as Row[];
    const imageColumns = tableColumns(database, "image_generations");
    const messageImageColumns = tableColumns(database, "message_images");
    const hasGenerationLink = messageImageColumns.has("generation_id");
    const generationJoin = hasGenerationLink ? "LEFT JOIN message_images mi ON mi.generation_id = g.generation_id" : "";
    const messageIdSelect = hasGenerationLink ? "mi.source_message_id AS source_message_id" : "NULL AS source_message_id";
    const imageKeySelect = hasGenerationLink ? "mi.source_image_key AS source_image_key" : "NULL AS source_image_key";
    const inputFidelitySelect = imageColumns.has("input_fidelity") ? "g.input_fidelity" : "NULL AS input_fidelity";
    const rawGenerations = database.prepare(`SELECT g.generation_id, g.session_id, g.turn_id, g.experiment_id, g.variant, g.ordinal,
      g.input_prompt, g.revised_prompt, g.size, g.quality, ${inputFidelitySelect}, g.status, g.error, g.image_sha256,
      g.model_id, g.model_supplier, g.input_tokens, g.output_tokens, ${messageIdSelect}, ${imageKeySelect}, g.created_at
      FROM image_generations g ${generationJoin} WHERE ${scope("g.")} ORDER BY g.created_at, g.ordinal`).all(scopeValue) as Row[];
    const messageImageGenerationSelect = hasGenerationLink ? "mi.generation_id" : "NULL AS generation_id";
    const imageDeletedSelect = messageColumns.has("deleted_at") ? "m.deleted_at" : "NULL AS deleted_at";
    const rawMessageImages = messageImageColumns.size > 0
      ? database.prepare(`SELECT mi.image_id, ${messageImageGenerationSelect}, mi.session_id, mi.turn_id, mi.ordinal, m.role,
          mi.source_message_id, mi.source_image_key, mi.description, mi.description_model,
          mi.hot_through_completion, mi.sha256, ${imageDeletedSelect}, mi.created_at
          FROM message_images mi JOIN messages m ON m.id = mi.message_id
          WHERE ${scope("mi.")} ORDER BY mi.created_at, mi.ordinal`).all(scopeValue) as Row[]
      : [];
    const sessionIds = selectedSession ? [selectedSession] : [...new Set([...rawMessages, ...rawGenerations, ...rawMessageImages].map((row) => String(row.session_id)))];
    const sessionColumns = tableColumns(database, "sessions");
    const chatTypeSelect = sessionColumns.has("chat_type") ? "chat_type" : "NULL AS chat_type";
    const rawSessions = sessionIds.length === 0 ? [] : database.prepare(`SELECT session_id, user_id, chat_id, ${chatTypeSelect}, status, created_at, last_active_at,
      feedback_rating FROM sessions WHERE session_id IN (${sessionIds.map(() => "?").join(",")}) ORDER BY last_active_at DESC`).all(...sessionIds) as Row[];
    const feedbackColumns = tableColumns(database, "session_feedback");
    const rawFeedback = sessionIds.length === 0 || feedbackColumns.size === 0 ? [] : database.prepare(`SELECT session_id, user_id, rating
      FROM session_feedback WHERE session_id IN (${sessionIds.map(() => "?").join(",")}) ORDER BY session_id, updated_at`).all(...sessionIds) as Row[];
    const salt = randomBytes(32);
    const aliases = new Map(sessionIds.map((id) => [id, `s-${pseudonym(id, salt)}`]));
    await mkdir(options.output, { recursive: true });
    const assetRefs = rawMessageImages.flatMap((row): WebAssetRef[] => typeof row.source_image_key === "string"
      ? [{
          sessionId: String(row.session_id), turnId: Number(row.turn_id),
          kind: row.role === "assistant" ? "output" : "input", ordinal: Number(row.ordinal),
          imageKey: row.source_image_key, sha256: typeof row.sha256 === "string" ? row.sha256 : undefined
        }]
      : []);
    const assets = await exportAssets(
      assetRefs, options.output, aliases, options.webDatabase ?? join(dirname(options.database), "web.sqlite")
    );
    const sessions = rawSessions.map((row) => ({
      session: aliases.get(String(row.session_id)), user: `u-${pseudonym(row.user_id, salt)}`,
      conversation: `c-${pseudonym(row.chat_id, salt)}`, chatType: row.chat_type, status: row.status,
      feedback: rawFeedback.filter((feedback) => feedback.session_id === row.session_id).map((feedback) => ({
        user: `u-${pseudonym(feedback.user_id, salt)}`, rating: feedback.rating
      })),
      createdAt: new Date(Number(row.created_at)).toISOString(), lastActiveAt: new Date(Number(row.last_active_at)).toISOString()
    }));
    const messages = rawMessages.map((row) => ({
      message: pseudonym(row.id, salt), sourceMessage: row.message_id ? pseudonym(row.message_id, salt) : undefined,
      session: aliases.get(String(row.session_id)), turnId: row.turn_id, role: row.role, content: row.content,
      deletedAt: row.deleted_at == null ? null : new Date(Number(row.deleted_at)).toISOString(),
      rewindFromTurn: row.rewind_from_turn, questionAnswers: parseJson(row.question_answers_json),
      speaker: row.sender_user_id ? `u-${pseudonym(row.sender_user_id, salt)}` : undefined,
      model: row.model_id, modelName: row.model_name, modelBrand: row.model_brand, modelSupplier: row.model_supplier,
      toolTrace: parseJson(row.tool_trace_json), activityTrace: parseJson(row.activity_trace_json),
      inputImageCount: assetRefs.filter((ref) => ref.kind === "input" && ref.sessionId === row.session_id && ref.turnId === Number(row.turn_id)).length,
      createdAt: new Date(Number(row.created_at)).toISOString()
    }));
    const imageGenerations = rawGenerations.map((row) => ({
      generationId: row.generation_id, session: aliases.get(String(row.session_id)), turnId: row.turn_id,
      experimentId: row.experiment_id, variant: row.variant, ordinal: row.ordinal,
      inputPrompt: row.input_prompt, revisedPrompt: row.revised_prompt,
      size: row.size, quality: row.quality, inputFidelity: row.input_fidelity,
      status: row.status, error: redactText(String(row.error ?? "")),
      imageSha256: row.image_sha256, model: row.model_id, supplier: row.model_supplier,
      assetAvailable: typeof row.source_image_key === "string",
      inputTokens: row.input_tokens, outputTokens: row.output_tokens, createdAt: new Date(Number(row.created_at)).toISOString()
    }));
    const messageImages = rawMessageImages.map((row) => ({
      imageId: row.image_id, generationId: row.generation_id,
      session: aliases.get(String(row.session_id)), turnId: row.turn_id,
      ordinal: row.ordinal, origin: row.role, description: row.description,
      deletedAt: row.deleted_at == null ? null : new Date(Number(row.deleted_at)).toISOString(),
      descriptionModel: row.description_model, hotThroughCompletion: row.hot_through_completion,
      sha256: row.sha256, createdAt: new Date(Number(row.created_at)).toISOString()
    }));
    const report: Row = {
      schemaVersion: 4, agent: options.agent, scope: selectedSession ? { type: "session", session: aliases.get(selectedSession) } : { type: "window" },
      from: new Date(selectedSession ? [...rawSessions, ...rawMessages, ...rawGenerations, ...rawMessageImages].reduce((earliest, row) => Math.min(earliest, Number(row.created_at)), exportedAt) : cutoff).toISOString(), to: new Date(exportedAt).toISOString(),
      note: "Thoughts contain only provider-exposed text already shown to the user; hidden provider state is never exported.",
      sessions, messages, messageImages, imageGenerations, assets
    };
    await writeFile(join(options.output, "audit.json"), JSON.stringify(report, null, 2), { encoding: "utf8", mode: 0o600 });
    await writeFile(join(options.output, "index.html"), renderHtml(report), { encoding: "utf8", mode: 0o600 });
  } finally {
    database.close();
  }
}

if (process.argv[1] && /audit[\\/]export\.(?:js|ts)$/.test(process.argv[1])) {
  exportAudit(cliOptions(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
