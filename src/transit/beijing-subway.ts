import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const SUBWAY_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60_000;

const BASE = "https://www.bjsubway.com";
const hosts = new Set(["www.bjsubway.com", "bjsubway.com", "eos-beijing-2.cmecloud.cn", "www.mtr.bj.cn", "cdnwww.mtr.bj.cn", "www.bjmoa.cn", "www.bii.com.cn"]);
const text = (s: string) => s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
const normalize = (s: string) => s.trim().replace(/站$/, "").replace(/^地铁/, "").replace(/^1号线$/, "1号线八通线").replace(/^(4号线大兴线|4号线-大兴线|大兴线)$/, "4号线");
const assetSchema = z.object({ id: z.string(), url: z.string(), label: z.string(), dayType: z.enum(["weekday", "weekend", "unspecified"]), direction: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/), mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]), etag: z.string().optional(), modified: z.string().optional() });
const serviceSchema = z.object({ direction: z.string(), destination: z.string(), first: z.string().nullable(), last: z.string().nullable(), partial: z.boolean(), firstNote: z.string().nullable(), lastNote: z.string().nullable() });
const recordSchema = z.object({ key: z.string(), line: z.string(), station: z.string(), source: z.string(), fetchedAt: z.string(), services: z.array(serviceSchema), tables: z.array(assetSchema) });
export const snapshotSchema = z.object({ version: z.literal(1), checkedAt: z.string(), records: z.array(recordSchema), failures: z.array(z.string()) });
export type SubwaySnapshot = z.infer<typeof snapshotSchema>;
export type SubwayRecord = z.infer<typeof recordSchema>;
export function subwayNeedsRefresh(snapshot: SubwaySnapshot | undefined, now = Date.now()): boolean {
  if (!snapshot || snapshot.failures.length) return true;
  const checkedAt = Date.parse(snapshot.checkedAt);
  return !Number.isFinite(checkedAt) || checkedAt > now || now - checkedAt >= SUBWAY_REFRESH_INTERVAL_MS;
}
type Table = z.infer<typeof assetSchema>;
type Candidate = Pick<Table, "url" | "label" | "direction" | "dayType">;
const obj = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const array = (v: unknown): any[] => Array.isArray(v) ? v : [];

