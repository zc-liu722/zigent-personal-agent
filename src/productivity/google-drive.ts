import { randomUUID } from "node:crypto";
import type { GoogleDriveConfig } from "./config.js";
import { GoogleOAuthClient } from "./google-auth.js";
import { ProductivityAuthorizationRequiredError, readGrant } from "./credentials.js";
import { pick, productivityFetch, record, requestJson, requestResponse } from "./http.js";
import { GoogleWorkspaceEditor } from "./google-workspace.js";

export const GOOGLE_DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive"] as const;
export const DRIVE_TEXT_MAX_BYTES = 1024 * 1024;
export const DRIVE_FILE_FIELDS = "id,name,mimeType,description,modifiedTime,size,webViewLink,parents,trashed,capabilities(canDownload),shortcutDetails(targetId,targetMimeType,targetResourceKey)";
const EXPORT_TYPES: Readonly<Record<string, { mimeType: string; scope: string }>> = {
  "application/vnd.google-apps.document": { mimeType: "text/plain", scope: "document_text" },
  "application/vnd.google-apps.presentation": { mimeType: "text/plain", scope: "presentation_text" },
  "application/vnd.google-apps.spreadsheet": { mimeType: "text/csv", scope: "first_sheet_only" }
};

function metadata(value: unknown): Record<string, unknown> & { id: string; name: string; mimeType: string; capabilities: Record<string, unknown> } {
  const source = record(value);
  if (typeof source.id !== "string" || typeof source.name !== "string" || typeof source.mimeType !== "string") throw new Error("Google Drive: invalid file metadata response");
  return {
    ...pick(source, ["id", "name", "mimeType", "description", "modifiedTime", "size", "webViewLink", "parents", "trashed"]),
    id: source.id, name: source.name, mimeType: source.mimeType,
    capabilities: pick(source.capabilities, ["canDownload"]),
    ...(source.shortcutDetails ? { shortcutDetails: pick(source.shortcutDetails, ["targetId", "targetMimeType", "targetResourceKey"]) } : {})
  };
}

async function boundedText(response: Response): Promise<string> {
  if (Number(response.headers.get("Content-Length")) > DRIVE_TEXT_MAX_BYTES) {
    await response.body?.cancel();
    throw new Error("Google Drive: text exceeds the 1 MiB reading limit; use a smaller document");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Google Drive: missing text response");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > DRIVE_TEXT_MAX_BYTES) throw new Error("Google Drive: text exceeds the 1 MiB reading limit; use a smaller document");
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof Error && error.message.startsWith("Google Drive:")) throw error;
    throw new Error("Google Drive: text could not be read as UTF-8 or the download was interrupted");
  } finally { reader.releaseLock(); }
}

