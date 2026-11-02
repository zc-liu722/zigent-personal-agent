import { projectHistoryParts } from "./history-parts.js";
import { prepareSql } from "../sqlite.js";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { createHash } from "node:crypto";
import { initializeHistorySearch, prepareHistorySearch, historyMatchExpression, historySearchIndex, historySearchNeedles, historySearchTerms } from "./history-search.js";

const page = { limit: z.number().int().min(1).max(20).default(10), offset: z.number().int().min(0).max(1_000_000).default(0) };
const dates = { from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() };
const sessionId = z.string().min(1).max(200);
const filters = {
  role: z.enum(["all", "user", "assistant"]).default("all"),
  turn_id: z.number().int().min(1).optional(),
  parts: z.array(z.enum(["content", "thoughts", "tools", "commentary"])).min(1).max(4)
    .refine(parts => new Set(parts).size === parts.length, "parts must be unique").default(["content"])
};
export const conversationHistorySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), ...page, ...dates }).strict(),
  z.object({ action: z.literal("search"), query: z.string().trim().min(1).max(200),
    match: z.enum(["phrase", "all", "any"]).default("phrase"), sort: z.enum(["relevance", "recent"]).default("relevance"),
    scan_cursor: z.string().min(1).max(2000).optional(),
    session_id: sessionId.optional(), ...filters, ...page, ...dates }).strict(),
  z.object({ action: z.literal("read"), session_id: sessionId, message_id: sessionId.optional(),
    scope: z.enum(["message", "turn"]).default("message"), part_id: sessionId.optional(),
    expected_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    content_offset: z.number().int().min(0).max(10_000_000).default(0), ...filters, ...page }).strict()
]).superRefine((value, context) => {
  const invalid = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  if (value.action !== "read" && value.from && value.to && Date.parse(value.from) > Date.parse(value.to)) {
    invalid("from must not be later than to");
  }
  if (value.action !== "list" && value.turn_id && !value.session_id) invalid("turn_id requires session_id");
  if (value.action === "search" && value.offset > 0 && !value.scan_cursor) invalid("search offset requires the returned scan_cursor");
  if (value.action === "read") {
    if (value.expected_hash && (!value.message_id || !value.part_id || value.scope !== "message")) invalid("expected_hash requires message_id and part_id with message scope");
    if (value.message_id && value.turn_id) invalid("use message_id or turn_id, not both");
    if (value.scope === "turn" && !value.message_id && !value.turn_id) invalid("turn scope requires message_id or turn_id");
    if ((value.content_offset || value.part_id) && (!value.message_id || value.scope === "turn")) {
      invalid("part_id/content_offset requires a single message_id with message scope");
    }
    if (value.content_offset && !value.part_id && (value.parts.length !== 1 || value.parts[0] !== "content")) {
      invalid("continuing activity requires part_id");
    }
  }
});

export type ConversationHistoryRequest = z.infer<typeof conversationHistorySchema>;
export type ConversationHistoryScope = {
  agentId: string; userId: string; sessionId: string; conversationId?: string; conversationKind?: "p2p" | "group";
  taskRunId?: string; backgroundTaskKind?: string;
};

