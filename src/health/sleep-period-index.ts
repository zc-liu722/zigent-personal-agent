export type SleepInterval = {
  start: number; end: number; state: "asleep" | "awake"; source?: string; precision: "segment" | "summary";
};
type Evidence = { state: "asleep"; interval: { start: number; end: number } } | { state: "awake" | "unknown" };
type Span = { start: number; end: number; evidence: Evidence };

/** Sweep a selected source once. Counts select the evidence; a heap retains the
 * widest sleeping bounds, including summaries even when segments take precedence.
 * Equal-width bounds retain input order, matching the original stable sort. */
function timeline(intervals: readonly SleepInterval[]): Span[] {
  const events = intervals.flatMap((interval, id) => [
    { time: interval.start, id, delta: 1 }, { time: interval.end, id, delta: -1 }
  ]).sort((a, b) => a.time - b.time);
  const active = new Uint8Array(intervals.length), heap: number[] = [], spans: Span[] = [];
  const counts = { segment: { asleep: 0, awake: 0 }, summary: { asleep: 0, awake: 0 } };
  const precedes = (a: number, b: number) => {
    const left = intervals[a]!, right = intervals[b]!;
    const difference = (left.end - left.start) - (right.end - right.start);
    return difference > 0 || difference === 0 && a < b;
  };
  const push = (id: number) => {
    let index = heap.length; heap.push(id);
    while (index) {
      const parent = (index - 1) >> 1;
      if (!precedes(id, heap[parent]!)) break;
      heap[index] = heap[parent]!; index = parent;
    }
    heap[index] = id;
  };
  const widest = () => {
    while (heap.length && !active[heap[0]!]) {
      const last = heap.pop()!;
      if (!heap.length) break;
      let index = 0;
      while (index * 2 + 1 < heap.length) {
        let child = index * 2 + 1;
        if (child + 1 < heap.length && precedes(heap[child + 1]!, heap[child]!)) child++;
        if (!precedes(heap[child]!, last)) break;
        heap[index] = heap[child]!; index = child;
      }
      heap[index] = last;
    }
    return intervals[heap[0]!]!;
  };
  for (let i = 0; i < events.length;) {
    const time = events[i]!.time;
    while (i < events.length && events[i]!.time === time) {
      const { id, delta } = events[i++]!, interval = intervals[id]!;
      active[id] = delta > 0 ? 1 : 0;
      counts[interval.precision][interval.state] += delta;
      if (delta > 0 && interval.state === "asleep") push(id);
    }
    const end = events[i]?.time;
    if (end === undefined) break;
    const selected = counts.segment.asleep || counts.segment.awake ? counts.segment : counts.summary;
    if (!selected.asleep && !selected.awake) continue;
    let evidence: Evidence;
    if (selected.awake) evidence = { state: selected.asleep ? "unknown" : "awake" };
    else {
      const bounds = widest();
      evidence = { state: "asleep", interval: { start: bounds.start, end: bounds.end } };
    }
    spans.push({ start: time, end, evidence });
  }
  return spans;
}

/** Evaluation-local immutable lookup. Never reused across imports or fresh reads.
 * Source timelines are lazy: most evaluations need only their matching device.
 * Each interval participates in at most its source timeline and the fallback. */
export function sleepPeriodIndex(intervals: readonly SleepInterval[]) {
  const sources = new Map<string, SleepInterval[]>(), prepared = new Map<string | undefined, Span[]>();
  for (const interval of intervals) if (interval.source) {
    const rows = sources.get(interval.source) ?? [];
    rows.push(interval); sources.set(interval.source, rows);
  }
  const spansFor = (source?: string) => {
    let spans = prepared.get(source);
    if (!spans) { spans = timeline(source === undefined ? intervals : sources.get(source) ?? []); prepared.set(source, spans); }
    return spans;
  };
  const position = (spans: Span[], at: number) => {
    let low = 0, high = spans.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (spans[middle]!.start <= at) low = middle + 1;
      else high = middle;
    }
    return low - 1;
  };
  const covering = (spans: Span[], at: number) => {
    const span = spans[position(spans, at)];
    return span && at < span.end ? span.evidence : undefined;
  };
  return {
    covering(at: number, source?: string): Evidence | undefined {
      if (!Number.isFinite(at)) return;
      return (source && sources.has(source) ? covering(spansFor(source), at) : undefined) ?? covering(spansFor(), at);
    },
    nearby(at: number, distance: number): boolean {
      if (!Number.isFinite(at)) return false;
      const spans = spansFor(), index = position(spans, at);
      return Boolean(spans[index] && spans[index]!.end >= at - distance
        || spans[index + 1] && spans[index + 1]!.start <= at + distance);
    }
  };
}
