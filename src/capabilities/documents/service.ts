import sharp from "sharp";
import type { AgentConfig } from "../../config.js";
import type { ModelGateway } from "../../llm.js";
import type { ToolExecutionContext } from "../../tools/tool-contracts.js";
import type { ProjectSpaceFiles } from "../../project-spaces/files.js";
import { spaces, relativePath } from "../../project-spaces/policy.js";
import { DocumentReader, decodeDocument } from "./reader.js";
import { passages, rankPassages, SemanticSearch, type Passage, type SearchMode } from "./search.js";
import { documentMime } from "./files.js";
import { documentMutationSchema, editText, isDocumentMutation, textBytes, type DocumentMutation } from "./text-edit.js";
import { ProjectFileWriter, serializeFileMutation } from "../../project-spaces/mutations.js";
import { textFileDiff, withFileDiff } from '../../file-diff.js';

export type DocumentSource = { id?: string; path?: string; project?: string };
export type DocumentInput = DocumentMutation | { action: "list" | "read" | "view" | "search" | "import_file"; source?: DocumentSource; path?: string;
  all?: boolean; snapshot?: string; query?: string; mode?: SearchMode; offset?: number; limit?: number; heading?: string;
  pageStart?: number; pageEnd?: number; pages?: number[]; imageNumbers?: number[] };

