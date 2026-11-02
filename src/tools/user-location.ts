import { z } from "zod";
import type { UserLocationAccess } from "../location/service.js";
import {
  MOVEMENT_MAX_INTERVAL_MS,
  MOVEMENT_MIN_DISTANCE_METERS,
  STATIONARY_CONFIRMATION_MS,
  TURN_MIN_ANGLE_DEGREES,
  type LocationMotionAnalysis,
  type LocationPoint
} from "../location/motion.js";
import type { StoredGeocode, StoredLocation } from "../location/store.js";
import type { AgentToolRegistration } from "./registry.js";

const historyInput = z.object({
  action: z.literal("history"),
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional()
}).strict();
const regionsInput = z.object({ action: z.literal("regions"), limit: z.number().int().min(1).max(100).default(100) }).strict();
type UserLocationInput = { action: "claim" | "get" | "revoke" } | z.infer<typeof historyInput> | z.infer<typeof regionsInput>;

function parseInput(value: unknown): UserLocationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("user_location input must be an object");
  const action = (value as Record<string, unknown>).action;
  if (action === "history") return historyInput.parse(value);
  if (action === "regions") return regionsInput.parse(value);
  if (action !== "claim" && action !== "get" && action !== "revoke") {
    throw new Error("action must be claim, get, history, regions, or revoke");
  }
  return { action };
}

function beijingTime(timestamp: number, precise = false): string {
  const shifted = new Date(timestamp + 8 * 60 * 60 * 1000).toISOString();
  return `${shifted.slice(0, precise && timestamp % 1000 !== 0 ? 23 : 19)}+08:00`;
}

function relativeTime(seconds: number): string {
  if (seconds < 60) return "刚刚";
  if (seconds < 60 * 60) return `约${Math.round(seconds / 60)}分钟前`;
  if (seconds < 24 * 60 * 60) return `约${Math.round(seconds / 3600)}小时前`;
  return `约${Math.round(seconds / 86_400)}天前`;
}

function freshness(seconds: number): "fresh" | "recent" | "stale" | "very_stale" {
  if (seconds <= 5 * 60) return "fresh";
  if (seconds <= 30 * 60) return "recent";
  if (seconds <= 6 * 60 * 60) return "stale";
  return "very_stale";
}

function durationText(seconds: number): string {
  if (seconds < 60) return "不足1分钟";
  if (seconds < 60 * 60) return `约${Math.round(seconds / 60)}分钟`;
  if (seconds < 24 * 60 * 60) return `约${Math.round(seconds / 3600)}小时`;
  return `约${Math.round(seconds / 86_400)}天`;
}

function courseDirection(degrees: number): string {
  return ["北", "东北", "东", "东南", "南", "西南", "西", "西北"][Math.round(degrees / 45) % 8]!;
}

function placeOutput(geocode: StoredGeocode): Record<string, unknown> {
  return {
    ...(geocode.formattedAddress ? { formatted_address: geocode.formattedAddress } : {}),
    ...(geocode.country ? { country: geocode.country } : {}),
    ...(geocode.province ? { province: geocode.province } : {}),
    ...(geocode.city ? { city: geocode.city } : {}),
    ...(geocode.district ? { district: geocode.district } : {}),
    ...(geocode.township ? { township: geocode.township } : {}),
    ...(geocode.adcode ? { adcode: geocode.adcode } : {}),
    ...(geocode.citycode ? { citycode: geocode.citycode } : {}),
    ...(geocode.street ? { street: geocode.street } : {}),
    ...(geocode.streetNumber ? { street_number: geocode.streetNumber } : {}),
    ...(geocode.pois.length > 0 ? { nearby_pois: geocode.pois.slice(0, 5) } : {}),
    ...(geocode.aois.length > 0 ? { nearby_aois: geocode.aois.slice(0, 3) } : {}),
    provider: "amap"
  };
}

function ownTracksRegionOutput(location: StoredLocation): Record<string, unknown> | undefined {
  const regions = location.inRegions?.length
    ? location.inRegions
    : location.regionDescription
      ? [location.regionDescription]
      : undefined;
  const regionIds = location.inRegionIds?.length
    ? location.inRegionIds
    : location.regionId
      ? [location.regionId]
      : undefined;
  if (!regions && !regionIds) return undefined;
  return {
    provider: "owntracks",
    type: "region",
    ...(regions ? { regions } : {}),
    ...(regionIds ? { region_ids: regionIds } : {}),
    ...(location.regionId ? { region_id: location.regionId } : {}),
    ...(location.eventType ? { event: location.eventType } : {})
  };
}

