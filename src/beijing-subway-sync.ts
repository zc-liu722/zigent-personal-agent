import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { imageMime, readSnapshot, subwayNeedsRefresh, syncSubway } from "./transit/beijing-subway.js";

const directory = process.argv[2];
if (!directory || process.argv.length > 4 || (process.argv[3] && process.argv[3] !== "--if-stale")) throw new Error("Usage: node dist/beijing-subway-sync.js <cache-directory> [--if-stale]");
const existing = await readSnapshot(resolve(directory));
if (process.argv[3] === "--if-stale" && !subwayNeedsRefresh(existing)) {
  console.info(`SUBWAY_SYNC reused=true checked_at=${existing!.checkedAt}`);
  process.exit(0);
}
function isTransportFailure(error: unknown): boolean {
  const codes = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"]);
  let cause = error;
  for (let depth = 0; depth < 6 && cause && typeof cause === "object"; depth++) {
    const current = cause as { code?: unknown; name?: unknown; cause?: unknown };
    if ((typeof current.code === "string" && codes.has(current.code)) || current.name === "TimeoutError") return true;
    cause = current.cause;
  }
  return false;
}

let snapshot;
try {
  snapshot = await syncSubway(resolve(directory), { onProgress: message => console.info(message) });
} catch (error) {
  // A public source outage must not discard a complete, unchanged local mirror.
  // Explicit refreshes, partial updates and data/logic failures still fail.
  const checkedAt = Date.parse(existing?.checkedAt ?? "");
  if (process.argv[3] !== "--if-stale" || !isTransportFailure(error) || !existing || existing.failures.length ||
      existing.records.length < 300 || !Number.isFinite(checkedAt) || checkedAt > Date.now() ||
      !existing.records.some(record => record.tables.length) ||
      JSON.stringify(await readSnapshot(resolve(directory))) !== JSON.stringify(existing)) throw error;
  const images = new Map(existing.records.flatMap(record => record.tables.map(table => [table.hash, table] as const)));
  for (const [hash, table] of images) {
    const path = join(resolve(directory), "images", hash);
    const info = await lstat(path);
    if (!info.isFile() || info.size < 1 || info.size > 12 * 1024 * 1024) throw new Error("Retained subway image is missing or invalid");
    const bytes = await readFile(path);
    if (bytes.length !== info.size || createHash("sha256").update(bytes).digest("hex") !== hash || imageMime(bytes) !== table.mimeType) throw new Error("Retained subway image failed integrity verification");
  }
  if (JSON.stringify(await readSnapshot(resolve(directory))) !== JSON.stringify(existing)) throw new Error("Retained subway snapshot changed during verification");
  console.warn(`SUBWAY_SYNC retained=true refresh_failed=true checked_at=${existing.checkedAt} records=${existing.records.length} images_verified=${images.size}`);
  process.exit(0);
}
console.info(`SUBWAY_SYNC checked_at=${snapshot.checkedAt} records=${snapshot.records.length} tables=${snapshot.records.reduce((n, r) => n + r.tables.length, 0)} failed=${snapshot.failures.length}`);
if (snapshot.failures.length) {
  console.warn(`SUBWAY_SYNC_FAILED records=${JSON.stringify(snapshot.failures.slice(0, 20))}`);
  process.exitCode = 1;
}
