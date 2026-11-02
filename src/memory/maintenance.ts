import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MarkdownMemoryStore, readMarkdownMemory, type MarkdownMemoryState } from "./markdown-store.js";

export async function verifyMemoryManifest(manifestPath: string) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!Array.isArray(manifest.agents) || !manifest.agents.length) throw new Error("MEMORY_MANIFEST_INVALID");
  for (const agent of manifest.agents) {
    if (typeof agent.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(agent.id) || typeof agent.storage?.longTermMemory !== "string") throw new Error("MEMORY_MANIFEST_INVALID");
    const { state } = await readMarkdownMemory(resolve(agent.storage.longTermMemory), agent.id);
    const users = Object.values(state.users), archives = users.reduce((sum, user) => sum + user.archives.length, 0);
    console.info(`MEMORY_MARKDOWN agent=${agent.id} operation=verify users=${users.length} archives=${archives} format=markdown-v1`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [operation, path, agentId, source, expected] = process.argv.slice(2);
    if (operation === "verify" && path) {
      await verifyMemoryManifest(path);
    } else if (operation === "promote" && path && agentId && source && expected) {
      const state = JSON.parse(await readFile(source, "utf8")) as MarkdownMemoryState;
      console.info(await new MarkdownMemoryStore(path, agentId).commit(state, expected));
    } else if (operation === "restore" && path && agentId && source && expected) {
      await new MarkdownMemoryStore(path, agentId).restore(expected, source);
    } else throw new Error("MEMORY_MAINTENANCE_USAGE_INVALID");
  } catch (error) {
    // Parse and OS errors can include private bodies or paths: log fixed categories only.
    const message = (error as Error).message;
    console.error(/^MEMORY_[A-Z_]+$/.test(message) ? message : "MEMORY_MAINTENANCE_FAILED");
    process.exitCode = 1;
  }
}
