import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";
import { unzipSync, zipSync } from "fflate";
import type { WorkspaceService } from "../workspaces/service.js";
import { ordinaryPath, snapshotFile, workspacePath } from "../workspaces/paths.js";

export const SNAPSHOT_MANIFEST = ".zigent-transfer-manifest.json";
export const PROJECT_METADATA = ".zigent-project-metadata.json";
export const MAX_SNAPSHOT_FILES = 100_000;
const METADATA_LIMIT = 16 * 1024 * 1024;
export type SnapshotManifest = {
  version: 1;
  archivePrefix?: "payload/";
  files: Array<{ path: string; sha256: string; size: number; mode: number }>;
  regenerable: string[];
  links: Array<{ path: string; target: string }>;
  directories: string[];
};
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export const snapshotRevision = (manifest: SnapshotManifest) => digest(Buffer.from(JSON.stringify({ files: manifest.files, links: manifest.links, directories: manifest.directories ?? [] })));

export function safeRelative(path: string, allowEmpty = false): string {
  if (allowEmpty && (path === "" || path === ".")) return "";
  if (typeof path !== "string" || path.length > 1000 || path.includes("\\")) throw new Error("Invalid workspace path");
  return workspacePath(path, false);
}
function safeLink(path: string, target: string) {
  safeRelative(path);
  if (typeof target !== "string" || !target || target.length > 1000 || target.startsWith("/") || /[\\\x00-\x1f\x7f]/.test(target)) throw new Error("Invalid project link target");
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  if (resolved === ".." || resolved.startsWith("../")) throw new Error("Project link escapes the workspace");
  if (resolved !== ".") safeRelative(resolved);
}
const reserved = (path: string) => [PROJECT_METADATA, SNAPSHOT_MANIFEST].includes(path.toLowerCase());

/** Validate the entire hierarchy before any destination is changed. */
function validateManifest(manifest: SnapshotManifest, maxBytes: number): void {
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.files) || !Array.isArray(manifest.links)
    || !Array.isArray(manifest.regenerable) || !Array.isArray(manifest.directories)
    || manifest.files.length + manifest.links.length + manifest.directories.length + manifest.regenerable.length > MAX_SNAPSHOT_FILES) throw new Error("Invalid project snapshot manifest");
  const occupied = new Set<string>(), directoryNames = new Set<string>(), regenerable = new Set<string>();
  let total = 0;
  const claim = (path: string, set: Set<string>) => {
    safeRelative(path);
    if (reserved(path) || set.has(path.toLowerCase())) throw new Error("Project snapshot filename collision");
    set.add(path.toLowerCase());
  };
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || !Number.isSafeInteger(file.size) || file.size < 0 || !Number.isInteger(file.mode)
      || file.mode < 0 || file.mode > 0o777 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("Invalid project file metadata");
    claim(file.path, occupied); total += file.size;
    if (total > maxBytes) throw new Error("Project snapshot limit exceeded");
  }
  for (const link of manifest.links) { if (!link) throw new Error("Invalid project link"); safeLink(link.path, link.target); claim(link.path, occupied); }
  for (const directory of manifest.directories) { claim(directory, directoryNames); if (occupied.has(directory.toLowerCase())) throw new Error("Project file conflicts with a directory"); }
  for (const path of manifest.regenerable) {
    claim(path, regenerable);
    if (occupied.has(path.toLowerCase()) || directoryNames.has(path.toLowerCase())) throw new Error("Dependency path conflicts with project content");
    if (!["node_modules", ".venv", "venv"].includes(posix.basename(path))) throw new Error("Invalid reconstructable dependency directory");
  }
  const all = [...manifest.files.map(file => file.path), ...manifest.links.map(link => link.path), ...manifest.directories, ...manifest.regenerable];
  for (const path of all) {
    let parent = posix.dirname(path);
    while (parent !== ".") {
      if (occupied.has(parent.toLowerCase()) || regenerable.has(parent.toLowerCase())) throw new Error("Project hierarchy conflicts with a file, link or dependency tree");
      parent = posix.dirname(parent);
    }
  }
}

function canonicalManifest(manifest: SnapshotManifest): void {
  const directories = new Map<string, string>();
  const add = (path: string) => {
    const folded = path.toLowerCase(), previous = directories.get(folded);
    if (previous && previous !== path) throw new Error("Project directory has inconsistent portable casing");
    directories.set(folded, path);
  };
  for (const path of manifest.directories) add(path);
  for (const path of [...manifest.files.map(file => file.path), ...manifest.links.map(link => link.path), ...manifest.directories, ...manifest.regenerable]) {
    let parent = posix.dirname(path);
    while (parent !== ".") { add(parent); parent = posix.dirname(parent); }
  }
  manifest.files = manifest.files.map(file => ({ path: file.path, sha256: file.sha256, size: file.size, mode: file.mode })).sort((a, b) => compare(a.path, b.path));
  manifest.links = manifest.links.map(link => ({ path: link.path, target: link.target })).sort((a, b) => compare(a.path, b.path));
  manifest.directories = [...directories.values()].sort(compare); manifest.regenerable.sort(compare);
}