function regionSummary(location: StoredLocation): string | undefined {
  if (location.inRegions?.length) return `位于${location.inRegions.join("、")}`;
  if (location.regionDescription) {
    if (location.eventType === "enter") return `进入${location.regionDescription}`;
    if (location.eventType === "leave") return `离开${location.regionDescription}`;
    return location.regionDescription;
  }
  if (location.regionId || location.inRegionIds?.length) return "OwnTracks 已识别区域";
  return undefined;
}

type GeocodeResult = {
  geocode?: StoredGeocode;
  status: "available" | "unconfigured" | "unavailable" | "not_requested";
};

function pointOutput(point: LocationPoint, geocode?: GeocodeResult): Record<string, unknown> {
  return {
    coordinates: {
      system: "GCJ-02",
      longitude: point.gcj02Longitude,
      latitude: point.gcj02Latitude
    },
    observed_at: beijingTime(point.observedAt),
    ...(geocode?.geocode ? { place: placeOutput(geocode.geocode) } : {}),
    ...(!geocode?.geocode && geocode?.status ? { place_lookup: geocode.status } : {})
  };
}

function movementOutput(
  analysis: LocationMotionAnalysis,
  geocodes: ReadonlyMap<number, GeocodeResult>
): Record<string, unknown> {
  const detection = {
    maximum_interval_minutes: MOVEMENT_MAX_INTERVAL_MS / 60_000,
    movement_distance_meters: MOVEMENT_MIN_DISTANCE_METERS,
    stationary_confirmation_minutes: STATIONARY_CONFIRMATION_MS / 60_000,
    turn_angle_degrees: TURN_MIN_ANGLE_DEGREES,
    turn_geometry: "adjacent_trajectory_segments"
  };
  if (analysis.state === "stationary") {
    const durationSeconds = Math.max(0, Math.round(analysis.durationMs / 1000));
    return {
      state: "stationary",
      detection,
      arrived_at: beijingTime(analysis.arrivedAt),
      dwell_seconds: durationSeconds,
      dwell_duration: durationText(durationSeconds),
      last_confirmed_at: beijingTime(analysis.location.observedAt)
    };
  }
  const durationSeconds = Math.max(0, Math.round(analysis.durationMs / 1000));
  return {
    state: "moving",
    detection,
    started_at: beijingTime(analysis.startedAt),
    last_confirmed_at: beijingTime(analysis.end.observedAt),
    duration_seconds: durationSeconds,
    duration: durationText(durationSeconds),
    distance_meters: Math.round(analysis.distanceMeters),
    trajectory_point_count: analysis.trajectory.length,
    trajectory: analysis.trajectory.map((point) => pointOutput(point)),
    start: pointOutput(analysis.start, geocodes.get(analysis.start.id)),
    end: pointOutput(analysis.end, geocodes.get(analysis.end.id)),
    turning_points: analysis.turningPoints.map((point) => pointOutput(point, geocodes.get(point.id)))
  };
}

