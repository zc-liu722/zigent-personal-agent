import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate } from "node:timers/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { prepareLegacyStaticAssets, serveRepresentations, writePreparedAssets,
  type PreparedAssetIndex, type Representation } from "./static-assets.js";
import { pageColors, paletteAsset, type PageColors, type PaletteId, type PalettePageColors } from "./palette.js";

export type WebAssetRecord = { inputFingerprint?: string; id: "web"; version: string; sourceCommit: string; webApi: 1;
  versions: Record<string, string>; prepared?: PreparedAssetIndex;
  files: Array<{ path: string; mime: string; sha256: string }> };
type AssetSet = { record: WebAssetRecord; root: string; prepared: PreparedAssetIndex; files: Map<string, Buffer>; colors?: PalettePageColors };
const route = (path: string) => path === "index.html" ? "" : path;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Historical requests read individual build-time representations, never rebuild a release. */
export class WebAssetReleases {
  private readonly sets = new Map<string, Promise<AssetSet>>();
  private readonly archive = new Map<string, WebAssetRecord>();
  private readonly resources = new Map<string, Representation[]>();
  private readonly loading = new Map<string, Promise<Representation[]>>();
  private residentBytes = 0;
  private active?: AssetSet;
  private candidate?: AssetSet;
  constructor(private readonly bundled: string, private readonly installed?: string) {}
  private load(record: WebAssetRecord): Promise<AssetSet> {
    const known = this.sets.get(record.version);
    if (known) return known;
    const loading = this.open(record).catch(error => { this.sets.delete(record.version); throw error; });
    this.sets.set(record.version, loading);
    return loading;
  }
  private async open(record: WebAssetRecord): Promise<AssetSet> {
    if (record.id !== "web" || record.webApi !== 1 || !/^[a-f0-9]{64}$/.test(record.version)
      || !/^[a-f0-9]{40}$/.test(record.sourceCommit)) throw new Error("WEB_ASSET_INCOMPATIBLE");
    let directory = join(this.bundled, "web", record.version);
    try { await readFile(join(directory, "component.json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !this.installed) throw error; directory = join(this.installed, "web", record.version); }
    const metadata = JSON.parse(await readFile(join(directory, "component.json"), "utf8"));
    if (JSON.stringify(metadata) !== JSON.stringify(record)) throw new Error("WEB_ASSET_METADATA_MISMATCH");
    for (const file of record.files) {
      if (!/^[a-zA-Z0-9_./-]+$/.test(file.path) || file.path.split("/").some(part => part === ".." || !part)) throw new Error("WEB_ASSET_PATH_INVALID");
    }
    const prepared = record.prepared
      ? { root: join(directory, "prepared"), index: record.prepared }
      : await this.migrateLegacy(directory, record);
    for (const file of record.files) {
      const variants = prepared.index.files[route(file.path)];
      if (!variants?.length || variants[0]!.encoding || variants.some(value => !/^[a-f0-9]{64}$/.test(value.sha256)
        || ![undefined, "gzip", "br"].includes(value.encoding))) throw new Error("WEB_ASSET_REPRESENTATION_INVALID");
    }
    if (!prepared.index.files[""]) throw new Error("WEB_ASSET_SET_INVALID");
    this.archive.set(record.version, record);
    return { record, root: prepared.root, prepared: prepared.index, files: new Map() };
  }
  private async migrateLegacy(directory: string, record: WebAssetRecord) {
    const root = join(this.installed ?? join(tmpdir(), "zigent-web-assets"), ".prepared", record.version);
    try {
      const saved = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
      if (saved.version !== record.version) throw new Error("WEB_ASSET_CACHE_INVALID");
      return { root, index: saved.index as PreparedAssetIndex };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const files = new Map<string, Buffer>(), types: Record<string, [string, string]> = {};
    const hash = createHash("sha256").update(record.sourceCommit);
    for (const file of record.files) {
      const bytes = await readFile(join(directory, "public", file.path));
      if (sha256(bytes) !== file.sha256) throw new Error("WEB_ASSET_INTEGRITY_FAILED");
      hash.update(file.path).update("\0").update(bytes).update("\0");
      files.set(route(file.path), bytes); types[route(file.path)] = [file.path, file.mime];
      await setImmediate();
    }
    if (hash.digest("hex") !== record.version) throw new Error("WEB_ASSET_SET_INVALID");
    const serving = await prepareLegacyStaticAssets(files, types);
    const temporary = `${root}.${randomUUID()}.preparing`;
    try {
      const index = await writePreparedAssets(temporary, serving);
      await writeFile(join(temporary, "index.json"), JSON.stringify({ version: record.version, index }));
      await mkdir(dirname(root), { recursive: true });
      try { await rename(temporary, root); }
      catch (error) {
        // Other Agent processes can finish the same immutable cache concurrently.
        if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        const saved = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
        if (JSON.stringify(saved) !== JSON.stringify({ version: record.version, index })) throw new Error("WEB_ASSET_CACHE_CONFLICT");
      }
      return { root, index };
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  private representations(set: AssetSet, path: string): Promise<Representation[]> {
    const key = `${set.record.version}:${path}`;
    const cached = this.resources.get(key);
    if (cached) { this.resources.delete(key); this.resources.set(key, cached); return Promise.resolve(cached); }
    const pending = this.loading.get(key);
    if (pending) return pending;
    const loading = Promise.all(set.prepared.files[path]!.map(async variant => {
      const body = await readFile(join(set.root, variant.sha256));
      if (sha256(body) !== variant.sha256) throw new Error("WEB_ASSET_INTEGRITY_FAILED");
      return { body, encoding: variant.encoding, etag: `"${variant.sha256}"` };
    })).then(variants => {
      this.resources.set(key, variants);
      this.residentBytes += variants.reduce((size, variant) => size + variant.body.length, 0);
      // File-level LRU holds many historical pages without retaining whole bundles.
      while (this.residentBytes > 128 * 1024 * 1024 && this.resources.size) {
        const [oldest, bytes] = this.resources.entries().next().value!;
        this.resources.delete(oldest);
        this.residentBytes -= bytes.reduce((size, variant) => size + variant.body.length, 0);
      }
      return variants;
    }).finally(() => { this.loading.delete(key); });
    this.loading.set(key, loading);
    return loading;
  }
  private async foreground(record: WebAssetRecord): Promise<AssetSet> {
    const set = await this.load(record);
    // Only shell rendering needs synchronous access; ordinary assets stay lazy.
    for (const path of ["", "manifest.webmanifest", "interactive-tokens.css", paletteAsset]) {
      if (set.prepared.files[path]) set.files.set(path, (await this.representations(set, path))[0]!.body);
    }
    const palette = set.files.get(paletteAsset);
    const legacyTokens = set.files.get("interactive-tokens.css");
    if (palette) set.colors = pageColors(palette.toString("utf8"));
    else if (legacyTokens) set.colors = pageColors(legacyTokens.toString("utf8"), "--ui-bg");
    return set;
  }
  async initialize(record: WebAssetRecord): Promise<void> {
    if (this.installed) {
      let versions: string[] = [];
      try { versions = await readdir(join(this.installed, "web")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      for (const version of versions.filter(value => /^[a-f0-9]{64}$/.test(value))) {
        try { const saved = JSON.parse(await readFile(join(this.installed, "web", version, "component.json"), "utf8")) as WebAssetRecord;
          if (saved.webApi === 1 && saved.version === version && saved.versions) this.archive.set(version, saved); }
        catch { console.warn("Historical public resource set unavailable", version); }
      }
    }
    this.active = await this.foreground(record);
  }
  async prepare(record: WebAssetRecord): Promise<void> { this.candidate = await this.foreground(record); }
  activate(): void {
    if (!this.candidate) throw new Error("WEB_ASSET_NO_CANDIDATE");
    this.active = this.candidate; this.candidate = undefined;
  }
  discard(): void { this.candidate = undefined; }
  status() { return { active: this.active?.record, candidate: this.candidate?.record, retained: [...this.sets.keys()], residentBytes: this.residentBytes }; }
  get files(): Map<string, Buffer> { return this.active!.files; }
  pageColors(id: PaletteId): PageColors | undefined {
    const colors = this.active!.colors;
    return colors?.[id] ?? colors?.brown;
  }
  async interactiveStyles(version?: string): Promise<{ tokens: string; palette?: string } | undefined> {
    const paths = ["interactive-tokens.css", paletteAsset];
    const active = this.active!;
    if (!version || active.record.versions[paletteAsset] === version) {
      return { tokens: active.files.get(paths[0]!)!.toString("utf8"), palette: active.files.get(paletteAsset)?.toString("utf8") };
    }
    const record = [...this.archive.values()].find(candidate => candidate.versions[paletteAsset] === version);
    if (!record) return;
    const set = await this.load(record);
    const [tokens, palette] = await Promise.all(paths.map(async path => (await this.representations(set, path))[0]!.body.toString("utf8")));
    return { tokens: tokens!, palette };
  }
  get inlineCspHashes(): string { return this.active!.prepared.inlineCspHashes; }
  has(path: string): boolean { return [...this.archive.values()].some(set => set.files.some(file => route(file.path) === path)); }
  async serve(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<boolean> {
    if (!path || path === "manifest.webmanifest") return false;
    const version = url.searchParams.get("v");
    const record = version ? [...this.archive.values()].find(candidate => candidate.versions[path] === version) : this.active?.record;
    const set = record ? await this.load(record) : undefined;
    const file = record?.files.find(file => route(file.path) === path);
    if (!set || !file || !set.prepared.files[path]) { res.writeHead(404); res.end(); return true; }
    return serveRepresentations(req, res, url, record?.versions[path], file.mime, await this.representations(set, path));
  }
}
