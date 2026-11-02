import { wgs84ToGcj02 } from "../location/coordinates.js";
import { productivityFetch, record } from "../productivity/http.js";
import { StreetTileClient } from "./trigger-map-tiles.js";

export type MapCenter = { latitude: number; longitude: number };
export type TriggerBasemap = {
  width: number; height: number; radius: number; radiusMeters: number;
  paths: Array<{ kind: "building" | "green" | "water" | "major" | "road" | "path"; d: string }>;
  labels: Array<{ x: number; y: number; text: string }>;
  scale: { meters: number; pixels: number }; source: "OpenStreetMap"; tileAttribution?: boolean;
};

/** Invert the same six-decimal transform used by the location receiver. */
export function mapWgs84(center: MapCenter): MapCenter {
  let latitude = center.latitude, longitude = center.longitude;
  for (let i = 0; i < 8; i++) {
    const projected = wgs84ToGcj02(latitude, longitude);
    const dy = projected.latitude - center.latitude, dx = projected.longitude - center.longitude;
    latitude -= dy; longitude -= dx;
    if (Math.abs(dx) + Math.abs(dy) < 0.0000005) break;
  }
  return { latitude, longitude };
}

function view(center: MapCenter, radiusMeters: number) {
  const earth = 6371008.8, radians = Math.PI / 180;
  const width = 1000, height = 600, metersHigh = radiusMeters * 3.3, pixelsPerMeter = height / metersHigh;
  const cos = Math.cos(center.latitude * radians);
  const project = (latitude: number, longitude: number) => ({
    x: (longitude - center.longitude) * radians * earth * cos * pixelsPerMeter + width / 2,
    y: -(latitude - center.latitude) * radians * earth * pixelsPerMeter + height / 2
  });
  const dy = metersHigh / 2 / earth / radians, dx = metersHigh * width / height / 2 / earth / radians / cos;
  return { width, height, pixelsPerMeter, project,
    bounds: [Math.max(-85, center.latitude - dy), Math.max(-180, center.longitude - dx), Math.min(85, center.latitude + dy), Math.min(180, center.longitude + dx)] };
}

/** Render only projected, bounded geometry. Raw coordinates/OSM IDs never reach the browser. */
export function projectBasemap(input: unknown, center: MapCenter, radiusMeters: number): TriggerBasemap {
  const { width, height, project, pixelsPerMeter } = view(center, radiusMeters);
  const paths: TriggerBasemap["paths"] = [], labels: TriggerBasemap["labels"] = [], names = new Set<string>();
  const items = record(input).elements;
  if (!Array.isArray(items)) throw new Error("MAP_RESPONSE_INVALID");
  let points = 0;
  for (const value of items.slice(0, 6000)) {
    const item = record(value), tags = record(item.tags);
    const parts = Array.isArray(item.geometryParts) ? item.geometryParts.filter(Array.isArray) : Array.isArray(item.geometry) ? [item.geometry] : [];
    const coordinates = parts.flat().map(value => record(value));
    if (coordinates.length < 2) continue;
    if (points + coordinates.length > 100000) break;
    if (coordinates.some(p => typeof p.lat !== "number" || !Number.isFinite(p.lat) || Math.abs(p.lat) > 90
      || typeof p.lon !== "number" || !Number.isFinite(p.lon) || Math.abs(p.lon) > 180)) continue;
    const vertices = coordinates.map(p => project(p.lat as number, p.lon as number)); points += vertices.length;
    if (vertices.every(p => p.x < 0) || vertices.every(p => p.x > width) || vertices.every(p => p.y < 0) || vertices.every(p => p.y > height)) continue;
    let kind: TriggerBasemap["paths"][number]["kind"];
    if (typeof tags.highway === "string") kind = ["primary", "secondary", "tertiary", "trunk", "motorway", "residential"].includes(tags.highway) ? "major"
      : ["footway", "path", "steps", "cycleway", "pedestrian"].includes(tags.highway) ? "path" : "road";
    else if (tags.building) kind = "building";
    else if (tags.natural === "water" || tags.waterway === "riverbank") kind = "water";
    else if (["park", "garden", "pitch", "playground", "recreation_ground"].includes(String(tags.leisure)) || ["grass", "forest", "meadow"].includes(String(tags.landuse))) kind = "green";
    else continue;
    const closed = ["building", "green", "water"].includes(kind);
    if (!item.labelOnly) paths.push({ kind, d: parts.map(part => `M${part.map(value => { const point = record(value), p = project(point.lat as number, point.lon as number); return `${p.x.toFixed(1)},${p.y.toFixed(1)}`; }).join(" L")}${closed ? " Z" : ""}`).join(" ") });
    const text = typeof tags.name === "string" ? tags.name.slice(0, 40) : "";
    if (kind !== "major" || !text || names.has(text) || labels.length >= 8) continue;
    const first = vertices[Math.floor((vertices.length - 1) / 2)]!, second = vertices[Math.ceil((vertices.length - 1) / 2)]!;
    const x = Math.round((first.x + second.x) / 2), y = Math.round((first.y + second.y) / 2) - 14;
    if (x < 80 || x > width - 80 || y < 40 || y > height - 45 || Math.hypot(x - width / 2, y - height / 2) < 85
      || labels.some(p => Math.hypot(x - p.x, y - p.y) < 120)) continue;
    names.add(text); labels.push({ text, x, y });
  }
  if (!paths.some(p => ["major", "road", "path", "building"].includes(p.kind))) throw new Error("MAP_GEOMETRY_UNAVAILABLE");
  const order = { green: 0, water: 0, building: 1, path: 2, road: 3, major: 4 };
  paths.sort((a, b) => order[a.kind] - order[b.kind]);
  const desired = radiusMeters * .65, power = 10 ** Math.floor(Math.log10(desired));
  const meters = [1, 2, 5, 10].map(n => n * power).reduce((best, n) => Math.abs(n - desired) < Math.abs(best - desired) ? n : best);
  return { width, height, radius: radiusMeters * pixelsPerMeter, radiusMeters, paths, labels,
    scale: { meters, pixels: meters * pixelsPerMeter }, source: "OpenStreetMap" };
}