export class GoogleDriveClient extends GoogleOAuthClient {
  readonly workspace = new GoogleWorkspaceEditor(async (url, method, body, signal) => {
    if (method !== "GET") await this.ensureWritable();
    const response = await this.withAuthorization(async () => requestResponse(this.request, this.service, url, {
      method, signal, headers: { Authorization: `Bearer ${await this.accessToken(signal)}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }));
    try { return JSON.parse(await boundedText(response)) as unknown; }
    catch (error) {
      if (method !== "GET") throw new Error("Google Drive: write response could not be read; outcome is uncertain; read current state before retrying");
      throw error;
    }
  });
  constructor(config: GoogleDriveConfig, request = productivityFetch(config.proxyUrl)) { super(config, request, "Google Drive"); }

  private async withAuthorization<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof ProductivityAuthorizationRequiredError) this.invalidateToken();
      throw error;
    }
  }

  async ensureWritable(): Promise<void> {
    const grant = await readGrant(this.config);
    if (grant?.scopes && !grant.scopes.includes(GOOGLE_DRIVE_SCOPES[0])) {
      this.invalidateToken();
      throw new ProductivityAuthorizationRequiredError(this.service, "read-only grant must be upgraded; reconnect the account");
    }
  }

  /** All paths and methods are code-owned; callers cannot provide an arbitrary URL. */
  private async get(path: string, query: Record<string, string>, text: boolean, signal?: AbortSignal, resource?: { id: string; key?: string }): Promise<unknown> {
    const token = await this.accessToken(signal);
    const url = new URL(`https://www.googleapis.com/drive/v3/${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const init: RequestInit = { method: "GET", signal, headers: {
      Authorization: `Bearer ${token}`,
      ...(resource?.key ? { "X-Goog-Drive-Resource-Keys": `${resource.id}/${resource.key}` } : {})
    } };
    try {
      return text ? await boundedText(await requestResponse(this.request, this.service, url, init)) : await requestJson(this.request, this.service, url, init);
    } catch (error) {
      if (error instanceof ProductivityAuthorizationRequiredError) this.invalidateToken();
      throw error;
    }
  }

  async list(query: { query?: string; folder_id?: string; drive_id?: string; page_token?: string; resource_key?: string; limit: number }, signal?: AbortSignal) {
    const literal = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const q = ["trashed = false", ...(query.query ? [`(${query.query})`] : []), ...(query.folder_id ? [`'${literal(query.folder_id)}' in parents`] : [])].join(" and ");
    const result = record(await this.get("files", {
      q, pageSize: String(query.limit), fields: `files(${DRIVE_FILE_FIELDS}),nextPageToken,incompleteSearch`,
      spaces: "drive", orderBy: "modifiedTime desc", supportsAllDrives: "true", includeItemsFromAllDrives: "true",
      corpora: query.drive_id ? "drive" : "user", ...(query.drive_id ? { driveId: query.drive_id } : {}),
      ...(query.page_token ? { pageToken: query.page_token } : {})
    }, false, signal, query.folder_id ? { id: query.folder_id, key: query.resource_key } : undefined));
    if (!Array.isArray(result.files)) throw new Error("Google Drive: invalid file list response");
    return { files: result.files.map(metadata), next_page_token: result.nextPageToken ?? null, incomplete_search: result.incompleteSearch === true };
  }

  async file(id: string, signal?: AbortSignal, resourceKey?: string) {
    return metadata(await this.get(`files/${encodeURIComponent(id)}`, { fields: DRIVE_FILE_FIELDS, supportsAllDrives: "true" }, false, signal, { id, key: resourceKey }));
  }

  private async write(path: string, body: string, contentType: string, method: "POST" | "PATCH", signal?: AbortSignal, resource?: { id: string; key?: string }, upload?: "media" | "multipart") {
    await this.ensureWritable();
    const url = new URL(`https://www.googleapis.com/${upload ? "upload/" : ""}drive/v3/${path}`);
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("fields", DRIVE_FILE_FIELDS);
    if (upload) url.searchParams.set("uploadType", upload);
    return metadata(await this.withAuthorization(async () => requestJson(this.request, this.service, url, { method, signal, body, headers: {
      Authorization: `Bearer ${await this.accessToken(signal)}`, "Content-Type": contentType,
      ...(resource?.key ? { "X-Goog-Drive-Resource-Keys": `${resource.id}/${resource.key}` } : {})
    } })));
  }

  async create(input: { kind: "text" | "folder" | "document" | "spreadsheet" | "presentation"; name: string; folder_id?: string; resource_key?: string; content?: string }, createKey: string, signal?: AbortSignal) {
    await this.ensureWritable();
    // App-private key makes repeated creation in the same turn discoverable after an uncertain response.
    const existing = await this.list({ query: `appProperties has { key='zigentCreateKey' and value='${createKey}' }`, limit: 2 }, signal);
    if (existing.incomplete_search || existing.next_page_token || existing.files.length > 1) throw new Error("Google Drive: creation lookup is ambiguous; inspect current files before retrying");
    if (existing.files[0]) return { status: "already_created", file: existing.files[0] };
    const mimeType = input.kind === "text" ? "text/plain" : `application/vnd.google-apps.${input.kind}`;
    const properties = { name: input.name, mimeType, ...(input.folder_id ? { parents: [input.folder_id] } : {}), appProperties: { zigentCreateKey: createKey } };
    const resource = input.folder_id ? { id: input.folder_id, key: input.resource_key } : undefined;
    if (input.kind !== "text") return { status: "created", file: await this.write("files", JSON.stringify(properties), "application/json", "POST", signal, resource) };
    const boundary = `zigent_${randomUUID()}`;
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(properties)}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${input.content ?? ""}\r\n--${boundary}--\r\n`;
    return { status: "created", file: await this.write("files", body, `multipart/related; boundary=${boundary}`, "POST", signal, resource, "multipart") };
  }

  async rename(id: string, name: string, expectedName: string, signal?: AbortSignal, resourceKey?: string) {
    await this.ensureWritable();
    const current = await this.file(id, signal, resourceKey);
    if (current.name !== expectedName) throw new Error("Google Drive: file name changed; read it again before editing");
    return { status: "updated", file: await this.write(`files/${encodeURIComponent(id)}`, JSON.stringify({ name }), "application/json", "PATCH", signal, { id, key: resourceKey }),
      concurrency: "Name checked immediately before update; concurrent renames can occur between the check and write." };
  }

  async updateText(id: string, content: string, expectedContent: string, signal?: AbortSignal, resourceKey?: string) {
    await this.ensureWritable();
    const current = await this.read(id, 0, DRIVE_TEXT_MAX_BYTES, signal, resourceKey);
    if (!("content_scope" in current) || current.content_scope !== "file_text") throw new Error("Google Drive: use native document editing for Google files; only supported UTF-8 text files can be overwritten");
    if (current.content !== expectedContent) throw new Error("Google Drive: file content changed; read it again before editing");
    return { status: "updated", file: await this.write(`files/${encodeURIComponent(id)}`, content, `${current.file.mimeType}; charset=UTF-8`, "PATCH", signal, { id, key: resourceKey }, "media"),
      concurrency: "Content checked immediately before upload; Drive media updates do not provide an atomic content comparison." };
  }

  async read(id: string, offset: number, limit: number, signal?: AbortSignal, resourceKey?: string) {
    const file = await this.file(id, signal, resourceKey);
    const mimeType = file.mimeType as string;
    const exportType = Object.hasOwn(EXPORT_TYPES, mimeType) ? EXPORT_TYPES[mimeType] : undefined;
    const textType = mimeType.startsWith("text/") || ["application/json", "application/xml", "application/yaml", "application/x-yaml", "application/javascript"].includes(mimeType);
    if (!exportType && !textType) return { status: "unsupported_type", file, message: "Content has not been read. This reader supports Google Docs/Slides text, Sheets first-sheet CSV and UTF-8 text files. For folders use list_files with folder_id; for shortcuts use the returned targetId and targetResourceKey. PDF, Office, image, video and other binary formats require a separate parser." };
    if (file.capabilities.canDownload === false) return { status: "access_denied", file, message: "The account cannot download/export this file. No content was read." };
    if (Number(file.size) > DRIVE_TEXT_MAX_BYTES) return { status: "too_large", file, message: "Content has not been read; this reader is limited to 1 MiB of UTF-8 text." };
    const path = `files/${encodeURIComponent(id)}${exportType ? "/export" : ""}`;
    const content = await this.get(path, exportType ? { mimeType: exportType.mimeType } : { alt: "media", supportsAllDrives: "true" }, true, signal, { id, key: resourceKey });
    const characters = Array.from(content as string);
    return { status: "read", file, content: characters.slice(offset, offset + limit).join(""), content_scope: exportType?.scope ?? "file_text",
      content_mime_type: exportType?.mimeType ?? mimeType, offset, total_characters: characters.length, next_offset: offset + limit < characters.length ? offset + limit : null,
      ...(exportType?.scope === "first_sheet_only" ? { limitation: "Only the first sheet was exported. Other tabs, formatting, formulas and comments have not been read." } : {}) };
  }
}