/** Only dependency trees with a recorded reconstruction input are omitted. */
async function dependencyDirectory(parent: string, name: string): Promise<boolean> {
  const exists = async (filename: string) => lstat(join(parent, filename)).then(item => item.isFile() && !item.isSymbolicLink() && item.nlink === 1).catch(() => false);
  if (name === "node_modules") return (await Promise.all(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"].map(exists))).some(Boolean);
  if ([".venv", "venv"].includes(name)) return (await Promise.all(["uv.lock", "poetry.lock", "requirements.txt"].map(exists))).some(Boolean);
  return false;
}

export async function makeSnapshot(workspaces: WorkspaceService, id: string, maxBytes: number) {
  const root = await workspaces.workspaceDirectory(id), archive: Record<string, Uint8Array> = Object.create(null);
  const manifest: SnapshotManifest = { version: 1, archivePrefix: "payload/", files: [], regenerable: [], links: [], directories: [] };
  let metadata: { modes?: Array<{ path: string; mode: number }>; links?: SnapshotManifest["links"] } = {};
  try {
    const { bytes } = await snapshotFile(root, PROJECT_METADATA, METADATA_LIMIT);
    metadata = JSON.parse(bytes.toString("utf8"));
    if (!metadata || typeof metadata !== "object") throw new Error("Invalid project metadata");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (metadata.links && !Array.isArray(metadata.links) || metadata.modes && !Array.isArray(metadata.modes)
    || (metadata.links?.length ?? 0) + (metadata.modes?.length ?? 0) > MAX_SNAPSHOT_FILES) throw new Error("Invalid project metadata");
  const modes = new Map((metadata.modes ?? []).map(item => {
    safeRelative(item.path);
    if (!Number.isInteger(item.mode) || item.mode < 0 || item.mode > 0o777) throw new Error("Invalid project file mode");
    return [item.path, item.mode] as const;
  }));
  manifest.links = (metadata.links ?? []).map(link => { safeLink(link.path, link.target); return { path: link.path, target: link.target }; }).sort((a, b) => compare(a.path, b.path));
  let total = 0, count = 0;
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))) {
      const path = safeRelative(prefix + item.name);
      if (path.toLowerCase() === PROJECT_METADATA) continue;
      if (path.toLowerCase() === SNAPSHOT_MANIFEST) throw new Error("Reserved workspace transfer filename");
      if (++count > MAX_SNAPSHOT_FILES) throw new Error("Project snapshot limit exceeded");
      const target = await workspaces.resolvePath(id, path, { directory: item.isDirectory() }), info = await lstat(target);
      if (info.isSymbolicLink() || !info.isDirectory() && (!info.isFile() || info.nlink !== 1)) throw new Error("Linked or special files cannot be transferred");
      if (info.isDirectory()) {
        if (await dependencyDirectory(directory, item.name)) manifest.regenerable.push(path);
        else { manifest.directories.push(path); await visit(target, path + "/"); }
      } else {
        if (info.size > maxBytes || (total += info.size) > maxBytes) throw new Error("Project snapshot limit exceeded");
        const { bytes } = await snapshotFile(root, path, maxBytes);
        if (bytes.length !== info.size) throw new Error("Workspace changed during snapshot");
        archive["payload/" + path] = bytes;
        manifest.files.push({ path, sha256: digest(bytes), size: bytes.length, mode: modes.get(path) ?? (process.platform === "win32" ? 0o644 : info.mode & 0o777) });
      }
    }
  }
  await visit(root, "");
  validateManifest(manifest, maxBytes);
  canonicalManifest(manifest); validateManifest(manifest, maxBytes);
  const encoded = Buffer.from(JSON.stringify(manifest));
  if (encoded.length > METADATA_LIMIT) throw new Error("Project metadata exceeds its limit");
  archive[SNAPSHOT_MANIFEST] = encoded;
  return { manifest, revision: snapshotRevision(manifest), bytes: Buffer.from(zipSync(archive, { level: 1 })) };
}

