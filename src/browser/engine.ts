import { readFileSync } from "node:fs";

/** The release preflight records the shared, versioned Chromium binary path. */
export function browserExecutable(): string | undefined {
  try {
    const value = JSON.parse(readFileSync(new URL("../../browser-runtime.json", import.meta.url), "utf8")) as { executablePath?: unknown };
    return typeof value.executablePath === "string" ? value.executablePath : undefined;
  } catch { return undefined; }
}