function semanticLocation(
  location: LocationPoint,
  geocode: StoredGeocode | undefined,
  geocodeStatus: "available" | "unconfigured" | "unavailable" | undefined,
  now: number,
  analysis: LocationMotionAnalysis,
  geocodes: ReadonlyMap<number, GeocodeResult>
): Record<string, unknown> {
  const effectiveObservedAt = Math.min(location.observedAt, location.receivedAt);
  const ageSeconds = Math.max(0, Math.round((now - effectiveObservedAt) / 1000));
  const ownTracksRegion = ownTracksRegionOutput(location);
  const regionLocation = regionSummary(location);
  const summaryLocation = regionLocation
    ? geocode?.formattedAddress
      ? `${regionLocation}（${geocode.formattedAddress}）`
      : regionLocation
    : geocode?.formattedAddress ?? "GCJ-02 坐标所示位置";
  const stateSummary = analysis.state === "moving"
    ? `判断为正在移动，已追溯约${Math.round(analysis.distanceMeters)}米轨迹`
    : `判断为静止，已停留${durationText(Math.round(analysis.durationMs / 1000))}`;
  const summary = `最后已知位置：${summaryLocation}；${stateSummary}；${relativeTime(ageSeconds)}；${location.accuracyMeters === undefined ? "定位精度未知" : `定位精度约${Math.round(location.accuracyMeters)}米`}。`;
  const battery = location.batteryPercent !== undefined && location.batteryPercent < 20
    ? { percent: Math.round(location.batteryPercent), status: "low", message: `当前设备电量较低（${Math.round(location.batteryPercent)}%）` }
    : undefined;
  const altitude = location.altitudeMeters !== undefined && location.altitudeMeters > 2000
    ? {
      meters: Math.round(location.altitudeMeters),
      ...(location.verticalAccuracyMeters === undefined ? {} : { vertical_accuracy_meters: Math.round(location.verticalAccuracyMeters) })
    }
    : undefined;
  const movement = {
    ...movementOutput(analysis, geocodes),
    ...(location.velocityKph === undefined ? {} : { reported_speed_kph: location.velocityKph }),
    ...(location.courseDegrees === undefined ? {} : {
      reported_course_degrees: location.courseDegrees,
      reported_direction: courseDirection(location.courseDegrees)
    })
  };
  return {
    result: "available",
    summary,
    coordinates: {
      system: "GCJ-02",
      longitude: location.gcj02Longitude,
      latitude: location.gcj02Latitude
    },
    time: {
      local: beijingTime(effectiveObservedAt),
      timezone: "Asia/Shanghai",
      relative: relativeTime(ageSeconds),
      freshness: freshness(ageSeconds)
    },
    ...(location.accuracyMeters === undefined ? {} : { accuracy_meters: location.accuracyMeters }),
    ...(ownTracksRegion ? { region: ownTracksRegion } : {}),
    ...(geocode ? { place: placeOutput(geocode) } : {}),
    ...(!geocode && geocodeStatus ? { place_lookup: geocodeStatus } : {}),
    ...(battery ? { battery, alerts: [battery.message] } : {}),
    ...(altitude ? { altitude } : {}),
    movement,
    ...(location.payloadType === "transition" ? {
      geofence_event: {
        ...(location.eventType ? { event: location.eventType } : {}),
        ...(location.regionDescription ? { region: location.regionDescription } : {}),
        ...(location.regionId ? { region_id: location.regionId } : {})
      }
    } : {}),
    report_trigger: location.triggerCode ?? "automatic"
  };
}

