import type { StoredGeocode } from "./store.js";

const AMAP_REVERSE_GEOCODE_URL = "https://restapi.amap.com/v3/geocode/regeo";
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numeric(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function coordinate(value: unknown): { longitude: number; latitude: number } | undefined {
  const parts = text(value)?.split(",");
  if (!parts || parts.length !== 2) return undefined;
  const longitude = Number(parts[0]);
  const latitude = Number(parts[1]);
  return Number.isFinite(longitude) && Number.isFinite(latitude) ? { longitude, latitude } : undefined;
}

function normalizePois(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const source = record(item);
    if (!source) return [];
    const point = coordinate(source.location);
    const normalized = {
      ...(text(source.id) ? { id: text(source.id) } : {}),
      ...(text(source.name) ? { name: text(source.name) } : {}),
      ...(text(source.type) ? { type: text(source.type) } : {}),
      ...(text(source.typecode) ? { typecode: text(source.typecode) } : {}),
      ...(text(source.address) ? { address: text(source.address) } : {}),
      ...(numeric(source.distance) === undefined ? {} : { distance_meters: numeric(source.distance) }),
      ...(text(source.direction) ? { direction: text(source.direction) } : {}),
      ...(point ? { longitude: point.longitude, latitude: point.latitude } : {})
    };
    return Object.keys(normalized).length > 0 ? [normalized] : [];
  });
}

function normalizeAois(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const source = record(item);
    if (!source) return [];
    const point = coordinate(source.location);
    const normalized = {
      ...(text(source.id) ? { id: text(source.id) } : {}),
      ...(text(source.name) ? { name: text(source.name) } : {}),
      ...(text(source.type) ? { type: text(source.type) } : {}),
      ...(text(source.adcode) ? { adcode: text(source.adcode) } : {}),
      ...(numeric(source.distance) === undefined ? {} : { distance_meters: numeric(source.distance) }),
      ...(numeric(source.area) === undefined ? {} : { area_square_meters: numeric(source.area) }),
      ...(point ? { longitude: point.longitude, latitude: point.latitude } : {})
    };
    return Object.keys(normalized).length > 0 ? [normalized] : [];
  });
}

export interface ReverseGeocoder {
  reverse(input: {
    latitude: number;
    longitude: number;
    radiusMeters: number;
    now: number;
    signal?: AbortSignal;
  }): Promise<Omit<StoredGeocode, "id">>;
}

export class AmapReverseGeocoder implements ReverseGeocoder {
  constructor(
    private readonly apiKey: string,
    private readonly request: typeof fetch = fetch
  ) {}

  async reverse(input: {
    latitude: number;
    longitude: number;
    radiusMeters: number;
    now: number;
    signal?: AbortSignal;
  }): Promise<Omit<StoredGeocode, "id">> {
    const url = new URL(AMAP_REVERSE_GEOCODE_URL);
    url.searchParams.set("key", this.apiKey);
    url.searchParams.set("location", `${input.longitude.toFixed(6)},${input.latitude.toFixed(6)}`);
    url.searchParams.set("radius", String(Math.max(0, Math.min(3000, Math.round(input.radiusMeters)))));
    url.searchParams.set("extensions", "all");
    url.searchParams.set("output", "JSON");
    const timeout = AbortSignal.timeout(8_000);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    const response = await this.request(url, { signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`AMAP_HTTP_${response.status}`);
    const body = await response.json() as unknown;
    const root = record(body);
    if (!root || root.status !== "1") throw new Error(`AMAP_${text(root?.infocode) ?? "INVALID_RESPONSE"}`);
    const reverse = record(root.regeocode);
    const component = record(reverse?.addressComponent);
    const streetNumber = record(component?.streetNumber);
    if (!reverse || !component) throw new Error("AMAP_INVALID_RESPONSE");
    return {
      provider: "amap",
      queryLatitude: input.latitude,
      queryLongitude: input.longitude,
      queryRadiusMeters: Math.max(0, Math.min(3000, Math.round(input.radiusMeters))),
      ...(text(reverse.formatted_address) ? { formattedAddress: text(reverse.formatted_address) } : {}),
      ...(text(component.country) ? { country: text(component.country) } : {}),
      ...(text(component.province) ? { province: text(component.province) } : {}),
      ...(text(component.city) ? { city: text(component.city) } : {}),
      ...(text(component.district) ? { district: text(component.district) } : {}),
      ...(text(component.township) ? { township: text(component.township) } : {}),
      ...(text(component.adcode) ? { adcode: text(component.adcode) } : {}),
      ...(text(component.citycode) ? { citycode: text(component.citycode) } : {}),
      ...(text(streetNumber?.street) ? { street: text(streetNumber?.street) } : {}),
      ...(text(streetNumber?.number) ? { streetNumber: text(streetNumber?.number) } : {}),
      pois: normalizePois(reverse.pois),
      aois: normalizeAois(reverse.aois),
      fetchedAt: input.now,
      reuseUntil: input.now + ONE_YEAR_MS,
      responseVersion: 1
    };
  }
}
