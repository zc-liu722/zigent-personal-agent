import { unzipSync } from "fflate";
import { sniffImageMimeType } from "../../media/image-mime.js";

const textTypes = new Set(["txt", "md", "csv", "tsv", "json", "jsonl", "xml", "html", "htm", "yaml", "yml", "toml", "ini", "log", "tex", "bib",
  "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "scss", "sql", "sh", "bash", "ps1", "bat", "cmd", "c", "h", "cpp", "hpp", "rs", "go", "java", "rb", "r", "ipynb", "vue", "svelte", "dockerfile"]);
const officeTypes: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  doc: "application/msword", ppt: "application/vnd.ms-powerpoint", xls: "application/vnd.ms-excel",
  odt: "application/vnd.oasis.opendocument.text", ods: "application/vnd.oasis.opendocument.spreadsheet", odp: "application/vnd.oasis.opendocument.presentation"
};
const extension = (name: string) => name.split(".").at(-1)!.toLowerCase();
const zipTypes = new Set(["docx", "pptx", "xlsx", "odt", "ods", "odp", "zip"]);
export function documentName(value: string): string {
  const name = value.replaceAll("\\", "/").split("/").at(-1)!.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!name || name.length > 240 || name === "." || name === ".." || /[<>:"|?*]/.test(name) || /[. ]$/.test(name)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error("文件名无效。");
  return name;
}
export function documentMime(name: string): string | undefined {
  const ext = extension(name);
  return ext === "pdf" ? "application/pdf" : officeTypes[ext] ?? (ext === "zip" ? "application/zip" : textTypes.has(ext) || name.toLowerCase() === "dockerfile" ? "text/plain; charset=utf-8" : undefined);
}
export function audioMime(name: string): string | undefined {
  return ({ mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", aac: "audio/aac", amr: "audio/amr" } as Record<string, string>)[extension(name)];
}
export function fileMime(bytes: Buffer, name?: string, complete = true): string | undefined {
  try {
    const audio = name ? audioMime(name) : undefined;
    if (audio) {
      const tag = bytes.subarray(0, 12);
      const valid = audio === "audio/wav" ? tag.subarray(0, 4).toString() === "RIFF" && tag.subarray(8, 12).toString() === "WAVE"
        : audio === "audio/mp4" ? tag.subarray(4, 8).toString() === "ftyp"
        : audio === "audio/ogg" ? tag.subarray(0, 4).toString() === "OggS"
        : audio === "audio/amr" ? bytes.subarray(0, 6).toString() === "#!AMR\n" || bytes.subarray(0, 9).toString() === "#!AMR-WB\n"
        : audio === "audio/mpeg" && tag.subarray(0, 3).toString() === "ID3" || (audio === "audio/mpeg" || audio === "audio/aac") && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
      return valid ? audio : undefined;
    }
    const ext = name ? extension(name) : "", mime = name ? documentMime(name) : undefined;
    if (!mime) return sniffImageMimeType(bytes);
    if (mime === "application/pdf") return bytes.subarray(0, 1024).includes(Buffer.from("%PDF-")) ? mime : undefined;
    if (zipTypes.has(ext)) {
      const header = bytes.subarray(0, 4);
      if (!header.equals(Buffer.from([80, 75, 3, 4])) && !(ext === "zip" && header.equals(Buffer.from([80, 75, 5, 6])))) return undefined;
      if (!complete) return mime;
      let count = 0, size = 0;
      const names = new Set<string>();
      unzipSync(bytes, { filter: file => {
        const path = file.name.replaceAll("\\", "/");
        if (++count > 15000 || !Number.isSafeInteger(file.originalSize) || file.originalSize < 0 || (size += file.originalSize) > 256 * 1024 * 1024) throw new Error("文件解压后过大。");
        if (path.startsWith("/") || /^[a-z]:/i.test(path) || path.split("/").some(part => part === "..") || /\0/.test(path) || names.has(path)) throw new Error("压缩包路径无效。");
        names.add(path); return false;
      } });
      if (ext === "zip") return mime;
      if (["odt", "ods", "odp"].includes(ext)) return names.has("mimetype") && names.has("content.xml") ? mime : undefined;
      const main = { docx: "word/document.xml", pptx: "ppt/presentation.xml", xlsx: "xl/workbook.xml" }[ext];
      return main && names.has(main) && names.has("[Content_Types].xml") && names.has("_rels/.rels") ? mime : undefined;
    }
    if (["doc", "xls", "ppt"].includes(ext)) {
      if (!bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return undefined;
      if (!complete) return mime;
      const streams = ext === "doc" ? ["WordDocument"] : ext === "xls" ? ["Workbook", "Book"] : ["PowerPoint Document"];
      return bytes.length >= 512 && streams.some(stream => bytes.includes(Buffer.from(stream + "\0", "utf16le"))) ? mime : undefined;
    }
    if (bytes.length > 8 * 1024 * 1024 && complete) throw new Error("文本文件不能超过 8 MB。");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: !complete });
    return text.includes("\0") ? undefined : mime;
  } catch { return undefined; }
}
export const fileLimit = (name?: string) => name && audioMime(name) ? 128 * 1024 * 1024 : name && documentMime(name)
  ? (documentMime(name)!.startsWith("text/") ? 8 : 128) * 1024 * 1024 : 10 * 1024 * 1024;
