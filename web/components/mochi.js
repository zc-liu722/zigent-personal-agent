import { readColors } from '../plugins/palette/read-colors.js';

// One silhouette and face for both the waiting game and child Agent portraits.
// Artwork stays vector-native; the game rasterizes it once rather than per frame.
const body = 'M31 12C38 11 43 14 46 20C54 21 59 29 58 39C60 50 51 56 33 56C18 57 7 52 7 42C6 33 11 25 17 23C19 16 24 12 31 12Z';
const shine = 'M16 30C19 21 26 17 32 18C36 18 39 20 38 22C37 25 28 23 23 28C19 32 15 35 16 30Z';
const happy = 'M23 35Q26 30 29 35M36 35Q39 30 42 35';
const shut = 'M23 35Q26 37 29 35M36 35Q39 37 42 35';
const worried = 'M23 33L28 36L23 38M42 33L37 36L42 38';
let serial = 0;
export const randomMochiHue = () => Math.floor(Math.random() * 360);

// Shared face geometry keeps the voice presence recognizably the same character.
export function mochiFaceSvg(luminous = false) {
  const ink = luminous ? 'var(--palette-mochi-face-luminous)' : 'var(--palette-mochi-face)';
  return `      <ellipse cx="18.5" cy="40" rx="3.5" ry="1.8" fill="var(--palette-mochi-cheek)" opacity=".32"/>
      <ellipse cx="46" cy="40" rx="3.5" ry="1.8" fill="var(--palette-mochi-cheek)" opacity=".32"/>
      <g class="mochi-eyes-open" fill="${ink}">
        <ellipse cx="26" cy="35" rx="2.3" ry="4.1"/><ellipse cx="39" cy="35" rx="2.3" ry="4.1"/>
        <g fill="var(--palette-white)" opacity=".8"><ellipse cx="25.4" cy="33.4" rx=".65" ry="1"/><ellipse cx="38.4" cy="33.4" rx=".65" ry="1"/></g>
      </g>
      <g fill="none" stroke="${ink}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
        <path class="mochi-eyes-happy" d="${happy}"/>
        <path class="mochi-eyes-worried" d="${worried}"/>
        <path class="mochi-eyes-shut" d="${shut}"/>
      </g>`;
}

export function mochiSvg() {
  const id = `mochi-${++serial}`, hue = randomMochiHue();
  return `<svg viewBox="0 0 64 64" aria-hidden="true" stroke="none">
    <defs>
      <linearGradient id="${id}" x1=".3" y1="0" x2=".7" y2="1" gradientUnits="objectBoundingBox">
        <stop stop-color="hsl(var(--hue, ${hue}) var(--palette-mochi-highlight-hsl))"/>
        <stop offset=".5" stop-color="hsl(var(--hue, ${hue}) var(--palette-mochi-body-hsl))"/>
        <stop offset="1" stop-color="hsl(var(--hue, ${hue}) var(--palette-mochi-base-hsl))"/>
      </linearGradient>
    </defs>
    <ellipse class="mochi-shadow" cx="33" cy="58" rx="21" ry="3" fill="var(--palette-mochi-shadow)"/>
    <g class="mochi-body">
      <path d="${body}" fill="url(#${id})"/>
      <path d="${shine}" fill="var(--palette-white)" opacity=".45"/>
      <path d="M13 45C17 52 25 54 34 53" fill="none" stroke="var(--palette-mochi-rim)" stroke-opacity=".4" stroke-width="1.4"/>
      ${mochiFaceSvg()}
    </g>
  </svg>`;
}

export function createMochiSprite(face = 'open', hue = randomMochiHue()) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 192;
  const ctx = canvas.getContext('2d');
  const color = readColors();
  ctx.scale(3, 3);
  const fill = ctx.createLinearGradient(19, 12, 45, 56);
  fill.addColorStop(0, `hsl(${hue} ${color('palette-mochi-highlight-hsl')})`); fill.addColorStop(.5, `hsl(${hue} ${color('palette-mochi-body-hsl')})`); fill.addColorStop(1, `hsl(${hue} ${color('palette-mochi-base-hsl')})`);
  ctx.fillStyle = fill; ctx.fill(new Path2D(body));
  ctx.globalAlpha = .45; ctx.fillStyle = color('palette-white'); ctx.fill(new Path2D(shine));
  ctx.globalAlpha = .4; ctx.strokeStyle = color('palette-mochi-rim'); ctx.lineWidth = 1.4; ctx.stroke(new Path2D('M13 45C17 52 25 54 34 53'));
  ctx.globalAlpha = .32; ctx.fillStyle = color('palette-mochi-cheek');
  for (const x of [18.5, 46]) { ctx.beginPath(); ctx.ellipse(x, 40, 3.5, 1.8, 0, 0, Math.PI * 2); ctx.fill(); }
  ctx.globalAlpha = 1;
  if (face === 'open') {
    ctx.fillStyle = color('palette-mochi-face');
    for (const x of [26, 39]) { ctx.beginPath(); ctx.ellipse(x, 35, 2.3, 4.1, 0, 0, Math.PI * 2); ctx.fill(); }
    ctx.globalAlpha = .8; ctx.fillStyle = color('palette-white');
    for (const x of [25.4, 38.4]) { ctx.beginPath(); ctx.ellipse(x, 33.4, .65, 1, 0, 0, Math.PI * 2); ctx.fill(); }
  } else {
    ctx.strokeStyle = color('palette-mochi-face'); ctx.lineWidth = 1.9; ctx.lineCap = 'round';
    ctx.stroke(new Path2D(face === 'happy' ? happy : face === 'hurt' ? 'M23 34Q26 37 29 33M36 33Q39 37 42 34' : shut));
  }
  ctx.globalAlpha = 1;
  if (face === 'hurt') {
    ctx.stroke(new Path2D('M23 30L28 28M37 28L42 30M30 43Q32.5 40 35 43'));
    ctx.fillStyle = color('palette-mochi-tear');
    ctx.beginPath(); ctx.ellipse(24, 39, 1.1, 1.7, 0, 0, Math.PI * 2); ctx.fill();
  }
  return canvas;
}
