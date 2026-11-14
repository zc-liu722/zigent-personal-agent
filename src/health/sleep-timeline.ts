import type { MessageAttachment } from "../channels/attachments.js";
import type { HealthStore, HealthObservation } from "./store.js";
import { stageOf } from "./sleep-summary.js";
import { sleepTimelineDataSchema, type SleepTimelineData } from "../channels/program-data.js";
import { localTaskTime } from "../tasks/schedule.js";

type Span = { s: number; e: number; k: string };
const sleeping = new Set(["core", "deep", "rem", "asleep"]);

/** Sweep one source, preserving gaps and contradictions instead of inventing stages. */
function timelineSpans(rows: HealthObservation[], from: number, to: number): Span[] {
  const events: { t: number; k: string; delta: number }[] = [];
  for (const row of rows) {
    if (row.kind !== "sleep_segment" || !row.endAt || row.endAt <= row.observedAt) continue;
    const s = Math.max(from, row.observedAt), e = Math.min(to, row.endAt);
    if (e > s) events.push({ t: s, k: stageOf(row.values.value), delta: 1 }, { t: e, k: stageOf(row.values.value), delta: -1 });
  }
  events.sort((a, b) => a.t - b.t);
  const active = new Map<string, number>(), spans: Span[] = [];
  let previous = events[0]?.t;
  for (let i = 0; i < events.length;) {
    const t = events[i]!.t;
    if (previous !== undefined && t > previous) {
      const stages = [...active].filter(([, n]) => n > 0).map(([k]) => k);
      const sleep = stages.filter(k => sleeping.has(k));
      const k = sleep.length > 1 || sleep.length && stages.includes("awake") ? "conflict"
        : sleep[0] ?? (stages.includes("awake") ? "awake" : stages.includes("inBed") ? "inBed"
          : stages.length ? "unspecified" : "unknown");
      const last = spans.at(-1);
      if (last?.k === k && last.e === previous) last.e = t;
      else spans.push({ s: previous, e: t, k });
    }
    while (i < events.length && events[i]!.t === t) {
      const event = events[i++]!;
      active.set(event.k, (active.get(event.k) ?? 0) + event.delta);
    }
    previous = t;
  }
  return spans;
}

/** Read-only program invoked only by the sleep-review delivery binding, never health_data. */
export function sleepTimelineAttachment(store: HealthStore, capturedAt: number): MessageAttachment {
  if (!Number.isFinite(capturedAt)) throw new Error("INVALID_SLEEP_TIMELINE_TIME");
  const day = localTaskTime(capturedAt, "Asia/Shanghai").day;
  const from = Date.parse(`${day}T00:00:00+08:00`) - 6 * 3600_000, to = capturedAt;
  let page = store.query({ from, to, metrics: ["sleep_analysis"], limit: 500 });
  if (page.result === "stream_required") {
    const segments = page.streams.filter(stream => stream.includes("/sleep_segment/"));
    // A unique segmented source supersedes legacy summaries, never another device.
    if (segments.length === 1) page = store.query({ from, to, metrics: ["sleep_analysis"], stream: segments[0], limit: 500 });
  }
  const rows = [...page.observations];
  while (page.hasMore) {
    const cursor = page.nextCursor;
    page = store.query({ from, to, metrics: ["sleep_analysis"], stream: page.stream, afterSeq: cursor, limit: 500 });
    rows.push(...page.observations);
    if (page.nextCursor <= cursor || rows.length > 50_000) throw new Error("SLEEP_TIMELINE_TOO_DENSE");
  }
  const spans = timelineSpans(rows, from, to);
  const unavailable = page.result === "stream_required" ? "有多个睡眠来源，暂未选择"
    : !spans.length ? "暂无睡眠分段" : spans.length > 500 ? "睡眠分段过多，暂无法展示" : undefined;
  const summary = `${day}，北京时间。健康数据库中的设备睡眠分段估计，仅覆盖已记录区间，不证明整晚完整。空档为未记录，冲突阶段不分类；卧床不等于睡眠。${unavailable ?? "点按时间线可查看阶段和时段。"}`;
  const data = unavailable ? undefined : sleepTimelineDataSchema.parse({ type: "sleep-timeline", version: 1,
    start: spans[0]!.s, segments: spans.map(d => [d.s - spans[0]!.s, d.e - spans[0]!.s, d.k]) });
  return { id: "sleep-timeline", program: "sleep-timeline", ...(data ? { data } : {}), output: {
    id: "sleep-timeline", title: `${day} 睡眠时间线`, blocks: [{ type: "interactive", height: 260, summary,
      html: data ? timelineFallback(data) : `<p>${unavailable}</p>` }]
  } };
}

/** A data-only text fallback keeps already-open, older web shells readable. */
function timelineFallback(data: SleepTimelineData): string {
  const minutes = Math.round(data.segments.reduce((sum, [s, e, k]) => sum + (sleeping.has(k) ? e - s : 0), 0) / 60000);
  const clock = (offset: number) => new Date(data.start + offset + 28800000).toISOString().slice(11, 16);
  const duration = data.segments.some(([, , k]) => sleeping.has(k)) ? `${Math.floor(minutes / 60)}小时${minutes % 60}分` : "未分类";
  return `<p>${duration} · ${clock(0)}–${clock(data.segments.at(-1)![1])}</p>`;
}