export function officialUrl(value: string, base = BASE): string {
  const url = new URL(value, base);
  if (url.protocol !== "https:" || !hosts.has(url.hostname) || url.port || url.username || url.password) throw new Error("Unsupported subway source");
  return url.href;
}
export function imageMime(bytes: Buffer): Table["mimeType"] {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new Error("Invalid timetable image");
}
export async function readSnapshot(directory: string): Promise<SubwaySnapshot | undefined> {
  try { return snapshotSchema.parse(JSON.parse(await readFile(join(directory, "snapshot.json"), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, data); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
async function pool<T>(items: T[], work: (item: T) => Promise<void>, concurrency = 4): Promise<void> {
  let index = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => { while (index < items.length) await work(items[index++]!); }));
}
function candidate(url: string, label: string): Candidate {
  const decoded = decodeURIComponent(url);
  const direction = decoded.match(/-([^/\-]+?)站?方向-/)?.[1] ?? "";
  return { url: officialUrl(url), label, direction, dayType: /双休日|星期六|周末/.test(label + decoded) ? "weekend" : /工作日|星期一|平日/.test(label + decoded) ? "weekday" : "unspecified" };
}
export function parseMoa(html: string, line: string, source: string): Array<{ station: string; candidates: Candidate[] }> {
  const groups = new Map<string, Candidate[]>();
  for (const match of html.matchAll(/<h5>(.*?)<\/h5>\s*<span[^>]*>(.*?)<\/span>([\s\S]*?)(?=<h5>|<link rel="stylesheet"|$)/g)) {
    const station = text(match[1]!).replace(/站$/, ""), label = `${line} ${station} ${text(match[2]!)}`;
    const tables = groups.get(station) ?? [];
    for (const img of match[3]!.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)) tables.push(candidate(officialUrl(img[1]!, source), label));
    groups.set(station, tables);
  }
  return [...groups].map(([station, candidates]) => ({ station, candidates }));
}
export function parseMtrImages(html: string, line: string, station: string): Candidate[] {
  const section = html.split('class="schedule-pictures"')[1]?.split("</section>")[0] ?? "";
  return [...section.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((m, i) => candidate(officialUrl(m[1]!, "https://www.mtr.bj.cn"), `${line} ${station} 时刻表 ${i + 1}（日期类型和方向见原图）`));
}

/** Fixed official sources only; retain each failed station's last complete snapshot. */
export async function syncSubway(directory: string, options: { request?: typeof fetch; now?: Date; onProgress?: (message: string) => void } = {}): Promise<SubwaySnapshot> {
  await mkdir(join(directory, "images"), { recursive: true });
  // The production deployment and scheduled updater share the same workflow concurrency group.
  const lock = join(directory, "sync.lock");
  try { await mkdir(lock); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (Date.now() - (await stat(lock)).mtimeMs < 2 * 60 * 60_000) throw new Error("Subway update already running");
    await rm(lock, { recursive: true }); await mkdir(lock);
  }
  try {
    const now = (options.now ?? new Date()).toISOString(), previous = await readSnapshot(directory);
    const old = new Map(previous?.records.map(r => [r.key, r]) ?? []);
    const records = new Map<string, SubwayRecord>(), failures: string[] = [];
    const request = options.request ?? fetch;
    async function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
      url = officialUrl(url);
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await request(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; ZigentSubway/1.0)", Referer: new URL(url).origin + "/", ...headers }, signal: AbortSignal.timeout(25_000), redirect: "error" });
          if (!response.ok && response.status !== 304) throw new Error(`HTTP ${response.status}`);
          return response;
        } catch (error) { if (attempt >= 1) throw error; }
      }
    }
    async function json(url: string): Promise<any> {
      const body = obj(await (await get(url)).json());
      if (body.status !== 200 || !body.data) throw new Error("Invalid official station response");
      return body.data;
    }
    async function save(record: Omit<SubwayRecord, "tables">, candidates: Candidate[]): Promise<void> {
      const prior = old.get(record.key), tables: Table[] = [];
      const unique = [...new Map(candidates.map(c => [c.url, c])).values()];
      for (const c of unique) {
        const cached = prior?.tables.find(t => t.url === c.url);
        const exists = cached && await stat(join(directory, "images", cached.hash)).then(() => true, () => false);
        const headers: Record<string, string> = {};
        if (exists && cached.etag) headers["If-None-Match"] = cached.etag;
        if (exists && cached.modified) headers["If-Modified-Since"] = cached.modified;
        const response = await get(c.url, headers);
        if (response.status === 304) {
          if (!cached || !exists) throw new Error("Missing cached image");
          tables.push({ ...cached, ...c }); continue;
        }
        const maximum = 12 * 1024 * 1024;
        if (Number(response.headers.get("content-length")) > maximum) throw new Error("Timetable image too large");
        const chunks: Uint8Array[] = []; let size = 0;
        const reader = response.body!.getReader();
        try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > maximum) throw new Error("Timetable image too large"); chunks.push(value); } }
        finally { await reader.cancel(); }
        const bytes = Buffer.concat(chunks), mimeType = imageMime(bytes), hash = createHash("sha256").update(bytes).digest("hex");
        if (!(await stat(join(directory, "images", hash)).then(() => true, () => false))) await atomicWrite(join(directory, "images", hash), bytes);
        tables.push({ ...c, id: createHash("sha256").update(record.key + c.url).digest("hex").slice(0, 20), hash, mimeType,
          ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}), ...(response.headers.get("last-modified") ? { modified: response.headers.get("last-modified")! } : {}) });
      }
      records.set(record.key, { ...record, tables });
    }
    function failed(key: string): void { failures.push(key); const prior = old.get(key); if (prior) records.set(key, prior); }
    const lines = array(await json(`${BASE}/api/guanwang/v2/lineStations`));
    if (lines.length < 20) throw new Error("Incomplete official line catalogue; previous snapshot retained");
    const locations = [...new Set(lines.flatMap(l => array(l.stations).map(s => String(s.accLocation))))];
    options.onProgress?.(`SUBWAY_SYNC phase=stations count=${locations.length}`);
    let completed = 0;
    await pool(locations, async loc => {
      const prefix = `bj:${loc}:`;
      try {
        const source = `${BASE}/station/siteinfo.html?loc=${loc}&type=sk`;
        const data = obj(await json(`${BASE}/api/guanwang/v2/getStationDetail?accLocation=${encodeURIComponent(loc)}&source=web`));
        const station = obj(data.station);
        if (!station.stationName || (data.lines !== null && !Array.isArray(data.lines))) throw new Error("Missing station data");
        // Some catalogue-only tram stops explicitly have no service data upstream.
        // Represent that gap instead of manufacturing times or failing every daily update.
        if (!array(data.lines).length) {
          const indexed = lines.filter(l => array(l.stations).some(s => String(s.accLocation) === loc));
          for (const l of indexed) {
            const line = normalize(String(l.lineCnName)), key = prefix + line;
            if (old.get(key)?.services.length || old.get(key)?.tables.length) failed(key);
            else records.set(key, { key, line, station: String(station.stationName), source, fetchedAt: now, services: [], tables: [] });
          }
        }
        for (const name of [...new Set(array(data.lines).map(l => normalize(String(l.lineName))))]) {
          const key = prefix + name;
          try {
            const services = array(data.lines).filter(l => normalize(String(l.lineName)) === name).map(l => ({ direction: String(l.terminalStationName ?? ""), destination: String(l.destStationName ?? ""), first: l.firstTime ?? null, last: l.lastTime ?? null, partial: Boolean(l.isHalf), firstNote: l.firstTimeDesc ?? null, lastNote: l.lastTimeDesc ?? null }));
            const candidates = array(station.trainSchedules).filter(t => {
              const label = decodeURIComponent(String(t.imagePath)).split("/").pop()?.split("-")[0] ?? "";
              return normalize(label) === name;
            }).map(t => candidate(t.imagePath, decodeURIComponent(String(t.imagePath)).split("/").pop()!));
            await save({ key, line: name, station: String(station.stationName), source, fetchedAt: now, services }, candidates);
          } catch { failed(key); }
        }
      } catch { const keys = [...old.keys()].filter(k => k.startsWith(prefix)); if (keys.length) keys.forEach(failed); else failures.push(prefix); }
      if (++completed % 50 === 0) options.onProgress?.(`SUBWAY_SYNC phase=stations completed=${completed}`);
    });
    for (const n of [4, 14, 16, 17]) {
      const source = `https://www.mtr.bj.cn/service/line/line-${n}.html`;
      let stations: Array<{ name: string; url: string }>;
      try {
        const html = await (await get(source + "?source=zigent")).text();
        stations = [...html.matchAll(/<a\b[^>]*href="(\/service\/line\/station\/[^"#?]+\.html)"[^>]*>([^<]+)<\/a>/g)].map(m => ({ name: text(m[2]!), url: officialUrl(m[1]!, source) }));
        stations = [...new Map(stations.map(s => [s.url, s])).values()];
        if (!stations.length) throw new Error("Missing MTR station list");
      } catch { failures.push(`mtr:${n}`); for (const [key, r] of old) if (key.startsWith(`mtr:${n}:`)) records.set(key, r); continue; }
      await pool(stations, async s => {
        const key = `mtr:${n}:${s.name}`;
        try {
          const html = await (await get(s.url + "?source=zigent")).text(), candidates = parseMtrImages(html, `${n}号线`, s.name);
          if (!candidates.length) throw new Error("Missing MTR timetables");
          await save({ key, line: `${n}号线`, station: s.name, source: s.url, fetchedAt: now, services: [] }, candidates);
        } catch { failed(key); }
      });
      options.onProgress?.(`SUBWAY_SYNC phase=mtr line=${n} stations=${stations.length}`);
    }
    for (const [id, line] of [[24, "燕房线"], [26, "大兴机场线"], [16, "19号线"]] as const) {
      const source = `https://www.bjmoa.cn/trainTimeList_363.html?sline=${id}`;
      try {
        const groups = parseMoa(await (await get(source)).text(), line, source);
        if (!groups.length || groups.some(g => !g.candidates.length)) throw new Error("Missing MOA timetables");
        await pool(groups, async g => {
          const key = `moa:${id}:${g.station}`;
          try { await save({ key, line, station: g.station, source, fetchedAt: now, services: [] }, g.candidates); } catch { failed(key); }
        });
      } catch { failures.push(`moa:${id}`); for (const [key, r] of old) if (key.startsWith(`moa:${id}:`)) records.set(key, r); }
    }
    if (records.size < 300 || ![...records.values()].some(r => r.tables.length)) throw new Error("Incomplete subway download; previous snapshot retained");
    const snapshot = snapshotSchema.parse({ version: 1, checkedAt: now, records: [...records.values()].sort((a, b) => a.key.localeCompare(b.key)), failures: [...new Set(failures)] });
    await atomicWrite(join(directory, "snapshot.json"), JSON.stringify(snapshot));
    return snapshot;
  } finally { await rm(lock, { recursive: true, force: true }); }
}