export class DocumentCapability {
  private readonly reader = new DocumentReader();
  private readonly semantic: SemanticSearch;
  private readonly results = new Map<string, { at: number; items: Passage[]; metadata: Record<string, unknown> }>();
  constructor(readonly options: { agentId: string; ownerUserId: string }, model: ModelGateway, private readonly projects?: ProjectSpaceFiles) {
    this.semantic = new SemanticSearch(model);
  }
  static fromConfig(config: AgentConfig, model: ModelGateway, projects?: ProjectSpaceFiles) {
    return config.allowedTools.includes("documents") && config.web?.ownerUserId
      ? new DocumentCapability({ agentId: config.id, ownerUserId: config.web.ownerUserId }, model, projects) : undefined;
  }
  get fileOperations(): readonly string[] { return this.projects ? ["create_text", "edit_text", "move_file"] : []; }
  canAccess(context: ToolExecutionContext) {
    return context.agentId === this.options.agentId && context.userId === this.options.ownerUserId && context.conversationKind === "p2p"
      && Boolean(context.conversationId && context.sessionId && context.documentLibrary) && !context.taskRunId && !context.backgroundTaskKind && !context.signal?.aborted;
  }
  private async project(context: ToolExecutionContext, source?: DocumentSource) {
    if (!source || source.id || !this.projects?.canAccess(context)) return undefined;
    if (source.project) return { project: source.project, path: source.path };
    if (!source.path) return undefined;
    const value = source.path.replaceAll("\\", "/");
    for (const space of await spaces(context.agentId)) for (const root of [space.windows, space.mac, space.linux]) {
      if (!root) continue;
      const prefix = root.replaceAll("\\", "/").replace(/\/$/, "");
      const windows = /^[a-z]:\//i.test(prefix), test = windows ? value.toLowerCase() : value, base = windows ? prefix.toLowerCase() : prefix;
      if (test === base) return { project: space.id, path: undefined };
      if (test.startsWith(base + "/")) return { project: space.id, path: relativePath.parse(value.slice(prefix.length + 1)) };
    }
    return undefined;
  }
  private async mutate(context: ToolExecutionContext, input: DocumentMutation): Promise<unknown> {
    const assertAccess = () => {
      if (!this.canAccess(context) || !this.projects?.canAccess(context)) throw new Error("文件操作仅供所有者在已授权项目的私聊中使用。");
    };
    assertAccess();
    const writer = new ProjectFileWriter(context.agentId, assertAccess), library = context.documentLibrary!;
    if (input.action === "create_text") {
      if (!documentMime(input.destination.path)?.startsWith("text/")) throw new Error("请选择 .md、.txt 等 UTF-8 文字文件名。");
      const saved = await writer.create(input.destination.project, input.destination.path, textBytes(input.content), true);
      return { status: "created", source: saved, sync: "pending", message: "已保存到项目目录；跨设备同步由项目同步服务处理。" };
    }
    const project = await this.project(context, input.source);
    if (project) {
      if (!project.path) throw new Error("请选择具体项目文件。");
      if (input.action === "move_file") return writer.move(project.project, project.path, input.expected_sha256, input.destination);
      const source = await writer.read(project.project, project.path, input.expected_sha256);
      if (!documentMime(project.path)?.startsWith("text/")) throw new Error("仅支持编辑 UTF-8 文字文件。");
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(source.bytes);
      const saved = await writer.replace(project.project, project.path, input.expected_sha256, editText(text, input), true);
      return { status: "edited", source: saved, sync: "pending" };
    }
    if (!input.source.id) throw new Error("路径尚未授权，请选择已分享的附件或已登记项目文件。");
    const id = input.source.id, metadata = library.metadata(id);
    if (metadata.movedTo) {
      if (input.action === "move_file" && metadata.movedTo.project === input.destination.project && metadata.movedTo.path === input.destination.path
        && metadata.sha256 === input.expected_sha256) {
        await writer.read(metadata.movedTo.project, metadata.movedTo.path, metadata.movedTo.sha256);
        return { status: "moved", destination: metadata.movedTo };
      }
      return { status: "source_moved", destination: metadata.movedTo, message: "附件已归档，请使用项目中的当前文件继续操作；本次未执行新修改。" };
    }
    if (metadata.sha256 !== input.expected_sha256) return { status: "snapshot_changed", source: { id, name: metadata.name }, snapshot: metadata.sha256 };
    const source = await library.read(id);
    if (source.sha256 !== input.expected_sha256) throw new Error("文档版本已变化，请重新读取。");
    if (input.action === "edit_text") {
      if (!library.editText || !source.mime.startsWith("text/")) throw new Error("仅支持编辑 UTF-8 文字附件。");
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(source.bytes), bytes = editText(text, input);
      assertAccess();
      return { status: "edited", source: withFileDiff(library.editText(id, input.expected_sha256, bytes), textFileDiff(source.name, text, bytes.toString('utf8'))) };
    }
    if (!library.moveToProject) throw new Error("当前通道不支持附件归档。");
    if (documentMime(input.destination.path) !== documentMime(source.name)) throw new Error("请保留附件的文档格式；UTF-8 文字可在 .txt、.md 等文字扩展名之间调整。");
    const saved = await writer.create(input.destination.project, input.destination.path, source.bytes);
    try {
      await writer.read(saved.project, saved.path, saved.sha256);
      assertAccess();
      library.moveToProject(id, input.expected_sha256, saved);
    } catch {
      return { status: "move_incomplete", destination: saved, source: { id, name: source.name },
        message: "项目文件已保存，附件尚未完成归档；请核对版本后重试。" };
    }
    return { status: "moved", destination: saved, sync: "pending", message: "已移入项目；对话附件保留归档版本供历史追溯。" };
  }
  async query(context: ToolExecutionContext, input: DocumentInput): Promise<unknown> {
    if (!this.canAccess(context)) throw new Error("文档工具仅供文档所有者在私聊中使用。");
    if (isDocumentMutation(input)) return serializeFileMutation(context.agentId, () => this.mutate(context, documentMutationSchema.parse(input)));
    const library = context.documentLibrary!, offset = input.offset ?? 0;
    const limit = Math.min(input.limit ?? (input.action === "read" ? 12000 : 20), input.action === "read" ? 20000 : 100);
    if (input.action === "import_file") {
      if (!input.path) throw new Error("请选择具体文件。");
      return { status: "available", source: await library.importFile(input.path) };
    }
    const project = await this.project(context, input.source);
    if (project) {
      if ((input.action === "read" || input.action === "view") && !project.path) throw new Error("请选择具体文档文件。");
      return this.projects!.query(context, { ...input, action: input.action, ...project, pages: input.pages,
        imageNumbers: input.imageNumbers, offset, limit });
    }
    if (input.source?.path || input.source?.project) return { status: "access_required", path: input.source.path,
      message: "该路径尚未授权。可上传文件，或用 import_file 在网页确认导入服务器上的具体文档。" };
    const moved = input.source?.id ? library.metadata(input.source.id).movedTo : undefined;
    if (moved) return { status: "moved", destination: moved, message: "附件已归档，请通过 source={project,path} 读取项目中的当前文件。" };
    const listing = () => library.list(input.all, offset, limit + 1);
    if (input.action === "list") {
      const files = listing();
      return { files: files.slice(0, limit), next_offset: files.length > limit ? offset + limit : null,
        projects: this.projects?.canAccess(context) ? await this.projects.catalog(context) : [] };
    }
    if (input.action === "search") {
      if (!input.query?.trim()) throw new Error("请输入检索问题或关键词。");
      const selected = input.source?.id ? [library.metadata(input.source.id)] : library.list(input.all, 0, 201);
      const key = JSON.stringify([context.sessionId, selected.map(file => [file.id, file.sha256]), input.query, input.mode, context.model, context.reasoningEfforts]);
      for (const [id, value] of this.results) if (Date.now() - value.at > 600000) this.results.delete(id);
      let saved = this.results.get(key);
      if (!saved) {
        if (offset && input.mode === "semantic") return { status: "search_expired", message: "请从 offset=0 重新检索。" };
        const mode = input.mode ?? "literal", terms = mode === "semantic" ? [input.query, ...await this.semantic.expand(context, input.query)] : [input.query];
        let corpus: Passage[] = [], size = 0, characters = 0;
        const skipped: Array<{ id: string; reason: string }> = [], scanned: Array<Record<string, unknown>> = [];
        const started = Date.now();
        for (const file of selected.slice(0, 200)) {
          context.signal?.throwIfAborted();
          if (size + file.size > 128 * 1024 * 1024 || characters > 8_000_000 || corpus.length >= 12000 || Date.now() - started > 45000) {
            skipped.push({ id: file.id, reason: "SEARCH_BUDGET" }); continue;
          }
          try {
            const source = await library.read(file.id);
            const document = await this.reader.read(source.name, source.sha256, source.bytes, undefined, context.signal);
            size += source.size; characters += document.units.reduce((n, unit) => n + unit.text.length, 0);
            const imagePages = document.units.filter(unit => unit.needsImage).map(unit => unit.page).slice(0, 20);
            scanned.push({ id: file.id, name: file.name, sha256: file.sha256, truncated: document.truncated || Boolean(document.totalPages && document.indexedTo! < document.totalPages),
              totalPages: document.totalPages, indexedTo: document.indexedTo, imagePages });
            const found = passages(file.name, source.sha256, document, input.query, mode).map(item => ({ ...item, sourceId: file.id })), remaining = 12000 - corpus.length;
            if (found.length > remaining) skipped.push({ id: file.id, reason: "PASSAGE_LIMIT" });
            corpus.push(...found.slice(0, remaining));
          } catch { context.signal?.throwIfAborted(); skipped.push({ id: file.id, reason: "DOCUMENT_UNREADABLE" }); }
        }
        if (mode !== "literal") corpus = rankPassages(corpus, terms);
        if (mode === "semantic") corpus = await this.semantic.rerank(context, input.query, corpus.slice(0, 40));
        const omitted = Math.max(0, selected.length - 200);
        saved = { at: Date.now(), items: corpus, metadata: { mode, method: mode === "semantic" ? "model_expansion_and_reranking" : mode,
          coverage: { complete: !omitted && !skipped.length && !scanned.some(file => file.truncated || (file.imagePages as unknown[]).length),
            omittedAtLeast: omitted, scannedCount: scanned.length, scanned: scanned.slice(0, 20), skipped: skipped.slice(0, 20), skippedCount: skipped.length } } };
        // Only bounded semantic results need a stable continuation cache.
        if (mode === "semantic") { while (this.results.size >= 8) this.results.delete(this.results.keys().next().value!); this.results.set(key, saved); }
      }
      if (!this.canAccess(context)) throw new Error("文档读取已取消。");
      for (const item of saved.items) if (item.sourceId && library.metadata(item.sourceId).sha256 !== item.sha256) throw new Error("文档引用已失效，请重新查找。");
      return { ...saved.metadata, items: saved.items.slice(offset, offset + limit), total: saved.items.length,
        next_offset: offset + limit < saved.items.length ? offset + limit : null };
    }
    const id = input.source?.id ?? (library.list(false, 0, 2).length === 1 ? library.list(false, 0, 1)[0]!.id : undefined);
    if (!id) throw new Error("请先列出文档并选择文件引用。");
    const file = await library.read(id);
    if (input.snapshot && input.snapshot !== file.sha256) return { status: "snapshot_changed", source: { id, name: file.name }, snapshot: file.sha256 };
    if (input.action === "view") {
      const format = /\.pdf$/i.test(file.name) ? "pdf" : /\.docx$/i.test(file.name) ? "docx" : undefined;
      if (!format || format === "pdf" && !input.pages?.length || format === "docx" && !input.imageNumbers?.length) throw new Error("请指定 PDF 页码或 Word 内嵌图片编号。");
      const result = await decodeDocument(format, file.bytes, { action: "render", pages: input.pages, images: input.imageNumbers }, context.signal);
      if (!("pictures" in result)) throw new Error("DOCUMENT_PARSE_FAILED");
      const images = await Promise.all(result.pictures.map(async picture => ({
        data: await sharp(Buffer.from(picture.data), { limitInputPixels: 40_000_000 }).rotate().resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true }).png().toBuffer(),
        mimeType: "image/png" as const, sessionImageId: `document:${id}:${file.sha256}:${picture.page ? "page:" + picture.page : "image:" + picture.image}`
      })));
      context.signal?.throwIfAborted();
      if (!this.canAccess(context) || library.metadata(id).sha256 !== file.sha256) throw new Error("文档版本已变化，请重新读取。");
      return { kind: "view_session_images", imageIds: images.map(image => image.sessionImageId), images,
        metadata: { id, name: file.name, sha256: file.sha256, locations: result.pictures.map(({ page, image }) => ({ page, image })) } };
    }
    const range = /\.pdf$/i.test(file.name) ? { from: input.pageStart ?? 1, to: input.pageEnd ?? (input.pageStart ?? 1) + 4 } : undefined;
    try {
      const document = await this.reader.read(file.name, file.sha256, file.bytes, range, context.signal);
      let text = document.units.map(unit => unit.text).join("\n\n"), headingOffset = 0;
      if (input.heading) {
        const lines = text.split("\n"), start = lines.findIndex(line => line.trim() === input.heading!.trim());
        if (start < 0 || !/^#{1,6} /.test(lines[start]!)) throw new Error("未找到指定标题。");
        const level = /^#+/.exec(lines[start]!)![0].length;
        const next = lines.findIndex((line, index) => index > start && /^#{1,6} /.test(line) && /^#+/.exec(line)![0].length <= level);
        headingOffset = Array.from(lines.slice(0, start).join("\n")).length + (start ? 1 : 0);
        text = lines.slice(start, next < 0 ? undefined : next).join("\n");
      }
      const characters = Array.from(text), end = Math.min(characters.length, offset + limit);
      let position = 0;
      const sections = document.units.flatMap(unit => {
        const start = position; position += Array.from(unit.text).length + 2;
        return position >= headingOffset + offset && start < headingOffset + offset + limit
          ? [{ page: unit.page, paragraph: unit.paragraph, needsImage: unit.needsImage, offset: start }] : [];
      });
      context.signal?.throwIfAborted();
      if (!this.canAccess(context)) throw new Error("文档读取已取消。");
      const latest = library.metadata(id);
      if (latest.sha256 !== file.sha256) return { status: "snapshot_changed", source: { id, name: latest.name }, snapshot: latest.sha256 };
      return { source: { id, name: file.name }, snapshot: file.sha256, format: document.format,
        content: characters.slice(offset, end).join(""), total: characters.length, next_offset: end < characters.length ? end : null,
        totalPages: document.totalPages, pageStart: range?.from, pageEnd: document.indexedTo,
        next_page: document.totalPages && document.indexedTo! < document.totalPages ? document.indexedTo! + 1 : null,
        sections, images: document.images, truncated: document.truncated, warnings: document.warnings, location: document.location };
    } catch { context.signal?.throwIfAborted(); return { status: "unreadable", source: { id, name: file.name }, message: "文档暂时无法解析，请检查格式、加密和大小，或缩小 PDF 页范围。" }; }
  }
}
