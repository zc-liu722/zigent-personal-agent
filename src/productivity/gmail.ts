import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { parseHTML } from "linkedom";
import { CodePointText } from "../text/code-points.js";
import { GoogleOAuthClient } from "./google-auth.js";
import { readGrant, withTokenLock, writePrivateJson, ProductivityAuthorizationRequiredError } from "./credentials.js";
import { record, requestResponse } from "./http.js";

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"] as const;
export const GMAIL_ATTACHMENT_LIMIT = 25 * 1024 * 1024;
export type MailAttachment = { name: string; mime: string; size: number; sha256: string; bytes: Buffer };
export type MailInput = { to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string; reply_message_id?: string };
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const text = (v: unknown) => typeof v === "string" ? v : "";
const encoded = (v: string) => [...v].reduce<string[]>((out, c) => { if (!out.length || Buffer.byteLength(out.at(-1)! + c) > 36) out.push(c); else out[out.length - 1] += c; return out; }, []).map(s => `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`).join("\r\n ");
const base64 = (v: Buffer) => v.toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
function decodeHeader(value: string): string {
  return value.replace(/(\?=)[ \t\r\n]+(?==\?)/g, "$1").replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (original, charset: string, encoding: string, content: string) => {
    try {
      const data = encoding.toLowerCase() === "b" ? Buffer.from(content, "base64")
        : Buffer.from(content.replace(/_/g, " ").replace(/=([a-f0-9]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))), "latin1");
      return new TextDecoder(charset).decode(data);
    } catch { return original; }
  });
}
function headers(payload: unknown) {
  const values: Record<string, string> = {};
  for (const item of array(record(payload).headers)) { const h = record(item); if (typeof h.name === "string" && typeof h.value === "string") values[h.name.toLowerCase()] = decodeHeader(h.value); }
  return values;
}
function parts(payload: unknown): Record<string, unknown>[] { const p = record(payload); return [p, ...array(p.parts).flatMap(parts)]; }
function bytes(value: unknown): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*={0,2}$/.test(value)) throw new Error("Gmail: invalid attachment encoding");
  return Buffer.from(value, "base64url");
}
function mailMetadata(value: unknown) {
  const m = record(value), h = headers(m.payload);
  return { id: m.id, thread_id: m.threadId, labels: m.labelIds, from: h.from, to: h.to, cc: h.cc, subject: h.subject, date: h.date, size: m.sizeEstimate };
}
export class GmailClient extends GoogleOAuthClient {
  async call(path: string, signal?: AbortSignal, body?: unknown): Promise<Record<string, unknown>> {
    const grant = await readGrant(this.config);
    if (grant?.scopes && !GMAIL_SCOPES.every(s => grant.scopes!.includes(s))) throw new ProductivityAuthorizationRequiredError("Google Gmail");
    const token = await this.accessToken(signal);
    const response = await requestResponse(this.request, "Google Gmail", `https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
      method: body === undefined ? "GET" : "POST", signal,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    // Bound decoded responses, including binary attachment bodies, before JSON parsing.
    const reader = response.body?.getReader(); if (!reader) throw new Error("Gmail: empty response");
    const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length;
      if (size > 48 * 1024 * 1024) throw new Error("Gmail: response exceeds 48 MiB"); chunks.push(chunk.value); }
    } finally { await reader.cancel(); reader.releaseLock(); }
    try { return record(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
    catch { throw new Error("Gmail: invalid response; do not repeat an uncertain send"); }
  }
  async profile(signal?: AbortSignal) {
    const p = await this.call("profile", signal);
    if (typeof p.emailAddress !== "string" || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/.test(p.emailAddress)) throw new Error("Gmail: invalid account profile");
    return { email_address: p.emailAddress, messages_total: p.messagesTotal, threads_total: p.threadsTotal };
  }
  async search(query: string | undefined, pageToken: string | undefined, limit: number, signal?: AbortSignal) {
    const params = new URLSearchParams({ maxResults: String(limit), ...(query ? { q: query } : {}), ...(pageToken ? { pageToken } : {}) });
    const result = await this.call(`messages?${params}`, signal);
    const messages = [];
    for (const item of array(result.messages)) {
      const id = text(record(item).id); if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Gmail: invalid message ID");
      const params = new URLSearchParams({ format: "metadata" });
      for (const h of ["From", "To", "Subject", "Date"]) params.append("metadataHeaders", h);
      messages.push(mailMetadata(await this.call(`messages/${id}?${params}`, signal)));
    }
    return { messages, next_page_token: result.nextPageToken ?? null, result_size_estimate: result.resultSizeEstimate, trust: "untrusted_mail_content" };
  }
  async message(id: string, signal?: AbortSignal) { const m = await this.call(`messages/${encodeURIComponent(id)}?format=full`, signal); if (m.id !== id) throw new Error("Gmail: invalid message response"); return m; }
  async read(id: string, offset: number, limit: number, signal?: AbortSignal) {
    const m = await this.message(id, signal), all = parts(m.payload);
    const bodyParts = all.filter(p => !p.filename && ["text/plain", "text/html"].includes(text(p.mimeType)));
    const plain = bodyParts.filter(p => p.mimeType === "text/plain"), selected = plain.length ? plain : bodyParts;
    const content = [];
    for (const p of selected) {
      const b = record(p.body);
      const data = b.data !== undefined ? bytes(b.data) : b.attachmentId ? await this.attachmentBytes(id, text(b.attachmentId), signal) : Buffer.alloc(0);
      const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(headers(p)["content-type"] ?? "")?.[1] ?? "utf-8";
      let decoded: string; try { decoded = new TextDecoder(charset).decode(data); } catch { decoded = data.toString("utf8"); }
      if (p.mimeType === "text/html") { const { document } = parseHTML(`<html><body>${decoded}</body></html>`); for (const el of document.querySelectorAll("script,style")) el.remove(); decoded = document.body.textContent ?? ""; }
      content.push(decoded);
    }
    const chars = new CodePointText(content.join("\n"));
    return { ...mailMetadata(m), content: chars.slice(offset, offset + limit), offset, total_characters: chars.length,
      next_offset: offset + limit < chars.length ? offset + limit : null,
      attachments: all.filter(p => p.filename || record(p.body).attachmentId && !text(p.mimeType).startsWith("text/")).map(p => ({ part_id: p.partId, name: p.filename || "attachment", mime: p.mimeType, size: record(p.body).size })),
      trust: "untrusted_mail_content", content_scope: plain.length ? "plain_text_parts" : "html_text_without_images_or_formatting" };
  }
  private async attachmentBytes(messageId: string, attachmentId: string, signal?: AbortSignal) {
    const result = await this.call(`messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`, signal);
    if (typeof result.size !== "number" || result.size > GMAIL_ATTACHMENT_LIMIT) throw new Error("Gmail: attachment exceeds 25 MiB");
    const data = bytes(result.data); if (data.length !== result.size) throw new Error("Gmail: incomplete attachment"); return data;
  }
  async attachment(messageId: string, partId: string, signal?: AbortSignal): Promise<MailAttachment> {
    const m = await this.message(messageId, signal), p = parts(m.payload).find(p => p.partId === partId);
    if (!p || !p.filename) throw new Error("Gmail: select an attachment part_id from read_message");
    const b = record(p.body); if (Number(b.size) > GMAIL_ATTACHMENT_LIMIT) throw new Error("Gmail: attachment exceeds 25 MiB");
    const data = b.data !== undefined ? bytes(b.data) : await this.attachmentBytes(messageId, text(b.attachmentId), signal);
    if (data.length !== b.size || data.length > GMAIL_ATTACHMENT_LIMIT) throw new Error("Gmail: incomplete or oversized attachment");
    const name = text(p.filename).replace(/[\\/\x00-\x1f\x7f]/g, "_").slice(0, 160) || "attachment";
    return { name, mime: text(p.mimeType), bytes: data, size: data.length, sha256: createHash("sha256").update(data).digest("hex") };
  }
  async replyMetadata(id: string, signal?: AbortSignal) {
    const m = await this.message(id, signal), h = headers(m.payload);
    const messageId = h["message-id"];
    if (!messageId || messageId.length > 250 || !/^<[^<>\s\x00-\x1f]+>$/.test(messageId)) throw new Error("Gmail: original message has no usable Message-ID");
    return { message_id: id, thread_id: text(m.threadId), subject: h.subject ?? "", rfc_message_id: messageId,
      references: (h.references?.match(/<[^<>\s\x00-\x1f]+>/g) ?? []).filter(v => v.length <= 250).slice(-3).concat(messageId).join("\r\n ") };
  }
  async send(input: MailInput, from: string, attachments: MailAttachment[], sendKey: string, reply: Awaited<ReturnType<GmailClient["replyMetadata"]>> | undefined, signal?: AbortSignal) {
    const journal = join(dirname(this.config.tokenPath), "gmail-outbox", `${sendKey}.json`);
    return withTokenLock(journal, async () => {
      let prior: Record<string, unknown> = {};
      try { prior = record(JSON.parse(await readFile(journal, "utf8"))); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      if (prior.status === "sent") return prior;
      if (prior.status) throw new Error(`Gmail: previous send outcome is uncertain; search in:sent rfc822msgid:${text(prior.rfc_message_id)} before considering another send`);
      signal?.throwIfAborted();
      const messageId = `<zigent-${sendKey}@${from.split("@")[1]}>`, boundary = `zigent_${randomUUID()}`;
      const lines = [`From: ${from}`, `To: ${input.to.join(",\r\n ")}`, ...(input.cc?.length ? [`Cc: ${input.cc.join(",\r\n ")}`] : []), ...(input.bcc?.length ? [`Bcc: ${input.bcc.join(",\r\n ")}`] : []),
        `Subject: ${encoded(reply?.subject ?? input.subject)}`, `Date: ${new Date().toUTCString()}`, `Message-ID: ${messageId}`, "MIME-Version: 1.0",
        ...(reply ? [`In-Reply-To: ${reply.rfc_message_id}`, `References: ${reply.references}`] : []), `Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`,
        "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", base64(Buffer.from(input.body))];
      for (const f of attachments) {
        const filename = encodeURIComponent(f.name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
        lines.push(`--${boundary}`, `Content-Type: ${/^[\w.+-]+\/[\w.+-]+$/.test(f.mime) ? f.mime : "application/octet-stream"}`, `Content-Disposition: attachment; filename*=UTF-8''${filename}`, "Content-Transfer-Encoding: base64", "", base64(f.bytes));
      }
      lines.push(`--${boundary}--`, ""); const raw = Buffer.from(lines.join("\r\n"));
      if (raw.length > 35 * 1024 * 1024) throw new Error("Gmail: encoded message exceeds 35 MiB");
      await writePrivateJson(journal, { status: "uncertain", rfc_message_id: messageId, created_at: Date.now() });
      // No retries, including after permission errors: a new request must first resolve this journal.
      const result = await this.call("messages/send", signal, { raw: raw.toString("base64url"), ...(reply ? { threadId: reply.thread_id } : {}) });
      if (typeof result.id !== "string") throw new Error(`Gmail: send outcome uncertain; search rfc822msgid:${messageId}`);
      const receipt = { status: "sent", message_id: result.id, thread_id: result.threadId, from_address: from, rfc_message_id: messageId };
      await writePrivateJson(journal, receipt); return receipt;
    }, signal);
  }
}