export class TriggerBasemapClient {
  private readonly cache = new Map<string, { at: number; value: TriggerBasemap }>();
  private readonly pending = new Map<string, Promise<TriggerBasemap>>();
  private readonly cooldowns = new Map<string, number>();
  private readonly tiles: StreetTileClient;
  constructor(private readonly request: typeof fetch = productivityFetch(), fallbackRequest?: typeof fetch) {
    this.tiles = new StreetTileClient(request, fallbackRequest);
  }
  async load(gcj: MapCenter, radiusMeters: number): Promise<TriggerBasemap> {
    if (!Number.isFinite(radiusMeters) || radiusMeters < 1 || radiusMeters > 100000
      || !Number.isFinite(gcj.latitude) || Math.abs(gcj.latitude) > 84 || !Number.isFinite(gcj.longitude) || Math.abs(gcj.longitude) > 179)
      throw new Error("MAP_BOUNDS_INVALID");
    const key = `${gcj.latitude},${gcj.longitude},${radiusMeters}`, hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 86400000) return hit.value;
    if (this.pending.has(key)) return this.pending.get(key)!;
    if (this.pending.size >= 2) throw new Error("MAP_BUSY");
    const work = this.fetch(gcj, radiusMeters);
    this.pending.set(key, work);
    try {
      const value = await work;
      this.cache.delete(key); this.cache.set(key, { at: Date.now(), value });
      while (this.cache.size > 24) this.cache.delete(this.cache.keys().next().value!);
      return value;
    } finally { this.pending.delete(key); }
  }
  private async fetch(gcj: MapCenter, radiusMeters: number): Promise<TriggerBasemap> {
    const center = mapWgs84(gcj), bbox = view(center, radiusMeters).bounds.map(v => v.toFixed(6)).join(",");
    const detailed = radiusMeters <= 2500;
    const query = `[out:json][timeout:8][maxsize:8388608];(way["highway"${detailed ? "" : '~"^(motorway|trunk|primary|secondary|tertiary)$"'}](${bbox});${detailed ? `way["building"](${bbox});way["leisure"~"^(park|garden|pitch)$"](${bbox});` : ""}way["natural"="water"](${bbox}););out geom;`;
    const deadline = AbortSignal.timeout(24000);
    try {
      const tiles = await this.tiles.load(center, radiusMeters, view(center, radiusMeters).bounds, deadline);
      return { ...projectBasemap(tiles, center, radiusMeters), tileAttribution: true };
    } catch { if (deadline.aborted) throw new Error("MAP_FETCH_FAILED"); }
    // Both are published public Overpass instances. A supplier's throttling is never retried immediately.
    for (const endpoint of ["https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass.private.coffee/api/interpreter"]) {
      if ((this.cooldowns.get(endpoint) ?? 0) > Date.now()) continue;
      try {
        const response = await this.request(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.any([deadline, AbortSignal.timeout(12000)]),
          headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Zigent/0.1 (trigger maps; https://github.com/zc-liu722/zigent-personal-agent)" },
          body: new URLSearchParams({ data: query }) });
        if (!response.ok || !response.body) {
          if (response.status === 429 || response.status === 406) {
            const retry = Number(response.headers.get("retry-after"));
            this.cooldowns.set(endpoint, Date.now() + Math.max(30000, Number.isFinite(retry) ? Math.min(retry * 1000, 300000) : 0));
          }
          await response.body?.cancel(); throw new Error("MAP_FETCH_FAILED");
        }
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
        try {
          for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length;
            if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error("MAP_RESPONSE_TOO_LARGE"); } chunks.push(chunk.value); }
        } finally { reader.releaseLock(); }
        const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (record(data).remark) throw new Error("MAP_RESPONSE_INCOMPLETE");
        return projectBasemap(data, center, radiusMeters);
      } catch { if (deadline.aborted) break; }
    }
    throw new Error("MAP_FETCH_FAILED");
  }
}
