import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { LocationAccessConfig, LocationReceiverConfig } from "../config.js";
import { AmapReverseGeocoder, type ReverseGeocoder } from "./amap.js";
import { wgs84ToGcj02 } from "./coordinates.js";
import { analyzeLocationMotion, type LocationMotionAnalysis, type LocationPoint } from "./motion.js";
import { UserLocationStore, type LocationHistoryPage, type LocationHistoryQuery, type StoredGeocode, type StoredLocation, type StoredRegionEvent, type StoredWaypoint } from "./store.js";

import { proxyWebRequest, proxyWebUpgrade } from "../web/proxy.js";

const INGEST_PATH = "/v1/location/owntracks";
const SAFE_INGEST_ERROR = /^(BODY_TOO_LARGE|INVALID_[A-Z0-9_]+|UNSUPPORTED_PAYLOAD)$/;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

function ingestErrorCode(error: unknown): string {
  const code = error instanceof Error ? error.message : "INVALID_REQUEST";
  return SAFE_INGEST_ERROR.test(code) ? code : "INVALID_REQUEST";
}

function authorized(request: IncomingMessage, username: string, password: string): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  const suppliedUsername = Buffer.from(decoded.slice(0, separator));
  const suppliedPassword = Buffer.from(decoded.slice(separator + 1));
  const expectedUsername = Buffer.from(username);
  const expectedPassword = Buffer.from(password);
  return suppliedUsername.length === expectedUsername.length
    && suppliedPassword.length === expectedPassword.length
    && timingSafeEqual(suppliedUsername, expectedUsername)
    && timingSafeEqual(suppliedPassword, expectedPassword);
}

async function readBody(request: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) throw new Error("BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedNumber(record: Record<string, unknown>, key: string, minimum: number, maximum: number): number | undefined {
  const value = optionalNumber(record, key);
  return value !== undefined && value >= minimum && value <= maximum ? value : undefined;
}

function waypointTimestamp(record: Record<string, unknown>): number | undefined {
  if (record.wtst === undefined) return undefined;
  const seconds = optionalNumber(record, "wtst");
  if (seconds === undefined || !Number.isSafeInteger(seconds) || seconds < 0 || seconds > Number.MAX_SAFE_INTEGER / 1000)
    throw new Error("INVALID_WAYPOINT_TIMESTAMP");
  return seconds * 1000;
}

function triggerCode(value: string | undefined): string {
  return ({
    p: "background_ping",
    c: "circular_region",
    C: "follow_region",
    b: "beacon_region",
    r: "remote_request",
    u: "manual",
    t: "timer",
    v: "frequent_locations",
    l: "location_update"
  } as Record<string, string>)[value ?? ""] ?? (value ? `unknown:${value}` : "automatic");
}

function ownTracksWaypoint(value: unknown, now: number): StoredWaypoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_WAYPOINT");
  const record = value as Record<string, unknown>;
  if (record._type !== "waypoint") throw new Error("INVALID_WAYPOINT");
  if (typeof record.desc !== "string" || !record.desc.trim() || record.desc.length > 128) {
    throw new Error("INVALID_WAYPOINT_DESCRIPTION");
  }
  const validateOptionalText = (key: string): void => {
    const candidate = record[key];
    if (candidate !== undefined && (typeof candidate !== "string" || !candidate.trim() || candidate.length > 128)) {
      throw new Error(`INVALID_WAYPOINT_${key.toUpperCase()}`);
    }
  };
  const validateOptionalNumber = (key: string, minimum: number, maximum: number): void => {
    const candidate = record[key];
    if (candidate !== undefined && (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < minimum || candidate > maximum)) {
      throw new Error(`INVALID_WAYPOINT_${key.toUpperCase()}`);
    }
  };
  validateOptionalText("rid");
  validateOptionalText("uuid");
  validateOptionalNumber("lat", -90, 90);
  validateOptionalNumber("lon", -180, 180);
  validateOptionalNumber("rad", 0, 100_000);
  validateOptionalNumber("tst", 0, Number.MAX_SAFE_INTEGER);
  validateOptionalNumber("wtst", 0, Number.MAX_SAFE_INTEGER);
  const timestampSeconds = optionalNumber(record, "tst") ?? optionalNumber(record, "wtst");
  return {
    ...(typeof record.rid === "string" ? { regionId: record.rid.trim() } : {}),
    description: (record.desc as string).trim(),
    ...(optionalNumber(record, "lat") === undefined ? {} : { wgs84Latitude: optionalNumber(record, "lat") }),
    ...(optionalNumber(record, "lon") === undefined ? {} : { wgs84Longitude: optionalNumber(record, "lon") }),
    ...(optionalNumber(record, "rad") === undefined ? {} : { radiusMeters: optionalNumber(record, "rad") }),
    ...(timestampSeconds === undefined ? {} : { createdAt: Math.round(timestampSeconds * 1000) }),
    receivedAt: now
  };
}

