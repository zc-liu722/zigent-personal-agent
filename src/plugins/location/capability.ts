import type { LocationAccessConfig } from "../../config.js";
import type { ReverseGeocoder } from "../../location/amap.js";
import { analyzeLocationMotion, type LocationMotionAnalysis, type LocationPoint } from "./motion.js";
import type { UserLocationStore, LocationHistoryPage, LocationHistoryQuery, StoredGeocode, StoredLocation } from "../../location/store.js";
import { distanceMeters, wgs84ToGcj02 } from "../../location/coordinates.js";
import { interpolateMessageLocation, locationIntervalIsStationary } from "../../location/message-location.js";

/** Domain queries borrow the host store and transport; disposal never closes either. */
export class LocationCapability {
  constructor(readonly store: UserLocationStore, readonly config: Pick<LocationAccessConfig,"publicUrl">, private readonly reverseGeocoder?: ReverseGeocoder) {}

  /** Indexed nearest neighbours, independent of history pagination and live region state. */
  positionAt(at: number) {
    if (!Number.isSafeInteger(at) || at < 0) throw new Error("Invalid location query time");
    const observedBefore = this.store.latest(at);
    const observedAfter = this.store.atOrAfter(at);
    const before = observedBefore ? this.store.withRegionContext(observedBefore, false) : undefined;
    const after = observedAfter ? this.store.withRegionContext(observedAfter, false) : undefined;
    const exact = before?.observedAt === at ? before : undefined;
    if (exact) return {
      before: exact, after: exact, method: "observed" as const, estimated: false,
      coordinates: { latitude: exact.gcj02Latitude, longitude: exact.gcj02Longitude },
      speedKph: exact.velocityKph ?? null
    };
    if (!before || !after) return { before, after, method: "insufficient_coverage" as const, estimated: false };
    const estimate = interpolateMessageLocation(before, after, at);
    return {
      before, after, estimated: true,
      method: locationIntervalIsStationary(before, after) ? "stationary_estimate" as const : "linear_interpolation" as const,
      coordinates: wgs84ToGcj02(estimate.wgs84Latitude, estimate.wgs84Longitude),
      speedKph: estimate.velocityKph,
      intervalMs: after.observedAt - before.observedAt,
      distanceMeters: distanceMeters(
        { latitude: before.wgs84Latitude, longitude: before.wgs84Longitude },
        { latitude: after.wgs84Latitude, longitude: after.wgs84Longitude }
      ),
      ratio: (at - before.observedAt) / (after.observedAt - before.observedAt)
    };
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

}