export function decodeSnapshot(bytes: Buffer, maxBytes: number) {
  let total = 0, count = 0; const archiveNames = new Set<string>();
  const rawEntries = unzipSync(bytes, { filter: entry => {
    safeRelative(entry.name.startsWith("payload/") ? entry.name.slice("payload/".length) : entry.name);
    if (archiveNames.has(entry.name.toLowerCase()) || ++count > MAX_SNAPSHOT_FILES + 1 || !Number.isSafeInteger(entry.originalSize)
      || entry.originalSize < 0 || (total += entry.originalSize) > maxBytes + METADATA_LIMIT) throw new Error("Project snapshot limit exceeded or duplicate entry");
    archiveNames.add(entry.name.toLowerCase()); return true;
  } });
  const encoded = own(rawEntries, SNAPSHOT_MANIFEST) ? rawEntries[SNAPSHOT_MANIFEST] : undefined;
  if (!encoded || encoded.length > METADATA_LIMIT) throw new Error("Missing project snapshot manifest");
  const manifest = JSON.parse(Buffer.from(encoded).toString("utf8")) as SnapshotManifest;
  if (manifest && manifest.directories === undefined) manifest.directories = [];
  if (manifest?.archivePrefix !== undefined && manifest.archivePrefix !== "payload/") throw new Error("Invalid project archive encoding");
  validateManifest(manifest, maxBytes);
  canonicalManifest(manifest); validateManifest(manifest, maxBytes);
  const entries: Record<string, Uint8Array> = Object.create(null), prefix = manifest.archivePrefix ?? "";
  for (const file of manifest.files) {
    const key = prefix + file.path;
    if (!own(rawEntries, key) || rawEntries[key]!.length !== file.size || digest(rawEntries[key]!) !== file.sha256) throw new Error("Project snapshot content mismatch");
    entries[file.path] = rawEntries[key]!;
  }
  if (Object.keys(rawEntries).length !== manifest.files.length + 1) throw new Error("Unexpected project snapshot entries");
  return { manifest, entries, revision: snapshotRevision(manifest) };
}

async function durableWrite(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
function dependencyLocks(path: string): string[] {
  const parent = posix.dirname(path), prefix = parent === "." ? "" : parent + "/";
  return (posix.basename(path) === "node_modules" ? ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"] : ["uv.lock", "poetry.lock", "requirements.txt"]).map(name => prefix + name);
}

/** Stage a complete tree, compare once more, then swap directories with a durable recovery journal. */
export async function applySnapshot(workspaces: WorkspaceService, id: string, bytes: Buffer, baseline: string, maxBytes: number) {
  const next = decodeSnapshot(bytes, maxBytes);
  return workspaces.withWriteLock(id, async () => {
    const current = await makeSnapshot(workspaces, id, maxBytes);
    if (current.revision === next.revision) return next.revision;
    if (current.revision !== baseline) throw new Error("Workspace changed while the program ran; the remote snapshot has been retained without replacing local files");
    const root = await workspaces.workspaceDirectory(id), parent = dirname(root), nonce = randomUUID();
    const stage = join(parent, `.zigent-stage-${id}-${nonce}`), backup = join(parent, `.zigent-backup-${id}-${nonce}`);
    let movedOld = false, movedNew = false, journal = false;
    await mkdir(stage, { recursive: false, mode: 0o700 });
    try {
      for (const directory of next.manifest.directories) await mkdir(join(stage, directory), { recursive: true, mode: 0o700 });
      for (const file of next.manifest.files) {
        const target = await ordinaryPath(stage, file.path, true);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await durableWrite(target, next.entries[file.path]!);
      }
      for (const link of next.manifest.links) await mkdir(dirname(join(stage, link.path)), { recursive: true, mode: 0o700 });
      await durableWrite(join(stage, PROJECT_METADATA), Buffer.from(JSON.stringify({ version: 1, modes: next.manifest.files.map(({ path, mode }) => ({ path, mode })), links: next.manifest.links })));
      // Check all original files and paths after potentially expensive staging.
      if ((await makeSnapshot(workspaces, id, maxBytes)).revision !== baseline) throw new Error("Workspace changed while staging program results");
      workspaces.beginDirectoryReplacement(id, stage, backup); journal = true;
      await rename(root, backup); movedOld = true;
      try { await rename(stage, root); movedNew = true; }
      catch (error) { await rename(backup, root); movedOld = false; throw error; }
      // Carry only caches still declared by both snapshots, with unchanged lock
      // inputs. Cache move failures do not invalidate committed source files.
      const before = new Map(current.manifest.files.map(file => [file.path, file.sha256])), after = new Map(next.manifest.files.map(file => [file.path, file.sha256]));
      for (const path of current.manifest.regenerable) {
        if (!next.manifest.regenerable.includes(path)) continue;
        const locks = dependencyLocks(path);
        if (!locks.some(lock => before.has(lock)) || locks.some(lock => before.get(lock) !== after.get(lock))) continue;
        try {
          const source = await ordinaryPath(backup, path), target = await ordinaryPath(root, path, true);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await rename(source, target);
        } catch { /* The declared dependency environment can be reconstructed. */ }
      }
      try { await rm(backup, { recursive: true }); movedOld = false; } catch { /* Recovery journal retains the cleanup path. */ }
      if (!movedOld) { workspaces.finishDirectoryReplacement(id); journal = false; }
      return next.revision;
    } catch (error) {
      if (movedOld && !movedNew) { await rename(backup, root); movedOld = false; }
      if (!movedOld && journal) { workspaces.finishDirectoryReplacement(id); journal = false; }
      throw error;
    } finally {
      // Once journaled, a failed rollback must retain both candidates for restart.
      if (!journal || movedNew) await rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  });
}
