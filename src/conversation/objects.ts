import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { prepareSql } from "../sqlite.js";

type Node = ["value", unknown] | ["ref", string];
export const isMissingConversationObject = (error: unknown): boolean =>
  error instanceof Error && error.message === "CONVERSATION_OBJECT_MISSING";
/** Agent-local immutable DAG. Typed nodes keep provider JSON and binary values unambiguous. */
export class ConversationObjects {
  constructor(readonly db: DatabaseSync) {}
  put(value: unknown): string {
    let kind: string, body: string | Buffer, children: string[] = [];
    const node = (entry: unknown, force = false): Node => {
      if (entry === undefined) return ["value", null];
      if (entry === null || typeof entry === "boolean" || typeof entry === "number"
        || typeof entry === "string" && entry.length < 128 && !force) return ["value", entry];
      const hash = this.put(entry); children.push(hash); return ["ref", hash];
    };
    if (typeof value === "string") { kind = "text"; body = value; }
    else if (value instanceof Uint8Array) { kind = "bytes"; body = Buffer.from(value); }
    else if (Array.isArray(value)) { kind = "array"; body = JSON.stringify(value.map(entry => node(entry))); }
    else if (value && typeof value === "object") {
      kind = "object";
      body = JSON.stringify(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, node(entry, ["text","content","answerDraft","arguments","value"].includes(key))]));
    } else { kind = "scalar"; body = JSON.stringify(value ?? null); }
    const hash = createHash("sha256").update(kind + "\0").update(body).digest("hex");
    prepareSql(this.db, "INSERT OR IGNORE INTO conversation_objects(hash,kind,body,bytes,created_at) VALUES(?,?,?,?,?)")
      .run(hash, kind, body, Buffer.byteLength(body), Date.now());
    // Reusing a parent also repairs edges removed by earlier partial reclamation.
    for (const child of new Set(children)) prepareSql(this.db,
      "INSERT OR IGNORE INTO conversation_object_edges(parent,child) VALUES(?,?)").run(hash, child);
    return hash;
  }
  field(hash: string, key: string): unknown {
    const row = prepareSql(this.db, "SELECT kind,body FROM conversation_objects WHERE hash=?").get(hash);
    if (row?.kind !== "object") return undefined;
    const node = (JSON.parse(String(row.body)) as [string, Node][]).find(([name]) => name === key)?.[1];
    return node?.[0] === "ref" ? this.get(node[1], new Set([hash])) : node?.[1];
  }
  get(hash: string, path = new Set<string>()): unknown {
    if (path.has(hash) || path.size > 256) throw new Error("CONVERSATION_OBJECT_CYCLE");
    const row = prepareSql(this.db, "SELECT kind,body FROM conversation_objects WHERE hash=?").get(hash) as
      { kind: string; body: string | Uint8Array } | undefined;
    if (!row) throw new Error("CONVERSATION_OBJECT_MISSING");
    if (row.kind === "text") return String(row.body);
    if (row.kind === "bytes") return Buffer.from(row.body as Uint8Array);
    const next = new Set(path).add(hash);
    const node = ([type, value]: Node): unknown => type === "ref" ? this.get(String(value), next) : value;
    const parsed = JSON.parse(String(row.body));
    if (row.kind === "array") return (parsed as Node[]).map(node);
    if (row.kind === "object") return Object.fromEntries((parsed as [string, Node][]).map(([key, value]) => [key, node(value)]));
    return parsed;
  }
  root(owner: string, slot: string): { hash: string; revision: number } | undefined {
    return prepareSql(this.db, "SELECT hash,revision FROM conversation_roots WHERE owner=? AND slot=?").get(owner, slot) as ReturnType<ConversationObjects["root"]>;
  }
  set(owner: string, slot: string, value: unknown): { hash: string; revision: number } {
    const hash = this.put(value), previous = this.root(owner, slot);
    if (previous?.hash === hash) return previous;
    const revision = (previous?.revision ?? 0) + 1;
    prepareSql(this.db, `INSERT INTO conversation_roots(owner,slot,hash,revision,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(owner,slot) DO UPDATE SET hash=excluded.hash,revision=excluded.revision,updated_at=excluded.updated_at`)
      .run(owner, slot, hash, revision, Date.now());
    return { hash, revision };
  }
  read(owner: string, slot: string): unknown {
    const root = this.root(owner, slot); return root ? this.get(root.hash) : undefined;
  }
}