export class BeijingSubway {
  constructor(readonly directory: string) {}
  async query(input: { action: "status" | "search" | "view"; line?: string; station?: string; direction?: string; day_type?: "weekday" | "weekend"; table_ids?: string[]; offset?: number; limit?: number }) {
    const snapshot = await readSnapshot(this.directory);
    if (!snapshot) return { status: "unavailable", message: "北京地铁时刻表尚未下载。" };
    const base = { checked_at: snapshot.checkedAt, realtime: false, timezone: "Asia/Shanghai", failed_updates: snapshot.failures.length };
    if (input.action === "status") return { unavailable_stations: snapshot.records.filter(r => !r.services.length && !r.tables.length).map(r => ({ line: r.line, station: r.station })), status: "available", ...base, stations: new Set(snapshot.records.map(r => r.station)).size, lines: [...new Set(snapshot.records.map(r => r.line))], tables: snapshot.records.reduce((n, r) => n + r.tables.length, 0) };
    const matches = snapshot.records.filter(r => (!input.line || normalize(r.line) === normalize(input.line)) && (!input.station || normalize(r.station).includes(normalize(input.station))));
    const entries = matches.map(r => ({ line: r.line, station: r.station, source: r.source, availability: r.tables.length ? "timetable" : r.services.length ? "first_last_only" : "unavailable", downloaded_at: r.fetchedAt, stale: Date.now() - Date.parse(r.fetchedAt) > 2 * SUBWAY_REFRESH_INTERVAL_MS,
      services: r.services.filter(s => !input.direction || (s.direction + s.destination).includes(input.direction)),
      tables: r.tables.filter(t => (!input.day_type || t.dayType === input.day_type || t.dayType === "unspecified") && (!input.direction || !t.direction || t.direction.includes(input.direction))).map(t => ({ id: t.id, label: t.label, direction: t.direction, day_type: t.dayType, url: t.url })) }));
    if (input.action === "view") {
      const ids = input.table_ids ?? [], selected = new Set(entries.flatMap(r => r.tables.map(t => t.id)));
      const allowed = new Map(matches.flatMap(r => r.tables.filter(t => selected.has(t.id)).map(t => [t.id, t] as const)));
      const images = await Promise.all(ids.map(async id => {
        const table = allowed.get(id); if (!table) throw new Error("Unknown timetable ID; search first");
        const data = await readFile(join(this.directory, "images", table.hash));
        if (createHash("sha256").update(data).digest("hex") !== table.hash) throw new Error("Damaged timetable cache");
        return { data, mimeType: imageMime(data), sessionImageId: `${table.label} [${table.id}]` };
      }));
      return { kind: "view_session_images" as const, imageIds: ids, images, metadata: { status: "available", ...base, entries: entries.filter(r => r.tables.some(t => ids.includes(t.id))), warning: "计划时刻，非实时预报。按原图核对日期、方向、交路与图例；未确定节假日或调休适用表时不要自行假定。" } };
    }
    const offset = input.offset ?? 0, limit = input.limit ?? 10;
    return { status: entries.length ? "available" : "not_found", ...base, total: entries.length, entries: entries.slice(offset, offset + limit), has_more: offset + limit < entries.length, next_offset: offset + limit < entries.length ? offset + limit : null,
      guidance: "services 是首末班计划时间（午夜后属于前一运营日），tables 是逐班原表。要回答某班时刻，必须 view 相应 table_ids 读取图片；unspecified 的方向和适用日须从原图确认。缺少原表时不能根据首末班或间隔推算逐班时刻。节假日和调休需核实运营方安排。" };
  }
}
