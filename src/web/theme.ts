const DAY = 86_400_000;
const BEIJING_OFFSET = 8 * 60 * 60_000;
const LATITUDE = 39.9042 * Math.PI / 180;
const LONGITUDE = 116.4074;
const rad = Math.PI / 180;

// NOAA solar equations, including the 90.833° apparent horizon correction:
// https://gml.noaa.gov/grad/solcalc/solareqns.PDF
// Calendar arithmetic uses Beijing (UTC+8), independently of the host timezone.
export function beijingSunTimes(now: number): { sunrise: number; sunset: number } {
  const date = new Date(now + BEIJING_OFFSET);
  const year = date.getUTCFullYear();
  const day = Date.UTC(year, date.getUTCMonth(), date.getUTCDate());
  const yearStart = Date.UTC(year, 0, 1);
  const daysInYear = (Date.UTC(year + 1, 0, 1) - yearStart) / DAY;
  const gamma = 2 * Math.PI / daysInYear * ((day - yearStart) / DAY);
  const equation = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const declination = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  const hourAngle = Math.acos(Math.cos(90.833 * rad) / (Math.cos(LATITUDE) * Math.cos(declination))
    - Math.tan(LATITUDE) * Math.tan(declination)) / rad;
  const noon = 720 - 4 * LONGITUDE - equation;
  return { sunrise: Math.round(day + (noon - 4 * hourAngle) * 60_000),
    sunset: Math.round(day + (noon + 4 * hourAngle) * 60_000) };
}

export function webTheme(now = Date.now()): { mode: "light" | "dark"; color: string; refreshAfterMs: number } {
  const { sunrise, sunset } = beijingSunTimes(now);
  const light = now >= sunrise && now < sunset;
  const next = now < sunrise ? sunrise : now < sunset ? sunset : beijingSunTimes(now + DAY).sunrise;
  return { mode: light ? "light" : "dark", color: light ? "#faf9f5" : "#1d1c19", refreshAfterMs: next - now };
}

export function themedIndex(html: string, now = Date.now()): string {
  const theme = webTheme(now);
  return html.replace('data-theme="light"', `data-theme="${theme.mode}"`)
    .replace('name="color-scheme" content="light"', `name="color-scheme" content="${theme.mode}"`)
    .replace('name="theme-color" content="#faf9f5"', `name="theme-color" content="${theme.color}"`);
}
