import type { IncomingMessage, ServerResponse } from "node:http";
import { ZodError } from "zod";
import { DocumentReader } from "../../capabilities/documents/reader.js";
import { readDocumentText } from "../../capabilities/documents/text.js";
import type { FileWorkbench } from "../../file-workbench/service.js";
import { CodePointText } from "../../text/code-points.js";
import { data, json } from "../../web/http.js";
import { workspacePath } from "../../workspaces/paths.js";
import { isProjectMcpTool, maxBinaryReadLimit, maxReadBytes, maxRequestBytes, maxTextReadLimit, maxWriteBytes, projectMcpCall,
  projectMcpTokenHeader, projectMcpTools, type ProjectMcpInput, type ProjectMcpTool } from "./contracts.js";
import { projectMcpAuthorized } from "./credential.js";
import { reservedProjectPath } from "./reserved-path.js";

const visiblePath = (path: string) => !reservedProjectPath(path);
class ProjectFileError extends Error {}

function projectPath(path: string, directory: boolean) {
  const normalized = workspacePath(path, directory);
  if (reservedProjectPath(normalized)) throw new ProjectFileError("This path is reserved.");
  return normalized;
}

function message(error: unknown) {
  if (error instanceof ZodError) return "Invalid project operation arguments.";
  if (error instanceof ProjectFileError) return error.message;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return "The project file or directory does not exist.";
  if (error instanceof Error) {
    if (/文件版本已变化|目标文件已存在/.test(error.message)) return "The file has changed or already exists. Read its current sha256 before updating.";
    if (/运行或等待结果同步|执行权限尚未就绪|尚未就绪|持久工作区/.test(error.message)) return "The workspace is busy or unavailable. Retry after the current operation finishes.";
    if (/工作区不存在或无权访问|只允许访问持久项目/.test(error.message)) return "The persistent project is unavailable for this Agent.";
    if (/唯一匹配|互相重叠/.test(error.message)) return "Each oldText must occur exactly once, and edits must not overlap.";
    if (/普通文件|大小限制/.test(error.message)) return "The file exceeds the size limit or is not an ordinary file.";
    if (/文件路径无效|相对路径|路径已重定向/.test(error.message)) return "Use an ordinary path within the project.";
    if (/^DOCUMENT_/.test(error.message)) return "Document text could not be extracted. Try a smaller PDF page range or read the original bytes.";
  }
  return "The project operation could not be completed.";
}