function ownTracksRegionEvent(value: unknown, now: number): StoredRegionEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_PAYLOAD");
  const record = value as Record<string, unknown>;
  if (record._type !== "transition") throw new Error("UNSUPPORTED_PAYLOAD");
  const optionalText = (key: string): string | undefined => {
    const candidate = record[key];
    return typeof candidate === "string" && candidate.trim() ? candidate.trim().slice(0, 128) : undefined;
  };
  const eventType = optionalText("event");
  if (eventType !== "enter" && eventType !== "leave") throw new Error("INVALID_TRANSITION_EVENT");
  const regionId = optionalText("rid");
  const regionDescription = optionalText("desc");
  const waypointCreatedAt = waypointTimestamp(record);
  if (!regionId && !regionDescription && waypointCreatedAt === undefined) throw new Error("INVALID_TRANSITION_REGION");
  const latitude = optionalNumber(record, "lat");
  const longitude = optionalNumber(record, "lon");
  if (latitude !== undefined && (latitude < -90 || latitude > 90)) throw new Error("INVALID_LATITUDE");
  if (longitude !== undefined && (longitude < -180 || longitude > 180)) throw new Error("INVALID_LONGITUDE");
  const timestampSeconds = optionalNumber(record, "tst");
  const observedAt = timestampSeconds === undefined ? now : Math.round(timestampSeconds * 1000);
  if (observedAt > now + 5 * 60_000 || observedAt < now - 30 * 24 * 60 * 60_000) throw new Error("INVALID_TIMESTAMP");
  return {
    ...(regionId ? { regionId } : {}),
    ...(regionDescription ? { regionDescription } : {}),
    ...(waypointCreatedAt === undefined ? {} : { waypointCreatedAt }),
    eventType,
    triggerCode: triggerCode(optionalText("t")),
    ...(boundedNumber(record, "vel", 0, 2_000) === undefined ? {} : { velocityKph: boundedNumber(record, "vel", 0, 2_000) }),
    observedAt,
    receivedAt: now
  };
}

function ownTracksLocation(value: unknown, now: number): StoredLocation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_PAYLOAD");
  const record = value as Record<string, unknown>;
  if (record._type !== "location" && record._type !== "transition") throw new Error("UNSUPPORTED_PAYLOAD");
  const latitude = optionalNumber(record, "lat");
  const longitude = optionalNumber(record, "lon");
  if (latitude === undefined || latitude < -90 || latitude > 90) throw new Error("INVALID_LATITUDE");
  if (longitude === undefined || longitude < -180 || longitude > 180) throw new Error("INVALID_LONGITUDE");
  const timestampSeconds = optionalNumber(record, "tst");
  const observedAt = timestampSeconds === undefined ? now : Math.round(timestampSeconds * 1000);
  if (observedAt > now + 5 * 60_000 || observedAt < now - 30 * 24 * 60 * 60_000) {
    throw new Error("INVALID_TIMESTAMP");
  }
  const text = (key: string): string | undefined => {
    const candidate = record[key];
    return typeof candidate === "string" && candidate.trim() ? candidate.trim().slice(0, 128) : undefined;
  };
  const strings = (key: string): readonly string[] | undefined => {
    const candidate = record[key];
    if (!Array.isArray(candidate)) return undefined;
    const values = candidate.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      .map((item) => item.trim().slice(0, 128));
    return values;
  };
  const gcj02 = wgs84ToGcj02(latitude, longitude);
  const event = text("event");
  if (record._type === "transition") ownTracksRegionEvent(value, now);
  const waypointCreatedAt = record._type === "transition" ? waypointTimestamp(record) : undefined;
  return {
    payloadType: record._type,
    wgs84Latitude: latitude,
    wgs84Longitude: longitude,
    gcj02Latitude: gcj02.latitude,
    gcj02Longitude: gcj02.longitude,
    ...(boundedNumber(record, "acc", 0, 100_000) === undefined ? {} : { accuracyMeters: boundedNumber(record, "acc", 0, 100_000) }),
    ...(boundedNumber(record, "alt", -20_000, 100_000) === undefined ? {} : { altitudeMeters: boundedNumber(record, "alt", -20_000, 100_000) }),
    ...(boundedNumber(record, "vac", 0, 100_000) === undefined ? {} : { verticalAccuracyMeters: boundedNumber(record, "vac", 0, 100_000) }),
    ...(boundedNumber(record, "batt", 0, 100) === undefined ? {} : { batteryPercent: boundedNumber(record, "batt", 0, 100) }),
    ...(boundedNumber(record, "vel", 0, 2_000) === undefined ? {} : { velocityKph: boundedNumber(record, "vel", 0, 2_000) }),
    ...(boundedNumber(record, "cog", 0, 360) === undefined ? {} : { courseDegrees: boundedNumber(record, "cog", 0, 360) }),
    triggerCode: triggerCode(text("t")),
    ...(event === "enter" || event === "leave" ? { eventType: event } : {}),
    ...(text("rid") ? { regionId: text("rid") } : {}),
    ...(text("desc") ? { regionDescription: text("desc") } : {}),
    ...(waypointCreatedAt === undefined ? {} : { waypointCreatedAt }),
    ...(strings("inregions") === undefined ? {} : { inRegions: strings("inregions") }),
    ...(strings("inrids") === undefined ? {} : { inRegionIds: strings("inrids") }),
    observedAt,
    receivedAt: now
  };
}

