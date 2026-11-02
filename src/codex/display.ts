import { displaySchema, type CodexDisplay } from "./types.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const sensitive = /(?:^|[\s/'"=])(?:\.env(?:\.[\w.-]+)?|auth\.json|credentials?(?:\.\w+)?|codex-worker\.(?:json|sqlite)|id_rsa|id_ed25519)(?:$|[\s/'";])/i;
/** Redact at both the device and broker boundary, before persistence or rendering. */
export function displayText(value: string, secrets: readonly string[] = []): string {
  let text = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  for (const secret of secrets) if (secret) text = text.split(secret).join("[已隐藏]");
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[已隐藏私钥]")
    .replace(/\b(?:Bearer\s+\S+|sk-[\w-]{16,}|gh[pousr]_[\w]{16,}|ya29\.[\w.-]+|xox[baprs]-[\w-]+)/gi, "[已隐藏凭据]")
    .replace(/((?:["']?)(?:[\w-]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)[\w-]*)(?:["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}\n]+)/gi, "$1[已隐藏]")
    .replace(/https?:\/\/[^\s<>"']+/g, raw => { try { const u = new URL(raw); u.username = ""; u.password = ""; if (u.search) u.search = "?redacted"; u.hash = ""; return u.toString(); } catch { return "[链接]"; } });
}
export function safeDisplay(value: CodexDisplay, secrets: readonly string[] = []): CodexDisplay {
  const hidden = value.kind === "command" && sensitive.test(value.text ?? "");
  return displaySchema.parse({ ...value, title: displayText(value.title, secrets).slice(0, 200),
    ...(value.text !== undefined ? { text: hidden ? "[已隐藏凭据相关命令]" : displayText(value.text, secrets).slice(0, 8000) } : {}),
    ...(value.output !== undefined ? { output: hidden ? "[已隐藏凭据相关输出]" : displayText(value.output, secrets).slice(0, 12000) } : {}),
    ...(value.cwd ? { cwd: displayText(value.cwd, secrets).slice(0, 1024) } : {}) });
}
/** Explicit projection excludes reasoning, user prompts, server requests and raw protocol objects. */
export function itemDisplay(raw: unknown, completed: boolean): CodexDisplay | undefined {
  const item = record(raw), itemId = String(item.id ?? "").slice(0, 160);
  if (!itemId) return;
  const status = !completed ? "started" : ["failed", "declined"].includes(String(item.status)) ? "failed" : "completed";
  const stringify = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v ?? "")).slice(0, 12000);
  if (item.type === "agentMessage") {
    const text = String(item.text ?? "");
    return { itemId, kind: "message", title: "Codex", status, text: text.slice(0, 8000) };
  }
  if (item.type === "commandExecution") return { itemId, kind: "command", title: "执行命令", status, text: String(item.command ?? "").slice(0, 8000),
    cwd: String(item.cwd ?? "").slice(0, 1024), output: String(item.aggregatedOutput ?? "").slice(0, 12000), ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}) };
  if (item.type === "fileChange") return { itemId, kind: "file", title: "文件变更", status,
    text: (Array.isArray(item.changes) ? item.changes.map(record).map(change => String(change.path ?? "")) : []).join("\n").slice(0, 8000),
    output: (Array.isArray(item.changes) ? item.changes.map(record).map(change => sensitive.test(String(change.path ?? "")) ? "[已隐藏凭据文件变更]" : String(change.diff ?? "")) : []).join("\n").slice(0, 12000) };
  if (["mcpToolCall", "dynamicToolCall", "webSearch"].includes(String(item.type))) return { itemId, kind: "tool", status,
    title: String(item.tool ?? (item.type === "webSearch" ? "搜索" : "工具调用")).slice(0, 200),
    text: stringify(item.arguments ?? item.action ?? item.query).slice(0, 8000), output: stringify(item.result ?? item.contentItems ?? item.error) };
}
