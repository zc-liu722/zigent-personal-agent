import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { prepareSql, sqliteTransaction } from "../sqlite.js";

const FTS = "history_search_fts_v1";
const LITERAL_FTS = "history_search_literal_v1";
const BATCH_SIZE = 16;
const MAX_INDEXED_CHARACTERS = 100_000;
type IndexState = { available: boolean; closed: boolean; scheduled?: NodeJS.Immediate; timer?: NodeJS.Timeout };
const states = new WeakMap<DatabaseSync, IndexState>();

function lexicalSegments(text: string): string[] {
  return [...text.normalize("NFKC").toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu)]
    .flatMap(([value]) => value.split(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+)/u).filter(Boolean));
}

/** Explicit lexical recall: CJK bigrams find terms without an external tokenizer/model.
 * Single-character terms are separately indexed. NFKC handles full-width Latin text.
 * No raw MATCH syntax is accepted from a caller.
 */
export function historySearchTerms(text: string, includeSingleCharacters = false): string[] {
  const tokens: string[] = [];
  for (const value of lexicalSegments(text)) {
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value)) {
      const chars = Array.from(value), encoded = chars.map(char => char.codePointAt(0)!.toString(16));
      if (includeSingleCharacters || chars.length === 1) tokens.push(...encoded.map(char => `u${char}`));
      for (let index = 0; index + 1 < encoded.length; index++) tokens.push(`b${encoded[index]}x${encoded[index + 1]}`);
    } else tokens.push(`w${value}`);
  }
  return tokens;
}

export function historyMatchExpression(query: string, match: "phrase" | "all" | "any"): string | undefined {
  if (match === "phrase") return Array.from(query).length >= 3 ? `"${query.replaceAll('"', '""')}"` : undefined;
  const terms = [...new Set(historySearchTerms(query))];
  if (!terms.length) return undefined;
  return terms.map(term => `"${term.replaceAll('"', '""')}"`).join(match === "any" ? " OR " : " AND ");
}

export function historySearchNeedles(query: string): string[] {
  return [...new Set(lexicalSegments(query).flatMap(value => {
      const chars = Array.from(value);
      return chars.length > 1 && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value)
        ? chars.slice(0, -1).map((char, index) => char + chars[index + 1]) : [value];
    }))];
}

function visibleContent(content: string, role: string, answerJson: string | null): string {
  if (role !== "user" || !answerJson) return content;
  try {
    const answers: unknown = JSON.parse(answerJson);
    if (!Array.isArray(answers)) return content;
    return content + answers.map(answer => answer && typeof answer === "object"
      ? "\n" + [typeof answer.question === "string" ? answer.question : "",
        Array.isArray(answer.selectedOptions) ? answer.selectedOptions.filter((value: unknown) => typeof value === "string").join("；") : "",
        typeof answer.text === "string" ? answer.text : ""].join("\n") : "").join("");
  } catch { return content; }
}

function indexMessage(db: DatabaseSync, id: string): number {
  const row = prepareSql(db, `SELECT id,role,substr(content,1,?) AS content,length(content) AS content_length,
    question_answers_json FROM messages WHERE id=? AND deleted_at IS NULL AND role IN ('user','assistant')`)
    .get(MAX_INDEXED_CHARACTERS, id) as { id: string; role: string; content: string; content_length: number; question_answers_json: string | null } | undefined;
  prepareSql(db, "DELETE FROM history_search_documents_v1 WHERE message_id=?").run(id);
  if (row) {
    const text = visibleContent(row.content, row.role, row.question_answers_json);
    const doc = prepareSql(db, "INSERT INTO history_search_documents_v1(message_id,truncated) VALUES (?,?) RETURNING id")
      .get(row.id, Number(row.content_length > MAX_INDEXED_CHARACTERS || text.length > MAX_INDEXED_CHARACTERS)) as { id: number };
    prepareSql(db, `INSERT INTO ${FTS}(rowid,text) VALUES (?,?)`)
      .run(doc.id, historySearchTerms(text.slice(0, MAX_INDEXED_CHARACTERS), true).join(" "));
    prepareSql(db, `INSERT INTO ${LITERAL_FTS}(rowid,text) VALUES (?,?)`).run(doc.id, text.slice(0, MAX_INDEXED_CHARACTERS));
  }
  prepareSql(db, "DELETE FROM history_search_pending_v1 WHERE message_id=?").run(id);
  return row?.content.length ?? 0;
}