export class UserLocationAccess {
  private constructor(
    readonly store: UserLocationStore,
    readonly config: LocationAccessConfig,
    private readonly reverseGeocoder?: ReverseGeocoder
  ) {}

  static async create(config: LocationAccessConfig, reverseGeocoder?: ReverseGeocoder): Promise<UserLocationAccess> {
    return new UserLocationAccess(
      await UserLocationStore.open(config.storagePath),
      config,
      reverseGeocoder ?? (config.amapApiKey ? new AmapReverseGeocoder(config.amapApiKey) : undefined)
    );
  }

  private async geocodeLocation(
    location: LocationPoint,
    signal: AbortSignal | undefined,
    now: number
  ): Promise<{
    location: LocationPoint;
    geocode?: StoredGeocode;
    geocodeStatus: "available" | "unconfigured" | "unavailable";
  }> {
    const linked = location.geocodeId === undefined ? undefined : this.store.geocodeById(location.geocodeId);
    if (linked && linked.reuseUntil >= now) return { location, geocode: linked, geocodeStatus: "available" };
    const reusable = this.store.findReusableGeocode(location.gcj02Latitude, location.gcj02Longitude, now);
    if (reusable) {
      this.store.linkGeocode(location.id, reusable.id);
      return { location: { ...location, geocodeId: reusable.id }, geocode: reusable, geocodeStatus: "available" };
    }
    if (!this.reverseGeocoder) return { location, geocodeStatus: "unconfigured" };
    try {
      const geocode = this.store.saveGeocode(await this.reverseGeocoder.reverse({
        latitude: location.gcj02Latitude,
        longitude: location.gcj02Longitude,
        radiusMeters: Math.min(3000, Math.max(100, Math.round((location.accuracyMeters ?? 50) * 2))),
        now,
        signal
      }));
      this.store.linkGeocode(location.id, geocode.id);
      return { location: { ...location, geocodeId: geocode.id }, geocode, geocodeStatus: "available" };
    } catch {
      signal?.throwIfAborted();
      return { location, geocodeStatus: "unavailable" };
    }
  }

  async latestWithGeocode(signal?: AbortSignal, now = Date.now()): Promise<{
    location?: StoredLocation & { id: number };
    geocode?: StoredGeocode;
    geocodeStatus?: "available" | "unconfigured" | "unavailable";
  }> {
    const latest = this.store.latest();
    if (!latest) return {};
    const location = this.store.withRegionContext(latest);
    return this.geocodeLocation(location, signal, now);
  }