export function createProjectWorkspaceRoute(service: FileWorkbench, credentialFile: string, log: (message: string) => void = console.warn) {
  const documents = new DocumentReader();
  const files = service.files;
  const agent = service.config.id;

  async function read(input: ProjectMcpInput<"read_file">, path: string) {
    const limit = input.limit;
    if (input.encoding !== "base64" && limit > maxTextReadLimit) throw new ProjectFileError("A text page can contain at most 24000 characters.");
    if (input.encoding === "base64") {
      const page = await files.readFileRange(input.workspaceId, path, input.offset, Math.min(limit, maxBinaryReadLimit), maxReadBytes);
      if (input.expectedHash && input.expectedHash !== page.sha256) throw new ProjectFileError("The file changed. Restart at offset 0.");
      const end = Math.min(page.size, input.offset + limit);
      return { workspaceId: input.workspaceId, path: page.path, name: page.name, mime: page.mime, size: page.size, sha256: page.sha256,
        offset: input.offset, encoding: "base64" as const, content: page.bytes.toString("base64"), nextOffset: end < page.size ? end : null };
    }
    const { bytes, ...info } = await files.readFileBytes(input.workspaceId, path, maxReadBytes);
    if (input.expectedHash && input.expectedHash !== info.sha256) throw new ProjectFileError("The file changed. Restart at offset 0.");
    const metadata = { workspaceId: input.workspaceId, ...info, offset: input.offset };
    if (/\.(pdf|docx)$/i.test(path)) {
      const start = input.pageStart ?? 1;
      const range = /\.pdf$/i.test(path) ? { from: start, to: start + 4 } : undefined;
      const document = await documents.read(path, info.sha256, bytes, range, AbortSignal.timeout(30_000));
      const text = readDocumentText(document, { offset: input.offset, limit, sectionSeparators: false })!;
      return { ...metadata, encoding: "text", content: text.content, nextOffset: text.next_offset,
        pageStart: document.indexedFrom, pageEnd: document.indexedTo, totalPages: document.totalPages,
        nextPageStart: document.totalPages && document.indexedTo && document.indexedTo < document.totalPages ? document.indexedTo + 1 : null,
        truncated: document.truncated, warnings: document.warnings };
    }
    let value: string;
    try { value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new ProjectFileError("This file is binary. Use encoding=base64."); }
    if (value.includes("\0")) throw new ProjectFileError("This file is binary. Use encoding=base64.");
    const text = new CodePointText(value);
    const end = Math.min(text.length, input.offset + limit);
    return { ...metadata, encoding: "text", content: text.slice(input.offset, end), nextOffset: end < text.length ? end : null };
  }

  async function execute(tool: ProjectMcpTool, args: unknown) {
    if (tool === "list_projects") {
      const { offset, limit } = projectMcpTools.list_projects.input.parse(args);
      try { await service.registeredWorkspaces(); }
      catch (error) {
        const detail = (error instanceof Error ? error.message : "unavailable").replace(/[\r\n]+/g, " ").slice(0, 200);
        log(`PROJECT_MCP_LIST_REFRESH_FAILED agent=${agent} ${detail}`);
      }
      const workspaces = files.listWorkspaces();
      return { agent, projects: workspaces.slice(offset, offset + limit),
        nextOffset: offset + limit < workspaces.length ? offset + limit : null };
    }
    switch (tool) {
      case "list_files": {
        const input = projectMcpTools.list_files.input.parse(args);
        const path = await prepare(input, true, true);
        return files.listFiles(input.workspaceId, path, input.offset, input.limit, visiblePath);
      }
      case "search_files": {
        const input = projectMcpTools.search_files.input.parse(args);
        const path = await prepare(input, true, true);
        return files.searchFiles(input.workspaceId, input.query, { path, limit: input.limit, includeContent: input.includeContent,
          allowPath: visiblePath, signal: AbortSignal.timeout(25_000) });
      }
      case "read_file": {
        const input = projectMcpTools.read_file.input.parse(args);
        return read(input, await prepare(input, true));
      }
      case "write_file": {
        const input = projectMcpTools.write_file.input.parse(args);
        const { encoding, content } = input;
        const bytes = Buffer.from(content, encoding === "base64" ? "base64" : "utf8");
        if (encoding === "base64" && bytes.toString("base64") !== content) throw new ProjectFileError("Provide standard padded base64.");
        if (bytes.length > maxWriteBytes) throw new ProjectFileError("A write can contain at most 4 MiB.");
        return files.writeFile(input.workspaceId, await prepare(input, false), bytes, input.expectedHash);
      }
      case "patch_file": {
        const input = projectMcpTools.patch_file.input.parse(args);
        return files.patchFile(input.workspaceId, await prepare(input, false), input.edits, input.expectedHash, maxWriteBytes);
      }
    }
  }

  async function prepare(input: { agent: string; workspaceId: string; path: string }, readOnly: boolean, directory = false) {
    if (input.agent !== agent) throw new ProjectFileError("The workspace belongs to another Agent.");
    files.assertPersistentProject(input.workspaceId);
    const path = projectPath(input.path, directory);
    if (!readOnly) await service.assertEditable(input.workspaceId);
    else if (!await service.execution.ensureSharedWorkspace(input.workspaceId) && service.execution.hasPendingWorkspace(input.workspaceId))
      throw new ProjectFileError("The workspace is waiting for file synchronization.");
    return path;
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") { res.setHeader("Allow", "POST"); json(res, 405, { error: "Method not allowed." }); return; }
    const credential = req.headers[projectMcpTokenHeader];
    if (typeof credential !== "string" || !await projectMcpAuthorized(credentialFile, credential)) {
      json(res, 401, { error: "Project access is unauthorized." }); return;
    }
    try {
      const { tool, input } = projectMcpCall.parse(await data(req, maxRequestBytes));
      if (!isProjectMcpTool(tool)) { json(res, 400, { error: "Unknown project operation." }); return; }
      json(res, 200, { result: await execute(tool, input) });
    } catch (error) {
      json(res, 409, { error: message(error) });
    }
  };
}
