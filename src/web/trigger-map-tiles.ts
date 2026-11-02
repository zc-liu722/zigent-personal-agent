import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { record } from "../productivity/http.js";

export type StreetElement = { tags: Record<string, unknown>; geometryParts: Array<Array<{ lat: number; lon: number }>>; labelOnly?: boolean };
const userAgent = "Zigent/0.1 (trigger maps; https://github.com/zc-liu722/zigent-personal-agent)";

async function bytes(response: Response, limit: number) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("MAP_TILE_FETCH_FAILED");
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
  try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; total += chunk.value.length;
    if (total > limit) { await reader.cancel(); throw new Error("MAP_TILE_TOO_LARGE"); } chunks.push(chunk.value); } }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

/** The public tile source uses the OpenMapTiles schema; only display layers are decoded. */
export function streetTile(buffer: Uint8Array, x: number, y: number, z: number): StreetElement[] {
  const tile = new VectorTile(new PbfReader(buffer)), elements: StreetElement[] = [];
  for (const name of ["water", "landcover", "landuse", "building", "transportation", "transportation_name"]) {
    const layer = tile.layers[name]; if (!layer) continue;
    for (let i = 0; i < Math.min(layer.length, 6000); i++) {
      const feature = layer.feature(i), properties = feature.properties, kind = String(properties.class);
      let tags: Record<string, unknown>;
      if (name === "water") tags = { natural: "water" };
      else if (name === "building") tags = { building: "yes" };
      else if (name === "landcover" || name === "landuse") {
        if (!["wood", "forest", "grass", "park", "garden", "pitch", "recreation_ground"].includes(kind)) continue;
        tags = { leisure: "park" };
      } else {
        if (feature.type !== 2) continue;
        tags = { highway: ["street", "street_limited"].includes(kind) ? "residential" : kind,
          name: properties["name:zh"] || properties["name:zh-Hans"] || properties.name };
      }
      const geometry = feature.toGeoJSON(x, y, z).geometry;
      let parts: number[][][];
      if (geometry.type === "LineString") parts = [geometry.coordinates];
      else if (geometry.type === "Polygon" || geometry.type === "MultiLineString") parts = geometry.coordinates;
      else if (geometry.type === "MultiPolygon") parts = geometry.coordinates.flat();
      else continue;
      elements.push({ tags, geometryParts: parts.map(part => part.map(point => ({ lon: point[0]!, lat: point[1]! }))), labelOnly: name === "transportation_name" });
    }
  }
  return elements;
}

export class StreetTileClient {
  private metadata?: { template: string; maxzoom: number; at: number };
  private readonly cache = new Map<string, { data: Buffer; at: number }>();
  private cacheBytes = 0;
  constructor(private readonly request: typeof fetch, private readonly fallbackRequest?: typeof fetch) {}
  private async read(url: string, limit: number, signal: AbortSignal): Promise<Buffer> {
    for (const request of [this.request, ...(this.fallbackRequest ? [this.fallbackRequest] : [])]) {
      try {
        return await bytes(await request(url, { redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]), headers: { "User-Agent": userAgent } }), limit);
      } catch { signal.throwIfAborted(); }
    }
    throw new Error("MAP_TILE_FETCH_FAILED");
  }
  async load(center: { latitude: number; longitude: number }, radius: number, bounds: number[], deadline: AbortSignal): Promise<{ elements: StreetElement[] }> {
    const cancelled = new AbortController(), signal = AbortSignal.any([deadline, AbortSignal.timeout(16000), cancelled.signal]);
    if (!this.metadata || Date.now() - this.metadata.at > 3600000) {
      const data = record(JSON.parse((await this.read("https://tiles.openfreemap.org/planet", 64000, signal)).toString("utf8")));
      const template = Array.isArray(data.tiles) ? data.tiles[0] : undefined;
      if (typeof template !== "string" || !/^https:\/\/tiles\.openfreemap\.org\/planet\/[a-zA-Z0-9_-]+\/\{z\}\/\{x\}\/\{y\}\.pbf$/.test(template)) throw new Error("MAP_TILE_SOURCE_INVALID");
      this.metadata = { template, maxzoom: typeof data.maxzoom === "number" ? Math.max(0, Math.min(16, data.maxzoom)) : 14, at: Date.now() };
    }
    // Choose a zoom whose tile covers the viewport width: never fetch more than 2 × 2 tiles.
    const zoom = Math.max(0, Math.min(this.metadata.maxzoom, Math.floor(Math.log2(40030228.9 * Math.cos(center.latitude * Math.PI / 180) / (radius * 5.5)))));
    const count = 2 ** zoom, tileX = (lon: number) => Math.max(0, Math.min(count - 1, Math.floor((lon + 180) / 360 * count)));
    const tileY = (lat: number) => Math.max(0, Math.min(count - 1, Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * count)));
    const coordinates: Array<{ x: number; y: number }> = [];
    for (let x = tileX(bounds[1]!); x <= tileX(bounds[3]!); x++) for (let y = tileY(bounds[2]!); y <= tileY(bounds[0]!); y++) coordinates.push({ x, y });
    if (coordinates.length > 6) throw new Error("MAP_TILE_BOUNDS_INVALID");
    const elements: StreetElement[] = [];
    // Two workers per map, at most four requests across the two permitted map reads.
    let next = 0;
    const worker = async () => {
      for (;;) {
        const point = coordinates[next++]; if (!point) return;
        const url = this.metadata!.template.replace("{z}", String(zoom)).replace("{x}", String(point.x)).replace("{y}", String(point.y));
        const cached = this.cache.get(url); let data: Buffer;
        if (cached && Date.now() - cached.at < 3600000) data = cached.data;
        else {
          data = await this.read(url, 2 * 1024 * 1024, signal);
          if (cached) { this.cacheBytes -= cached.data.length; this.cache.delete(url); }
          this.cache.set(url, { data, at: Date.now() }); this.cacheBytes += data.length;
          while (this.cacheBytes > 8 * 1024 * 1024) { const key = this.cache.keys().next().value!; this.cacheBytes -= this.cache.get(key)!.data.length; this.cache.delete(key); }
        }
        elements.push(...streetTile(data, point.x, point.y, zoom));
      }
    };
    try { await Promise.all([worker(), worker()]); }
    catch (error) { cancelled.abort(); throw error; }
    return { elements };
  }
}