  async motionWithGeocodes(signal?: AbortSignal, now = Date.now()): Promise<{
    analysis?: LocationMotionAnalysis;
    geocodes: ReadonlyMap<number, { geocode?: StoredGeocode; status: "available" | "unconfigured" | "unavailable" }>;
  }> {
    const history = [...this.store.historyNewestFirst()];
    if (history[0]) history[0] = this.store.withRegionContext(history[0]);
    const analysis = analyzeLocationMotion(history, now);
    if (!analysis) return { geocodes: new Map() };
    const markers = analysis.state === "moving"
      ? [analysis.start, ...analysis.turningPoints, analysis.end]
      : [analysis.location];
    const uniqueMarkers = [...new Map(markers.map((point) => [point.id, point])).values()];
    const geocodes = new Map<number, { geocode?: StoredGeocode; status: "available" | "unconfigured" | "unavailable" }>();
    for (const marker of uniqueMarkers) {
      signal?.throwIfAborted();
      const resolved = await this.geocodeLocation(marker, signal, now);
      geocodes.set(marker.id, {
        ...(resolved.geocode ? { geocode: resolved.geocode } : {}),
        status: resolved.geocodeStatus
      });
    }
    return { analysis, geocodes };
  }

  async historyWithGeocodes(query: LocationHistoryQuery, signal?: AbortSignal, now = Date.now()): Promise<{
    page: LocationHistoryPage;
    geocodes: ReadonlyMap<number, { geocode?: StoredGeocode; status: "available" | "unconfigured" | "unavailable" | "not_requested" }>;
  }> {
    signal?.throwIfAborted();
    const page = this.store.history(query);
    const geocodes = new Map<number, { geocode?: StoredGeocode; status: "available" | "unconfigured" | "unavailable" | "not_requested" }>();
    let lookups = 0;
    for (const point of page.points) {
      signal?.throwIfAborted();
      // A linked historical address remains evidence even after its reuse period expires.
      const cached = (point.geocodeId === undefined ? undefined : this.store.geocodeById(point.geocodeId))
        ?? this.store.findReusableGeocode(point.gcj02Latitude, point.gcj02Longitude, now);
      if (cached) {
        if (point.geocodeId !== cached.id) this.store.linkGeocode(point.id, cached.id);
        geocodes.set(point.id, { geocode: cached, status: "available" });
      } else if (!this.reverseGeocoder) {
        geocodes.set(point.id, { status: "unconfigured" });
      } else if (lookups >= 5) {
        geocodes.set(point.id, { status: "not_requested" });
      } else {
        lookups += 1;
        const resolved = await this.geocodeLocation(point, signal, now);
        geocodes.set(point.id, { geocode: resolved.geocode, status: resolved.geocodeStatus });
      }
    }
    return { page, geocodes };
  }

  close(): void {
    this.store.close();
  }
}

export class UserLocationReceiver {
  private extension?: { handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>; close(): void };
  attachExtension(extension: { handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>; close(): void }) { this.extension = extension; }
  private server?: Server;
  private upgrades = new Set<Duplex>();

  private constructor(
    readonly store: UserLocationStore,
    readonly config: LocationReceiverConfig
  ) {}

  static async create(config: LocationReceiverConfig): Promise<UserLocationReceiver> {
    return new UserLocationReceiver(await UserLocationStore.open(config.storagePath), config);
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((request, response) => void this.handle(request, response));
    server.on("upgrade", (request, socket, head) => {
      this.upgrades.add(socket); socket.once("close", () => this.upgrades.delete(socket));
      const route = this.webRoute(new URL(request.url ?? "/", "http://localhost").pathname);
      if (route) proxyWebUpgrade(request, socket, head, route.port, `${route.basePath}api/speech`);
      else socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(this.config.listenPort, this.config.listenHost, () => {
        server.off("error", onError);
        resolve();
      });
    });
    this.server = server;
    console.info(`User location receiver listening on http://${this.config.listenHost}:${this.config.listenPort}${INGEST_PATH}`);
  }

  localBaseUrl(): string {
    const address = this.server?.address();
    if (!address || typeof address === "string") throw new Error("User location receiver is not listening");
    return `http://${this.config.listenHost}:${address.port}`;
  }

