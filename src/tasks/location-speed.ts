/** Optional inclusive bounds on the speed reported with the triggering observation. */
export type LocationSpeedRange = { minSpeedKph?: number; maxSpeedKph?: number };

export function validLocationSpeedRange(range: LocationSpeedRange): boolean {
  return [range.minSpeedKph, range.maxSpeedKph].every(value => value === undefined
    || typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 2000)
    && (range.minSpeedKph === undefined || range.maxSpeedKph === undefined || range.minSpeedKph <= range.maxSpeedKph);
}

export function matchesLocationSpeed(range: LocationSpeedRange, velocityKph: number | undefined): boolean {
  if (range.minSpeedKph === undefined && range.maxSpeedKph === undefined) return true;
  return typeof velocityKph === "number" && Number.isFinite(velocityKph) && velocityKph >= 0 && velocityKph <= 2000
    && (range.minSpeedKph === undefined || velocityKph >= range.minSpeedKph)
    && (range.maxSpeedKph === undefined || velocityKph <= range.maxSpeedKph);
}

export function locationSpeedText(range: LocationSpeedRange): string | undefined {
  if (range.minSpeedKph !== undefined && range.maxSpeedKph !== undefined) return `速度 ${range.minSpeedKph}–${range.maxSpeedKph} km/h`;
  if (range.minSpeedKph !== undefined) return `速度 ≥ ${range.minSpeedKph} km/h`;
  if (range.maxSpeedKph !== undefined) return `速度 ≤ ${range.maxSpeedKph} km/h`;
  return undefined;
}
