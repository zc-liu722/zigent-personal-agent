import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { MemoryConflictError, validateMarkdown, type ArchiveMemory } from "./changes.js";
import { MemoryReadViews } from "./read-views.js";

export type MarkdownMemoryState = {
  agentId: string; agentSoul?: string; behaviorRules: string;
  users: Record<string, { content: string; archives: ArchiveMemory[] }>;
  receipts: Record<string, string>; extras: Record<string, unknown>;
};
type Metadata = {
  format: "markdown-v1"; agentId: string; soulPresent: boolean; sequence: number; previous?: string;
  users: { id: string; archives: string[] }[]; receipts: Record<string, string>; extras: Record<string, unknown>;
};
export type MarkdownMemoryRead = { state: MarkdownMemoryState; generation: string; metadata: Metadata };
const generationPattern = /^[a-f0-9]{32}$/;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const userDirectory = (id: string) => `users/${digest(id).slice(0, 24)}`;
const archiveFilename = (title: string) => `${title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 32).replace(/[. ]+$/, "") || "archive"}-${digest(title).slice(0, 12)}.md`;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

async function readGeneration(root: string, agentId: string, generation: string): Promise<MarkdownMemoryRead> {
  if (!generationPattern.test(generation)) throw new Error("MEMORY_GENERATION_INVALID");
  const directory = join(root, "generations", generation);
  const metadata = JSON.parse(await readFile(join(directory, "metadata.json"), "utf8")) as Metadata;
  if (metadata.format !== "markdown-v1" || metadata.agentId !== agentId || !Number.isInteger(metadata.sequence)
    || !Array.isArray(metadata.users) || typeof metadata.soulPresent !== "boolean" || !metadata.receipts || !metadata.extras)
    throw new Error("MEMORY_METADATA_INVALID");
  const state: MarkdownMemoryState = { agentId, agentSoul: metadata.soulPresent ? await readFile(join(directory, "agent-soul.md"), "utf8") : undefined,
    behaviorRules: await readFile(join(directory, "behavior-rules.md"), "utf8"), users: {}, receipts: metadata.receipts, extras: metadata.extras };
  for (const user of metadata.users) {
    if (typeof user.id !== "string" || Object.hasOwn(state.users, user.id) || !Array.isArray(user.archives)
      || user.archives.some(title => typeof title !== "string") || new Set(user.archives).size !== user.archives.length) throw new Error("MEMORY_USER_METADATA_INVALID");
    const base = join(directory, userDirectory(user.id));
    const archives = await Promise.all(user.archives.map(async title => ({ title, content: await readFile(join(base, "archives", archiveFilename(title)), "utf8") })));
    Object.defineProperty(state.users, user.id, { value: { content: await readFile(join(base, "long-term-memory.md"), "utf8"), archives }, enumerable: true, writable: true, configurable: true });
  }
  return { state, generation, metadata };
}
/** Strictly read-only: diagnostics must never initialize memory. */
export async function readMarkdownMemory(path: string, agentId: string): Promise<MarkdownMemoryRead> {
  const root = resolve(path);
  for (let attempt = 0; attempt < 3; attempt++) {
    const generation = (await readFile(join(root, "CURRENT"), "utf8")).trim();
    try {
      const result = await readGeneration(root, agentId, generation);
      if ((await readFile(join(root, "CURRENT"), "utf8")).trim() === generation) return result;
    } catch (error) {
      if (!missing(error)) throw error;
      if ((await readFile(join(root, "CURRENT"), "utf8")).trim() === generation) throw error;
    }
  }
  throw new MemoryConflictError("Memory changed during read; retry the read");
}
function validateState(state: MarkdownMemoryState) {
  validateMarkdown(state.behaviorRules);
  for (const user of Object.values(state.users)) {
    validateMarkdown(user.content);
    if (state.behaviorRules.length + user.content.length > 60_000 || user.archives.length > 200
      || user.archives.reduce((sum, item) => sum + item.content.length, 0) > 2_000_000 || new Set(user.archives.map(item => item.title)).size !== user.archives.length)
      throw new Error("MEMORY_CAPACITY_OR_ARCHIVE_TITLES_INVALID");
    for (const archive of user.archives) {
      if (!archive.title || archive.title.length > 100 || /[\r\n\x00-\x1f]/.test(archive.title)) throw new Error("MEMORY_ARCHIVE_TITLE_INVALID");
      validateMarkdown(archive.content, false);
    }
  }
}
export class MarkdownMemoryStore {
  readonly root: string;
  private cache?: { value: MarkdownMemoryRead; fingerprint: string };
  private readonly views = new WeakMap<MarkdownMemoryRead, MemoryReadViews>();
  constructor(path: string, readonly agentId: string) { this.root = resolve(path); }
  async initialize(): Promise<void> {
    try { await this.read(); return; }
    catch (error) { if (!missing(error)) throw error; }
    // A missing document in an existing generation is corruption, never an empty store.
    try { await readFile(join(this.root, "CURRENT")); throw new Error("MEMORY_CURRENT_INCOMPLETE"); }
    catch (error) { if (!missing(error)) throw error; }
    const entries = await readdir(join(this.root, "generations")).catch(error => { if (missing(error)) return []; throw error; });
    if (entries.length) throw new Error("MEMORY_MISSING_CURRENT_REQUIRES_RECOVERY");
    await this.commit({ agentId: this.agentId, agentSoul: undefined, behaviorRules: "", users: {}, receipts: {}, extras: {} });
  }
  private async fingerprint(value: MarkdownMemoryRead): Promise<string> {
    const directory = join(this.root, "generations", value.generation);
    const paths = ["metadata.json", "behavior-rules.md", ...(value.metadata.soulPresent ? ["agent-soul.md"] : []),
      ...value.metadata.users.flatMap(user => [`${userDirectory(user.id)}/long-term-memory.md`,
        ...user.archives.map(title => `${userDirectory(user.id)}/archives/${archiveFilename(title)}`)])];
    const versions = await Promise.all(paths.map(async path => {
      const value = await stat(join(directory, path), { bigint: true });
      return `${path}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
    }));
    return digest(versions.join("\n"));
  }
  /** A view is reused only after the same full-store freshness checks as read(). */
  private async readViews(): Promise<MemoryReadViews> {
    const value = await this.readVerified();
    let views = this.views.get(value);
    if (!views) { views = new MemoryReadViews(value.state); this.views.set(value, views); }
    return views;
  }
  async readContext(userId: string) { return (await this.readViews()).context(userId); }
  async readSnapshot(userId: string) { return (await this.readViews()).editableSnapshot(userId); }
  async readArchive(userId: string, title: string) { return (await this.readViews()).archive(userId, title); }
  async read(): Promise<MarkdownMemoryRead> { return structuredClone(await this.readVerified()); }

  /** Internal immutable ownership; every public read copies only its result. */
  private async readVerified(): Promise<MarkdownMemoryRead> {
    const current = () => readFile(join(this.root, "CURRENT"), "utf8").then(value => value.trim());
    try {
      const cached = this.cache;
      if (cached && await current() === cached.value.generation
        && await this.fingerprint(cached.value) === cached.fingerprint && await current() === cached.value.generation) {
        return cached.value;
      }
      this.cache = undefined;
      let value = await readMarkdownMemory(this.root, this.agentId);
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await this.fingerprint(value);
        const verified = await readMarkdownMemory(this.root, this.agentId);
        if (verified.generation === value.generation && before === await this.fingerprint(verified)
          && await current() === verified.generation) {
          this.cache = { value: verified, fingerprint: before };
          return verified;
        }
        value = verified;
      }
      throw new MemoryConflictError("Memory changed during read; retry the read");
    } catch (error) {
      this.cache = undefined;
      // Another writer may publish and clean the old generation between CURRENT
      // and stat. The uncached reader already handles that pointer race safely.
      if (missing(error)) return readMarkdownMemory(this.root, this.agentId);
      throw error;
    }
  }
  /** Maintenance only, with the service stopped; restore a complete retained snapshot. */
  async restore(expectedGeneration: string, target: string): Promise<void> {
    await readGeneration(this.root, this.agentId, target);
    if ((await this.read()).generation !== expectedGeneration) throw new MemoryConflictError();
    const temporary = join(this.root, `CURRENT.${randomUUID()}.tmp`);
    await writeFile(temporary, `${target}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, join(this.root, "CURRENT"));
    this.cache = undefined;
  }
  async commit(state: MarkdownMemoryState, expectedGeneration?: string): Promise<string> {
    if (state.agentId !== this.agentId) throw new Error("MEMORY_AGENT_MISMATCH");
    validateState(state);
    let prior: MarkdownMemoryRead | undefined;
    if (expectedGeneration) {
      prior = await this.read();
      if (prior.generation !== expectedGeneration) throw new MemoryConflictError();
    } else {
      try { await readFile(join(this.root, "CURRENT")); throw new MemoryConflictError(); }
      catch (error) { if (!missing(error)) throw error; }
    }
    const generation = randomUUID().replaceAll("-", ""), directory = join(this.root, "generations", generation);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata: Metadata = { format: "markdown-v1", agentId: this.agentId, soulPresent: state.agentSoul !== undefined,
      sequence: (prior?.metadata.sequence ?? 0) + 1, previous: prior?.generation,
      users: Object.entries(state.users).map(([id, user]) => ({ id, archives: user.archives.map(item => item.title) })),
      receipts: state.receipts, extras: state.extras };
    const files = new Map<string, string>([["behavior-rules.md", state.behaviorRules], ["metadata.json", JSON.stringify(metadata)]]);
    if (state.agentSoul !== undefined) files.set("agent-soul.md", state.agentSoul);
    for (const [id, user] of Object.entries(state.users)) {
      const base = userDirectory(id);
      files.set(`${base}/long-term-memory.md`, user.content);
      for (const archive of user.archives) files.set(`${base}/archives/${archiveFilename(archive.title)}`, archive.content);
    }
    for (const [path, content] of files) {
      const destination = join(directory, path);
      await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 });
      await writeFile(destination, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
    // Read every body back before publishing a single atomic generation pointer.
    if (!isDeepStrictEqual((await readGeneration(this.root, this.agentId, generation)).state, state)) throw new Error("MEMORY_WRITE_VERIFICATION_FAILED");
    const current = await readFile(join(this.root, "CURRENT"), "utf8").catch(error => { if (missing(error)) return undefined; throw error; });
    if (current?.trim() !== expectedGeneration) throw new MemoryConflictError();
    const temporary = join(this.root, `CURRENT.${generation}.tmp`);
    await writeFile(temporary, `${generation}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, join(this.root, "CURRENT"));
    this.cache = undefined;
    // Retain three complete generations for bounded storage and maintenance rollback.
    const retained = new Set([generation, prior?.generation, prior?.metadata.previous]);
    try {
      const obsolete = (await readdir(join(this.root, "generations"))).filter(name => generationPattern.test(name) && !retained.has(name));
      await Promise.all(obsolete.map(name => rm(join(this.root, "generations", name), { recursive: true, force: true })));
    } catch { /* Cleanup must never turn a committed save into an apparent failure. */ }
    return generation;
  }
}