  private webRoute(path: string): { basePath: string; port: number } | undefined {
    const routes = this.config.webProxyRoutes ?? (this.config.webProxyPort ? [{ basePath: "/deepmind/", port: this.config.webProxyPort }] : []);
    return routes.find(route => path === route.basePath.slice(0, -1) || path.startsWith(route.basePath));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const startedAt = Date.now();
    response.setHeader("X-Request-Id", requestId);
    let isIngest = false;
    let bodyBytes: number | undefined;
    let payloadAudit: Record<string, unknown> = {};
    const audit = (status: number, outcome: string, errorCode?: string): void => {
      if (!isIngest) return;
      console.info(JSON.stringify({
        event: "owntracks_ingest",
        request_id: requestId,
        status,
        outcome,
        duration_ms: Date.now() - startedAt,
        ...(bodyBytes === undefined ? {} : { body_bytes: bodyBytes }),
        ...payloadAudit,
        ...(errorCode ? { error_code: errorCode } : {})
      }));
    };
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (await this.extension?.handle(request, response)) return;
      const route = this.webRoute(url.pathname);
      if (route) {
        proxyWebRequest(request, response, route.port);
        return;
      }
      if (request.method === "GET" && url.pathname === "/healthz") {
        sendJson(response, 200, { status: "ok" });
        return;
      }
      if (request.method !== "POST" || url.pathname !== INGEST_PATH) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      isIngest = true;
      if (!authorized(request, this.config.username, this.config.password)) {
        response.setHeader("WWW-Authenticate", 'Basic realm="OwnTracks"');
        sendJson(response, 401, { error: "unauthorized" });
        audit(401, "rejected", "UNAUTHORIZED");
        return;
      }
      const body = await readBody(request, this.config.maxBodyBytes);
      bodyBytes = body.length;
      if (body.length === 0) {
        sendJson(response, 200, []);
        audit(200, "ignored_empty");
        return;
      }
      const payloadJson = body.toString("utf8");
      const payload = JSON.parse(payloadJson) as unknown;
      const rawType = payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)._type
        : undefined;
      payloadAudit = { payload_type: typeof rawType === "string" ? rawType.slice(0, 64) : "unknown" };
      if (rawType === "waypoints") {
        const entries = (payload as Record<string, unknown>).waypoints;
        if (!Array.isArray(entries) || entries.length > 256) throw new Error("INVALID_WAYPOINTS");
        const now = Date.now();
        // Validate the entire batch before any durable changes.
        const waypoints = entries.map(entry => ownTracksWaypoint(entry, now));
        this.store.saveWaypoints(waypoints, entries.map(entry => JSON.stringify(entry)));
        sendJson(response, 200, []);
        audit(200, "stored_waypoints");
        return;
      }
      if (payload && typeof payload === "object" && !Array.isArray(payload)
        && (payload as Record<string, unknown>)._type === "waypoint") {
        const waypoint = ownTracksWaypoint(payload, Date.now());
        payloadAudit = {
          payload_type: "waypoint",
          has_region_id: Boolean(waypoint.regionId),
          has_region_description: true
        };
        this.store.saveWaypoint(waypoint, payloadJson);
        sendJson(response, 200, []);
        audit(200, "stored_waypoint");
        return;
      }
      if (payload && typeof payload === "object" && !Array.isArray(payload)
        && (payload as Record<string, unknown>)._type === "transition"
        && (optionalNumber(payload as Record<string, unknown>, "lat") === undefined
          || optionalNumber(payload as Record<string, unknown>, "lon") === undefined)) {
        const event = ownTracksRegionEvent(payload, Date.now());
        payloadAudit = {
          payload_type: "transition",
          observed_at: new Date(event.observedAt).toISOString(),
          trigger: event.triggerCode,
          transition_event: event.eventType,
          has_region_id: Boolean(event.regionId),
          has_region_description: Boolean(event.regionDescription),
          coordinates_present: false,
          inregions_count: null,
          inrids_count: null
        };
        const result = this.store.saveRegionEvent(event, payloadJson);
        sendJson(response, 200, []);
        audit(200, result === "stored" ? "stored_region_event" : "duplicate_region_event");
        return;
      }
      const location = ownTracksLocation(payload, Date.now());
      payloadAudit = {
        payload_type: location.payloadType,
        observed_at: new Date(location.observedAt).toISOString(),
        trigger: location.triggerCode,
        ...(location.eventType ? { transition_event: location.eventType } : {}),
        has_region_id: Boolean(location.regionId),
        has_region_description: Boolean(location.regionDescription),
        coordinates_present: true,
        inregions_count: location.inRegions?.length ?? null,
        inrids_count: location.inRegionIds?.length ?? null
      };
      const result = this.store.save(location, payloadJson);
      sendJson(response, 200, []);
      audit(200, result === "stored" ? "stored_location" : "duplicate_location");
    } catch (error) {
      const code = ingestErrorCode(error);
      const status = code === "BODY_TOO_LARGE" ? 413 : 400;
      sendJson(response, status, { error: "invalid_request" });
      audit(status, "rejected", code);
    }
  }

  async close(): Promise<void> {
    this.extension?.close();
    for (const socket of this.upgrades) socket.destroy();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    this.store.close();
  }
}