const scanCursorSchema = z.object({ version: z.literal(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  cutoffAt: z.number().int().nonnegative(), cutoffId: sessionId,
  candidateFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  before: z.object({ at: z.number().int().nonnegative(), id: sessionId }).strict().optional() }).strict();
type ScanCursor = z.infer<typeof scanCursorSchema>;
const encodeScanCursor = (cursor: ScanCursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");
function decodeScanCursor(value: string, fingerprint: string): ScanCursor {
  try {
    const cursor = scanCursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (cursor.fingerprint !== fingerprint) throw new Error();
    if (cursor.before && (cursor.before.at > cursor.cutoffAt
      || cursor.before.at === cursor.cutoffAt && cursor.before.id > cursor.cutoffId)) throw new Error();
    return cursor;
  } catch { throw new Error("Search cursor is invalid or filters changed; start a new search without scan_cursor"); }
}

const speakerLabel = `CASE WHEN s.chat_type='group' AND m.role='user' THEN
  CASE WHEN m.sender_user_id IS NULL THEN '群成员（历史身份未知）' ELSE '群成员 ' || (
    SELECT count(DISTINCT p.sender_user_id) FROM messages p WHERE p.deleted_at IS NULL AND p.session_id=m.session_id AND p.role='user'
    AND p.turn_id<=(SELECT min(f.turn_id) FROM messages f WHERE f.deleted_at IS NULL AND f.session_id=m.session_id
      AND f.role='user' AND f.sender_user_id=m.sender_user_id)) END ELSE NULL END`;

export function queryConversationHistory(db: DatabaseSync, agentId: string, scope: ConversationHistoryScope, request: ConversationHistoryRequest) {
  const current = prepareSql(db, "SELECT user_id,chat_id,chat_type FROM sessions WHERE session_id=?").get(scope.sessionId) as
    { user_id: string; chat_id: string; chat_type: string | null } | undefined;
  if (scope.agentId !== agentId || !scope.userId || !scope.conversationId || !scope.conversationKind
    || scope.taskRunId || scope.backgroundTaskKind || !current || current.chat_id !== scope.conversationId
    || current.chat_type !== scope.conversationKind || current.chat_type === "p2p" && current.user_id !== scope.userId) {
    throw new Error("Conversation history is unavailable in this context");
  }
  initializeHistorySearch(db);
  const conditions = [scope.conversationKind === "p2p" ? "s.chat_type='p2p' AND s.user_id=?" : "s.chat_type='group' AND s.chat_id=?"];
  const values: SQLInputValue[] = [scope.conversationKind === "p2p" ? scope.userId : scope.conversationId];
  if (request.action !== "list" && request.session_id) {
    // Resolve access before message/turn anchors; inaccessible and unknown sessions are indistinguishable.
    if (!prepareSql(db, `SELECT 1 FROM sessions s WHERE ${conditions.join(" AND ")} AND s.session_id=?`).get(...values, request.session_id)) {
      throw new Error("The requested conversation is unavailable");
    }
    conditions.push("s.session_id=?"); values.push(request.session_id);
  }
  if (request.action !== "read") {
    const time = request.action === "list" ? "s.last_active_at" : "m.created_at";
    if (request.from) { conditions.push(`${time}>=?`); values.push(Date.parse(request.from)); }
    if (request.to) { conditions.push(`${time}<=?`); values.push(Date.parse(request.to)); }
  }
  const pagination = (rows: unknown[]) => ({ items: rows.slice(0, request.limit),
    has_more: rows.length > request.limit, ...(rows.length > request.limit ? { next_offset: request.offset + request.limit } : {}) });
  if (request.action === "list") {
    const rows = prepareSql(db, `SELECT s.session_id,substr(s.initial_user_preview,1,160) AS title,
      s.status,s.created_at,s.last_active_at,
      (SELECT count(*) FROM messages m WHERE m.deleted_at IS NULL AND m.session_id=s.session_id AND m.role IN ('user','assistant')) AS message_count
      FROM sessions s WHERE ${conditions.join(" AND ")} ORDER BY s.last_active_at DESC,s.session_id DESC LIMIT ? OFFSET ?`)
      .all(...values, request.limit + 1, request.offset);
    return { action: request.action, ...pagination(rows) };
  }
  conditions.push("m.deleted_at IS NULL", "m.role IN ('user','assistant')");
  if (request.action === "read" && request.message_id) {
    if (request.scope === "turn") {
      conditions.push("m.turn_id=(SELECT anchor.turn_id FROM messages anchor WHERE anchor.deleted_at IS NULL AND anchor.session_id=s.session_id AND anchor.id=? AND anchor.role IN ('user','assistant'))");
    } else conditions.push("m.id=?");
    values.push(request.message_id);
  }
  if (request.turn_id) { conditions.push("m.turn_id=?"); values.push(request.turn_id); }
  if (request.role !== "all") { conditions.push("m.role=?"); values.push(request.role); }
  const baseColumns = ["m.id", "m.session_id", "m.turn_id", "m.role", "m.created_at",
    ...(request.parts.includes("content") ? ["m.content", "m.question_answers_json"] : []),
    ...(request.parts.some(part => part !== "content") ? ["m.activity_trace_json"] : []),
    ...(request.parts.includes("tools") ? ["m.tool_trace_json"] : [])];
  const columns = `p.message_id,b.session_id,b.turn_id,b.role,b.created_at,b.speaker_label,p.part_id,p.type,p.metadata`;
  const decode = (rows: Array<Record<string, unknown>>) => rows.map(({ metadata, ...row }) => ({
    ...row, ...Object.fromEntries(Object.entries(JSON.parse(String(metadata))).filter(([, value]) => value !== null)
      .map(([key, value]) => [key, key === "failed" ? Boolean(value) : value]))
  }));
  if (request.action === "search") {
    const index = request.parts.length === 1 && request.parts[0] === "content" ? prepareHistorySearch(db) : undefined;
    const expression = index?.available ? historyMatchExpression(request.query, request.match) : undefined;
    const indexed = Boolean(expression), fts = historySearchIndex(request.match);
    const fingerprint = createHash("sha256").update(JSON.stringify([agentId, scope.userId, scope.conversationId, scope.conversationKind,
      request.query, request.match, request.sort, request.session_id, request.turn_id, request.role, request.parts, request.from, request.to])).digest("hex");
    const newest = request.scan_cursor ? undefined : prepareSql(db, `SELECT m.id,m.created_at FROM messages m
      JOIN sessions s ON s.session_id=m.session_id WHERE ${conditions.join(" AND ")}
      ORDER BY m.created_at DESC,m.id DESC LIMIT 1`).get(...values) as { id: string; created_at: number } | undefined;
    const cursor: ScanCursor | undefined = request.scan_cursor ? decodeScanCursor(request.scan_cursor, fingerprint)
      : newest ? { version: 1, fingerprint, cutoffAt: newest.created_at, cutoffId: newest.id } : undefined;
    if (!cursor) return { action: request.action, match: request.match, sort: request.sort, trust: "reference", items: [], has_more: false,
      coverage: { index: indexed ? "fts5" : "bounded_source_scan", complete: true, scan_exhausted: true, scanned_messages: 0 } };
    // The authoritative scan always traverses the same source ordering, never the changing missing-index set.
    // Index backfill and soft deletion cannot shift an offset and skip unseen source messages.
    const windowConditions = [...conditions, "(m.created_at<? OR (m.created_at=? AND m.id<=?))"];
    const windowValues: SQLInputValue[] = [...values, cursor.cutoffAt, cursor.cutoffAt, cursor.cutoffId];
    const scanConditions = [...windowConditions], scanValues = [...windowValues];
    if (cursor.before) {
      scanConditions.push("(m.created_at<? OR (m.created_at=? AND m.id<?))");
      scanValues.push(cursor.before.at, cursor.before.at, cursor.before.id);
    }
    const scanLimit = 100, candidateLimit = 200;
    const scanRows = prepareSql(db, `SELECT m.id,m.created_at FROM messages m JOIN sessions s ON s.session_id=m.session_id
      WHERE ${scanConditions.join(" AND ")} ORDER BY m.created_at DESC,m.id DESC LIMIT ?`)
      .all(...scanValues, scanLimit + 1) as Array<{ id: string; created_at: number }>;
    // Rank IDs first. At most 200 indexed candidates plus 100 source records can load bodies or run JS normalization.
    const indexedRows = indexed && !cursor.before ? prepareSql(db, `SELECT d.message_id AS id,bm25(${fts}) AS rank FROM ${fts}
      JOIN history_search_documents_v1 d ON d.id=${fts}.rowid JOIN messages m ON m.id=d.message_id
      JOIN sessions s ON s.session_id=m.session_id WHERE ${windowConditions.join(" AND ")} AND ${fts} MATCH ?
      ORDER BY ${request.sort === "relevance" ? "rank," : ""}m.created_at DESC,m.id DESC LIMIT ?`)
      .all(...windowValues, expression!, candidateLimit + 1) as Array<{ id: string; rank: number }> : [];
    const candidates = new Map(indexedRows.slice(0, candidateLimit).map(row => [row.id, row]));
    for (const row of scanRows.slice(0, scanLimit)) if (!candidates.has(row.id)) candidates.set(row.id, { id: row.id, rank: 0 });
    const candidateFingerprint = createHash("sha256").update(JSON.stringify([...candidates.values()])).digest("hex");
    if (request.offset > 0 && cursor.candidateFingerprint !== candidateFingerprint) {
      throw new Error("Search candidates changed while the index or sources were updated; restart this scan_cursor with offset=0 before continuing");
    }
    const searchProjection = `WITH base AS MATERIALIZED (
      SELECT ${baseColumns.join(",")},${speakerLabel} AS speaker_label,json_extract(candidate.value,'$.rank') AS search_rank
      FROM json_each(?) candidate JOIN messages m ON m.id=json_extract(candidate.value,'$.id')
      JOIN sessions s ON s.session_id=m.session_id WHERE ${windowConditions.join(" AND ")}),
      parts(message_id,part_id,type,text,metadata,sort_key) AS (${projectHistoryParts(request.parts)})`;
    const needles = historySearchNeedles(request.query), lexical = request.match !== "phrase" && needles.length > 0;
    const queryParameters = JSON.stringify(lexical ? [...new Set(historySearchTerms(request.query))] : [request.query.normalize("NFKC").toLowerCase()]);
    const matchSql = lexical
      ? request.match === "all" ? "matched_count=term_count" : "matched_count>0"
      : "instr(history_casefold(p.search_text),history_casefold(query.text))>0";
    // Searchable process data remains opt-in and is never copied into the visible-content index.
    const rows = prepareSql(db, `${searchProjection}, query AS (SELECT ? AS text,? AS terms,? AS needles), searchable AS (SELECT parts.*,
      COALESCE(json_extract(metadata,'$.tool_name') || char(10),'') ||
      COALESCE(json_extract(metadata,'$.tool_call_id') || char(10),'') || text AS search_text FROM parts)
      , normalized AS MATERIALIZED (SELECT searchable.*,history_normalize(search_text) AS normalized_text FROM searchable),
      scored AS (SELECT normalized.*,
        ${lexical ? "history_lexical_score(search_text,query.terms)" : "1"} AS matched_count,
        json_array_length(query.terms) AS term_count,
        (SELECT min(instr(normalized_text,t.value)) FROM json_each(query.needles) t
          WHERE instr(normalized_text,t.value)>0) AS first_match FROM normalized CROSS JOIN query)
      SELECT ${columns},history_source_hash(p.text) AS source_hash,p.matched_count,
        substr(p.search_text,max(1,COALESCE(p.first_match,1)-80),320) AS excerpt
      FROM scored p JOIN base b ON b.id=p.message_id CROSS JOIN query WHERE ${matchSql}
      ORDER BY ${request.sort === "relevance" ? "p.matched_count DESC,COALESCE(b.search_rank,0)," : ""}
        b.created_at DESC,p.message_id DESC,p.sort_key,p.part_id LIMIT ? OFFSET ?`)
      .all(JSON.stringify([...candidates.values()]), ...windowValues,
        request.query, queryParameters, JSON.stringify(lexical ? needles : [request.query.normalize("NFKC").toLowerCase()]), request.limit + 1, request.offset);
    const nextSource = scanRows[scanLimit - 1];
    return { action: request.action, match: request.match, sort: request.sort, trust: "reference",
      coverage: { index: indexed ? "fts5" : "bounded_source_scan", index_ready: index?.complete ?? false,
        scanned_messages: Math.min(scanRows.length, scanLimit), indexed_candidates: Math.min(indexedRows.length, candidateLimit),
        indexed_candidates_limited: indexedRows.length > candidateLimit, scan_cursor: encodeScanCursor({ ...cursor, candidateFingerprint }),
        complete: scanRows.length <= scanLimit && !cursor.before, scan_exhausted: scanRows.length <= scanLimit,
        ...(scanRows.length > scanLimit && nextSource ? { next_scan_cursor: encodeScanCursor({ ...cursor, candidateFingerprint: undefined,
          before: { at: nextSource.created_at, id: nextSource.id } }) } : {}),
        note: "Relevance is ranked within bounded candidates, not a complete global ranking. First exhaust next_offset using this scan_cursor, then follow next_scan_cursor with offset=0 and unchanged filters. Stable source scanning covers all records at the cutoff despite index backfill; indexed candidates may repeat in later source windows. Empty partial results do not establish absence. Source edits require rereading hashes." },
      ...pagination(decode(rows)) };
  }
  // Existing content-only callers can keep using message_id + content_offset without part_id.
  const partId = request.part_id ?? (request.content_offset ? "content" : undefined);
  // The single content projection already streams without expanding process records.
  // Keep its query plan, including how skipped/invalid source rows are evaluated.
  const contentOnly = request.parts.length === 1 && request.parts[0] === "content";
  const rows = contentOnly ? prepareSql(db, `WITH base AS (
    SELECT ${baseColumns.join(",")},${speakerLabel} AS speaker_label FROM messages m
      JOIN sessions s ON s.session_id=m.session_id WHERE ${conditions.join(" AND ")}),
    parts(message_id,part_id,type,text,metadata,sort_key) AS (${projectHistoryParts(request.parts)})
    SELECT ${columns},history_source_hash(p.text) AS source_hash,
      substr(p.text,?,2000) AS content,length(p.text) AS content_length
    FROM parts p JOIN base b ON b.id=p.message_id ${partId ? "WHERE p.part_id=?" : ""}
    ORDER BY b.turn_id,CASE b.role WHEN 'user' THEN 0 ELSE 1 END,p.message_id,p.sort_key,p.part_id LIMIT ? OFFSET ?`)
    .all(...values, request.content_offset + 1, ...(partId ? [partId] : []), request.limit + 1, request.offset)
  // Materialize only ordered part identities across the session. Bodies and speaker labels
  // are projected for the selected page's messages inside the same SQLite read snapshot.
  : prepareSql(db, `WITH eligible AS NOT MATERIALIZED (
    SELECT ${baseColumns.join(",")} FROM messages m JOIN sessions s ON s.session_id=m.session_id
    WHERE ${conditions.join(" AND ")}),
    part_keys(message_id,part_id,sort_key) AS (${projectHistoryParts(request.parts, { source: "eligible", keysOnly: true })}),
    page AS MATERIALIZED (SELECT p.message_id,p.part_id,p.sort_key,b.turn_id,b.role
      FROM part_keys p JOIN eligible b ON b.id=p.message_id ${partId ? "WHERE p.part_id=?" : ""}
      ORDER BY b.turn_id,CASE b.role WHEN 'user' THEN 0 ELSE 1 END,p.message_id,p.sort_key,p.part_id LIMIT ? OFFSET ?),
    base AS MATERIALIZED (SELECT ${baseColumns.join(",")},${speakerLabel} AS speaker_label FROM messages m
      JOIN sessions s ON s.session_id=m.session_id WHERE m.id IN (SELECT message_id FROM page)),
    parts(message_id,part_id,type,text,metadata,sort_key) AS (${projectHistoryParts(request.parts)})
    SELECT ${columns},history_source_hash(p.text) AS source_hash,
      substr(p.text,?,2000) AS content,length(p.text) AS content_length
    FROM page selected JOIN parts p ON p.message_id=selected.message_id AND p.part_id=selected.part_id
      JOIN base b ON b.id=p.message_id
    ORDER BY b.turn_id,CASE b.role WHEN 'user' THEN 0 ELSE 1 END,p.message_id,p.sort_key,p.part_id`)
    .all(...values, ...(partId ? [partId] : []), request.limit + 1, request.offset, request.content_offset + 1);
  if (request.expected_hash && rows.some(row => row.source_hash !== request.expected_hash)) {
    throw new Error("Historical source changed after it was read; search or read it again before continuing");
  }
  const messages = decode(rows).map(row => ({ ...row, content_offset: request.content_offset,
    ...(Number(row.content_length) > request.content_offset + 2000 ? { next_content_offset: request.content_offset + 2000 } : {}) }));
  return { action: request.action, trust: "reference", ...pagination(messages) };
}
