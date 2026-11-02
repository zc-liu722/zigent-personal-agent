import type { TokenUsage } from "../memory/types.js";
import type { LocationSpeedRange } from "./location-speed.js";
export type TaskTrigger =
  | { type: "reference"; triggerId: string }
  | { type: "external"; event: string; source?: string; cooldownSeconds?: number; maxAgeSeconds?: number;
      preparation?: "outing_weather" }
  | { type: "time"; schedule: "once"; at: string; timezone?: string; maxLatenessSeconds?: number }
  | {
      type: "time";
      schedule: "daily" | "weekly";
      time: string;
      timezone: string;
      weekdays?: number[];
      maxLatenessSeconds?: number;
    }
  | { type: "health_change"; debounceSeconds?: number; metrics?: string[];
      afterTime?: string; timezone?: string; oncePerDay?: boolean; condition?: "hrv_anomaly_v1" | "hrv_realtime_v2" }
  | (LocationSpeedRange & { type: "location"; event: "enter" | "leave"; regionId?: string; regionName?: string;
      center?: { latitude: number; longitude: number; system: "GCJ-02" }; radiusMeters?: number;
      cooldownSeconds?: number; maxAgeSeconds?: number; repeat?: boolean });
export type TaskScope = {
  agentId: string;
  userId: string;
  principalId?: string;
  conversationId?: string;
  conversationKind?: "p2p" | "group";
};
export type TaskProposal = {
  title: string;
  instruction: string;
  trigger: TaskTrigger;
  skill?: "health";
  deliveryPolicy?: "always" | "conditional";
};
export type ActiveTask = {
  /** Canonical model saved at creation; optional only for legacy/offline stores. */
  model?: string;
  id: string;
  agentId: string;
  userId: string;
  principalId?: string;
  conversationId: string;
  title: string;
  skill?: "health";
  deliveryPolicy?: "always" | "conditional";
  instruction: string;
  trigger: TaskTrigger;
  status: "active" | "paused" | "cancelled";
  revision: number;
  cursor: number;
  nextAt?: number;
  createdAt: number;
  updatedAt: number;
};
export type TaskRunResult = {
  text?: string;
  summary?: string;
  model?: string;
  usage?: TokenUsage;
  skillRevision?: number;
  cursor?: number;
  dataSnapshot?: unknown;
};
export type TaskRun = {
  id: string;
  taskId: string;
  parentRunId?: string;
  refreshCount: number;
  occurrence: string;
  taskRevision: number;
  state: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  payload: unknown;
  attempts: number;
  availableAt: number;
  triggeredAt: number;
  startedAt?: number;
  endedAt?: number;
  deliveredAt?: number;
  leaseToken?: string;
  leaseUntil?: number;
  result?: TaskRunResult;
  error?: string;
  notificationStatus: "none" | "pending" | "delivered" | "stale" | "uncertain";
  notificationId: string;
  sessionId?: string;
  messageId?: string;
};
export type LocationTaskEvent = {
  id: string;
  userId: string;
  event: "enter" | "leave";
  regionId?: string;
  regionName?: string;
  occurredAt: number;
  velocityKph?: number;
  payload?: unknown;
};
export type ExternalNotification = {
  appId?: string;
  appName?: string;
  title?: string;
  subtitle?: string;
  body?: string;
};
export type ExternalTaskEvent = {
  eventId: string;
  event: string;
  occurredAt: string;
  location?: { latitude: number; longitude: number; system: "WGS84"; observedAt: string };
  notification?: ExternalNotification;
};
export type ExternalEventSource = {
  id: string;
  agentId: string;
  userId: string;
  principalId?: string;
  source: string;
  allowedEvents: string[];
  maxAgeSeconds: number;
  status: "active" | "disabled";
};
export type AgentExternalEvent = ExternalTaskEvent & { source: string; receivedAt: string; description: string; historyOnly?: boolean };
export type ExternalEventReceipt = {
  status: "received" | "duplicate" | "validated";
  matchedTasks: number;
  queuedTasks: number;
  coalescedTasks: number;
  expiredTasks: number;
  notificationId?: number;
  historical?: boolean;
};