export function createUserLocationTool(service: UserLocationAccess): AgentToolRegistration {
  return {
    definition: {
      type: "function",
      name: "user_location",
      description: "Read the user's iPhone location. get analyzes the latest active movement trajectory or current stationary stay. Before configuring a named-region proactive task, use regions to discover exact selectors (prefer regionId) and known waypoint centers/radii; it works even without any coordinate report. If no matching region exists, get/history can supply verified GCJ-02 coordinates for a server-side fence with an Agent-chosen radius; do not invent region names or coordinates. Use history for past locations, including yesterday or a specific time window: provide from/to ISO timestamps with an explicit offset (default interpretation of relative dates is Asia/Shanghai), at most 31 days per query. History returns recorded points oldest-first, not inferred continuous presence; follow next_cursor with the same from/to until has_more=false before claiming a complete range. Use a narrow window for a specific time; an empty range means no recorded evidence, never substitute the current location. History includes saved region context and cached Amap addresses, resolving at most five uncached addresses per page; not_requested means the address lookup budget was reached (use smaller pages if more addresses are needed). Map context includes place_resolved_at and may have been fetched after the observation. Times are Beijing-local and coordinates are GCJ-02. Call claim only when the user explicitly asks to bind this chat identity. Read location only when materially relevant or explicitly requested. Treat results as last-known evidence, not guaranteed real-time presence. Call revoke only on an explicit request to disconnect and erase saved location, region, and geocoding history.",
      input_schema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["claim", "get", "history", "regions", "revoke"],
            description: "claim binds the first user; get reads the latest location; history queries a past time range; regions lists known OwnTracks regions including inactive regions, exact task selectors, GCJ-02 centers and radii; revoke deletes the binding and all saved location data."
          },
          from: { type: "string", format: "date-time", description: "Required for history: inclusive start, ISO timestamp with Z or offset, e.g. 2026-10-18T00:00:00+08:00." },
          to: { type: "string", format: "date-time", description: "Required for history: exclusive end, ISO timestamp with Z or offset, at most 31 days after from." },
          limit: { type: "integer", minimum: 1, maximum: 100, description: "History page size (default 20; use at most 5 to resolve every uncached address) or regions result limit (default 100)." },
          cursor: { type: "string", description: "History next_cursor from the previous page; keep the same from/to. Omit to start a fresh query." }
        },
        required: ["action"],
        additionalProperties: false
      }
    },
    executionMode: "sequential",
    activity: {
      started: (input) => ({ message: (input as { action?: string })?.action === "history"
        ? "我正在查询你指定时间范围内的历史位置。"
        : (input as { action?: string })?.action === "regions" ? "我正在查看可用于地理触发的区域。"
        : (input as { action?: string })?.action === "get" ? "我正在读取你最近一次上报的位置。" : "我正在处理你的定位绑定。" }),
      completed: (input, result) => {
        const output = result as { result?: string; returned_count?: number; has_more?: boolean } | undefined;
        if (output?.result === "not_owner") return { message: "当前身份没有访问定位数据的权限。" };
        if ((input as { action?: string })?.action === "regions") return { message: output?.result === "no_regions"
          ? "尚未收到区域定义，可以用定位坐标设置围栏。" : "我已读取可用于地理触发的区域。" };
        if ((input as { action?: string })?.action === "history") {
          if (output?.result === "no_history") return { message: "这个时间范围内没有查到历史位置记录。" };
          const count = output?.returned_count;
          return { message: typeof count === "number" && Number.isInteger(count) && count >= 0 && count <= 100
            ? `我查到了${count}条历史位置记录${output?.has_more === true ? "，还有后续记录可继续查询" : ""}。`
            : "历史位置查询已经完成。" };
        }
        return { message: (input as { action?: string })?.action === "get" ? "我已经读取到定位状态。" : "定位绑定已经处理好了。" };
      },
      failed: (input) => ({ message: (input as { action?: string })?.action === "history"
        ? "这次没能完成历史位置查询。" : (input as { action?: string })?.action === "regions"
          ? "这次没能读取地理触发区域。" : "这次没能读取或更新定位绑定。" })
    },
    execute: async (input, context) => {
      const parsed = parseInput(input);
      const { action } = parsed;
      const principalId = context.principalId ?? context.userId;
      const aliases = principalId === context.userId ? [] : [context.userId];
      context.signal?.throwIfAborted();
      if (action === "claim") {
        const status = service.store.claimOwner(principalId, aliases);
        return {
          status,
          bound: status !== "owned_by_another_user",
          ingest_ready: Boolean(service.config.publicUrl),
          message: status === "owned_by_another_user"
            ? "This receiver is already bound to another user. Do not reveal any location data."
            : service.config.publicUrl
              ? "The chat identity is bound and the private receiver is ready."
              : "The chat identity is bound, but the public tunnel hostname is not configured yet."
        };
      }
      if (!service.store.isOwner(principalId, aliases)) {
        return { result: "not_owner", message: "No location data may be revealed to this user." };
      }
      if (action === "revoke") {
        service.store.revoke(principalId, aliases);
        return { result: "revoked", location_deleted: true, history_deleted: true, geocoding_history_deleted: true };
      }
      const now = Date.now();
      if (parsed.action === "regions") {
        const { regions, hasMore } = service.store.knownRegions(parsed.limit);
        return { result: regions.length ? "available" : "no_regions", has_more: hasMore,
          regions: regions.map(region => ({
            name: region.description,
            selector: region.regionId ? { regionId: region.regionId } : { regionName: region.description },
            state: region.stateObservedAt === undefined ? "unknown" : region.active ? "inside" : "outside",
            ...(region.stateObservedAt === undefined ? {} : { observed_at: beijingTime(region.stateObservedAt) }),
            ...(region.center ? { center: region.center } : {}),
            ...(region.radiusMeters === undefined ? {} : { radius_meters: region.radiusMeters })
          })) };
      }
      if (parsed.action === "history") {
        const from = Date.parse(parsed.from);
        const to = Date.parse(parsed.to);
        const { page, geocodes } = await service.historyWithGeocodes({ from, to, limit: parsed.limit, cursor: parsed.cursor }, context.signal, now);
        return {
          result: page.points.length ? "available" : "no_history",
          query: { from: beijingTime(from, true), to: beijingTime(to, true), end_exclusive: true, timezone: "Asia/Shanghai", order: "oldest_first" },
          returned_count: page.points.length,
          has_more: page.hasMore,
          ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
          evidence: "Recorded observations only. Gaps do not establish continuous presence; map addresses may have been resolved later.",
          points: page.points.map((point) => {
            const resolved = geocodes.get(point.id);
            const region = ownTracksRegionOutput(point);
            return {
              ...pointOutput(point, resolved),
              observed_at: beijingTime(point.observedAt, true),
              ...(resolved?.geocode ? { place_resolved_at: beijingTime(resolved.geocode.fetchedAt, true) } : {}),
              ...(point.accuracyMeters === undefined ? {} : { accuracy_meters: point.accuracyMeters }),
              ...(region ? { region } : {})
            };
          })
        };
      }
      const { analysis, geocodes } = await service.motionWithGeocodes(context.signal, now);
      if (!analysis) return { result: "no_location" };
      const location = analysis.state === "moving" ? analysis.end : analysis.location;
      const resolved = geocodes.get(location.id);
      return semanticLocation(location, resolved?.geocode, resolved?.status, now, analysis, geocodes);
    }
  };
}
