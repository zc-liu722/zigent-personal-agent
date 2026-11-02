/** Convert an all-day date in its declared timezone to its opening instant. */
export function scheduleInstant(value: string, zone: string): number {
  if (value.length !== 10) return Date.parse(value);
  const desired = Date.parse(`${value}T00:00:00Z`);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  let instant = desired;
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]));
    const represented = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
    const adjustment = desired - represented;
    if (!adjustment) break;
    instant += adjustment;
  }
  return instant;
}
