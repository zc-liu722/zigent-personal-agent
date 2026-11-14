import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Read-only access to the running service's own log files.
 *
 * The log directory is written by the service supervisor and is not readable by
 * execution identities. Reading happens inside the service process, so the
 * filesystem permission model is untouched: an Agent can only ever reach the
 * files named after its own configured id, because the id comes from the
 * process configuration and never from the request.
 */

export type LogStream = "out" | "err";

export type LogFile = {
  stream: LogStream;
  name: string;
  bytes: number;
  modifiedAt: string;
  lines: string[];
  truncated: boolean;
  error?: string;
};

export type OwnLogs = {
  agentId: string;
  directory: string;
  requestedLines: number;
  files: LogFile[];
};

const STREAMS: LogStream[] = ["out", "err"];
const DEFAULT_LINES = 200;
const MAX_LINES = 2_000;
const MAX_BYTES = 1_048_576;

/** Resolve the log directory next to the production agent manifest. */
export function logDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const manifest = resolve(environment.AGENTS_CONFIG_PATH ?? "config/agents.json");
  return join(dirname(manifest), "logs");
}

export function clampLines(value: string | null): number {
  if (!value) return DEFAULT_LINES;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LINES;
  return Math.min(parsed, MAX_LINES);
}

/**
 * Read the trailing lines of one file. Only the tail window is read, so a large
 * log never gets loaded whole and never blocks the event loop for long.
 */
function tailFile(path: string, limit: number): { lines: string[]; truncated: boolean; bytes: number } {
  const size = statSync(path).size;
  if (size === 0) return { lines: [], truncated: false, bytes: 0 };
  const window = Math.min(size, MAX_BYTES);
  const buffer = Buffer.alloc(window);
  const handle = openSync(path, "r");
  try { readSync(handle, buffer, 0, window, size - window); } finally { closeSync(handle); }
  const text = buffer.toString("utf8");
  const rows = text.split(/\r?\n/);
  // A partial first line is dropped when the window does not reach the start.
  if (window < size) rows.shift();
  while (rows.length && rows[rows.length - 1] === "") rows.pop();
  const truncated = rows.length > limit || window < size;
  return { lines: rows.slice(-limit), truncated, bytes: size };
}

/** Rotated companions keep the same stem, so they are listed but never used as the tail source. */
function rotatedNames(directory: string, agentId: string, stream: LogStream): string[] {
  const prefix = `${agentId}.${stream}`;
  try {
    return readdirSync(directory)
      .filter(name => name.startsWith(prefix) && name !== `${prefix}.log` && name.endsWith(".log"))
      .slice(0, 5);
  } catch { return []; }
}

/**
 * Tail the log files of the given Agent only. The caller must supply the
 * process's configured Agent id; nothing here accepts an Agent selector.
 */
export function readOwnLogs(agentId: string, requestedLines: number,
  environment: NodeJS.ProcessEnv = process.env): OwnLogs {
  const directory = logDirectory(environment);
  const files: LogFile[] = STREAMS.map(stream => {
    const name = `${agentId}.${stream}.log`;
    const path = join(directory, name);
    try {
      const info = statSync(path);
      const tail = tailFile(path, requestedLines);
      return { stream, name, bytes: tail.bytes, modifiedAt: info.mtime.toISOString(),
        lines: tail.lines, truncated: tail.truncated || rotatedNames(directory, agentId, stream).length > 0 };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown";
      return { stream, name, bytes: 0, modifiedAt: "", lines: [], truncated: false,
        error: code === "ENOENT" ? "not_found" : code };
    }
  });
  return { agentId, directory, requestedLines, files };
}
