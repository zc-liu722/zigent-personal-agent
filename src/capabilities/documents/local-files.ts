import { isAbsolute, parse, resolve } from "node:path";
import { documentMime, documentName } from "./files.js";

/** Explicit imports never traverse credentials, application runtime or linked files. */
export function importablePath(input: string): string {
  if (!isAbsolute(input) || input.length > 1024 || process.platform === "win32" && !/^[a-z]:[\\/]/i.test(input) || /[\x00-\x1f]/.test(input)) throw new Error("请提供服务器上的完整文件路径。");
  const path = resolve(input), normalized = path.replaceAll("\\", "/");
  if (process.platform === "win32" && normalized.slice(3).split("/").some(part => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
    throw new Error("请选择普通文档的完整路径。");
  if (/[<>:"|?*]/.test(path.slice(parse(path).root.length)) || !documentMime(documentName(path)) || /^(?:d:\/zigent(?:\/|$)|f:\/zigent-project-spaces(?:\/|$)|f:\/zigent-claude-workspace(?:\/|$))/i.test(normalized)
    || normalized.split("/").some(part => part.startsWith(".") || /^(?:windows|programdata|appdata|node_modules|credentials?|secrets?|tokens?|auth)(?:\.|$)/i.test(part)))
    throw new Error("此路径不提供文档导入，请上传所需的 PDF、DOCX 或文本文件。");
  return path;
}

