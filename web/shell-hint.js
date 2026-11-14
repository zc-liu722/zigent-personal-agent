// Paint theme and the signed-in shell before CSS. zigent_seen is a hint, not a credential.
(() => {
  const root = document.documentElement;
  let pages = {};
  try { pages = JSON.parse(document.querySelector('meta[name="zigent-page-colors"]')?.content || '{}'); } catch { pages = {}; }
  const palette = document.cookie.match(/(?:^|; )zigent_palette=([^;]*)/)?.[1];
  if (pages[palette]) root.dataset.palette = palette;
  const day = 86400000, offset = 28800000, latitude = 39.9042 * Math.PI / 180, longitude = 116.4074, rad = Math.PI / 180;
  const sun = time => {
    const date = new Date(time + offset), year = date.getUTCFullYear();
    const noonDay = Date.UTC(year, date.getUTCMonth(), date.getUTCDate());
    const yearStart = Date.UTC(year, 0, 1);
    const gamma = 2 * Math.PI / ((Date.UTC(year + 1, 0, 1) - yearStart) / day) * ((noonDay - yearStart) / day);
    const equation = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma) - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
    const declination = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma) - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma) - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
    const hourAngle = Math.acos(Math.cos(90.833 * rad) / (Math.cos(latitude) * Math.cos(declination)) - Math.tan(latitude) * Math.tan(declination)) / rad;
    const noon = 720 - 4 * longitude - equation;
    return { sunrise: Math.round(noonDay + (noon - 4 * hourAngle) * 60000), sunset: Math.round(noonDay + (noon + 4 * hourAngle) * 60000) };
  };
  const now = Date.now(), times = sun(now);
  const mode = now >= times.sunrise && now < times.sunset ? 'light' : 'dark';
  root.dataset.theme = mode;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', mode);
  const color = (pages[root.dataset.palette] || pages.brown)?.[mode];
  if (color) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
  document.addEventListener('submit', event => { if (!window.ZigentAppReady) event.preventDefault(); }, true);
  let seen = false;
  try { seen = localStorage.getItem('zigent-known-session') === '1'; } catch { /* Storage can be blocked. */ }
  if (!seen) seen = /(?:^|; )zigent_seen=1(?:;|$)/.test(document.cookie);
  root.dataset.shell = seen ? 'app' : 'login';
})();