/** One bounded synchronous batch; existing history is never rebuilt on the startup path. */
function advance(db: DatabaseSync): boolean {
  return sqliteTransaction(db, () => {
    const started = Date.now();
    let characters = 0;
    const exhausted = () => characters >= 100_000 || Date.now() - started >= 12;
    const pending = prepareSql(db, "SELECT message_id FROM history_search_pending_v1 ORDER BY message_id LIMIT ?")
      .all(BATCH_SIZE) as Array<{ message_id: string }>;
    for (const row of pending) {
      characters += indexMessage(db, row.message_id);
      if (exhausted()) return true;
    }
    const cursor = prepareSql(db, "SELECT last_id,complete FROM history_search_state_v1 WHERE singleton=1").get() as { last_id: string; complete: number };
    if (!cursor.complete) {
      // The primary-key cursor survives VACUUM. Inserts behind the cursor enter the trigger queue.
      const rows = prepareSql(db, "SELECT id FROM messages WHERE id>? ORDER BY id LIMIT ?")
        .all(cursor.last_id, BATCH_SIZE) as Array<{ id: string }>;
      let lastId = cursor.last_id, processed = 0;
      for (const row of rows) {
        characters += indexMessage(db, row.id); lastId = row.id; processed++;
        if (exhausted()) break;
      }
      prepareSql(db, "UPDATE history_search_state_v1 SET last_id=?,complete=? WHERE singleton=1")
        .run(lastId, Number(rows.length < BATCH_SIZE && processed === rows.length));
      if (rows.length === BATCH_SIZE || processed < rows.length) return true;
    }
    return Boolean(prepareSql(db, "SELECT 1 FROM history_search_pending_v1 LIMIT 1").get());
  });
}

function schedule(db: DatabaseSync, state: IndexState): void {
  if (state.closed || state.scheduled || !state.available) return;
  state.scheduled = setImmediate(() => {
    state.scheduled = undefined;
    if (state.closed) return;
    try { if (advance(db)) schedule(db, state); }
    catch { state.available = false; console.warn("HISTORY_SEARCH_INDEX_UNAVAILABLE"); }
  });
  state.scheduled.unref();
}

export function initializeHistorySearch(db: DatabaseSync): void {
  if (states.has(db)) return;
  db.function("history_source_hash", { deterministic: true }, value => createHash("sha256").update(String(value ?? "")).digest("hex"));
  db.function("history_normalize", { deterministic: true }, value => String(value ?? "").normalize("NFKC").toLowerCase());
  db.function("history_casefold", { deterministic: true }, value => String(value ?? "").toLowerCase());
  db.function("history_lexical_score", { deterministic: true }, (value, query) => {
    const source = new Set(historySearchTerms(String(value ?? ""), true));
    const terms = JSON.parse(String(query)) as string[];
    return terms.reduce((score, term) => score + Number(source.has(term)), 0);
  });
  const state: IndexState = { available: false, closed: false };
  states.set(db, state);
  try {
    sqliteTransaction(db, () => db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS} USING fts5(text, tokenize='unicode61');
      CREATE VIRTUAL TABLE IF NOT EXISTS ${LITERAL_FTS} USING fts5(text, tokenize='trigram');
      CREATE TABLE IF NOT EXISTS history_search_documents_v1 (
        id INTEGER PRIMARY KEY, message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
        truncated INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS history_search_pending_v1 (
        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS history_search_state_v1 (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),last_id TEXT NOT NULL DEFAULT '',complete INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO history_search_state_v1(singleton) VALUES (1);
      CREATE TRIGGER IF NOT EXISTS history_search_document_delete_v1 AFTER DELETE ON history_search_documents_v1 BEGIN
        DELETE FROM ${FTS} WHERE rowid=old.id;
        DELETE FROM ${LITERAL_FTS} WHERE rowid=old.id;
      END;
      CREATE TRIGGER IF NOT EXISTS history_search_message_insert_v1 AFTER INSERT ON messages
        WHEN new.role IN ('user','assistant') AND new.deleted_at IS NULL BEGIN
        INSERT OR IGNORE INTO history_search_pending_v1(message_id) VALUES (new.id);
      END;
      CREATE TRIGGER IF NOT EXISTS history_search_message_update_v1 AFTER UPDATE OF content,question_answers_json,role,deleted_at ON messages BEGIN
        DELETE FROM history_search_documents_v1 WHERE message_id=old.id;
        DELETE FROM history_search_pending_v1 WHERE message_id=old.id;
        INSERT OR IGNORE INTO history_search_pending_v1(message_id)
          SELECT new.id WHERE new.role IN ('user','assistant') AND new.deleted_at IS NULL;
      END;
    `));
    state.available = true;
    schedule(db, state);
    state.timer = setInterval(() => schedule(db, state), 5_000);
    state.timer.unref();
  } catch (error) {
    if (!/no such (module.*fts5|tokenizer.*trigram)/i.test(error instanceof Error ? error.message : String(error))) throw error;
    console.warn("HISTORY_SEARCH_FTS5_UNAVAILABLE");
  }
}

export function closeHistorySearch(db: DatabaseSync): void {
  const state = states.get(db);
  if (!state) return;
  state.closed = true;
  if (state.scheduled) clearImmediate(state.scheduled);
  if (state.timer) clearInterval(state.timer);
  states.delete(db);
}

export function prepareHistorySearch(db: DatabaseSync): { available: boolean; complete: boolean } {
  initializeHistorySearch(db);
  const state = states.get(db)!;
  if (!state.available) return { available: false, complete: false };
  try {
    const pending = advance(db);
    if (pending) schedule(db, state);
    return { available: true, complete: !pending };
  } catch {
    state.available = false;
    return { available: false, complete: false };
  }
}

export function historySearchIndex(match: "phrase" | "all" | "any"): string { return match === "phrase" ? LITERAL_FTS : FTS; }
