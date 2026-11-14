import { el } from '../dom.js';
import { readColors } from '../plugins/palette/read-colors.js';
import { createMochiSprite, randomMochiHue } from './mochi.js';

const WIDTH = 300, HEIGHT = 400, MOCHI_Y = HEIGHT - 26;
const BASE_SIZE = 64, MIN_SIZE = 44, MAX_SIZE = 128, INTRO_HOLD = 1;
const SIDE_MARGIN = MAX_SIZE * .39 + 8;
// Reserve room for the largest body before it grows into an airborne wave.
const ARROW_WIDTH = 12, ARROW_GAP = MAX_SIZE + ARROW_WIDTH + 24;
const ARROW_BAND = MAX_SIZE + 72 + 80, ARROW_SPEED = 88;
const LEVEL_DURATION = 1.8, ZOOM_Y = MOCHI_Y - 2;
const STREAM_DEPTH_LIMIT = 4;
const games = new Set();
let frame, lastTime = 0, intersection, resize, sprites, motion;
const byNode = new WeakMap();
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const ease = value => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };
const zoomEase = value => { const t = clamp(value, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); };
function hasVisibleGame() {
  for (const game of games) if (game.visible) return true;
  return false;
}

function stopClock() {
  if (frame !== undefined) cancelAnimationFrame(frame);
  frame = undefined; lastTime = 0;
}
function wake() {
  if (!document.hidden && frame === undefined && hasVisibleGame()) frame = requestAnimationFrame(tick);
}
function tick(time) {
  frame = undefined;
  if (document.hidden) { lastTime = 0; return; }
  // No catch-up after a hidden tab, scroll suspension or a slow device frame.
  if (lastTime && time - lastTime < 1000 / 30 - 1) { wake(); return; }
  const dt = lastTime ? Math.min((time - lastTime) / 1000, .05) : 1 / 30;
  lastTime = time;
  for (const game of games) {
    if (!game.node.isConnected) { game.dispose(); continue; }
    if (game.visible) game.advance(dt);
  }
  if (hasVisibleGame()) wake(); else lastTime = 0;
}
function visibility() { stopClock(); if (!document.hidden) wake(); }
function reducedMotion() {
  for (const game of games) game.reduceMotion = motion.matches;
}
function startObservers() {
  motion = matchMedia('(prefers-reduced-motion: reduce)');
  motion.addEventListener('change', reducedMotion);
  document.addEventListener('visibilitychange', visibility);
  intersection = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const game = byNode.get(entry.target);
      if (game) game.visible = entry.isIntersecting;
    }
    if (!hasVisibleGame()) stopClock(); else wake();
  });
  resize = new ResizeObserver(entries => {
    for (const entry of entries) byNode.get(entry.target)?.resize(entry.contentRect.width);
  });
}
function stopObservers() {
  stopClock(); intersection.disconnect(); resize.disconnect();
  document.removeEventListener('visibilitychange', visibility);
  motion.removeEventListener('change', reducedMotion);
  // Release the shared raster cache when no generation is on screen.
  sprites = undefined;
}

function photonSprite(color, highlight) {
  const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 112;
  const ctx = canvas.getContext('2d');
  const trail = ctx.createLinearGradient(0, 0, 0, 87);
  trail.addColorStop(0, `${color}00`); trail.addColorStop(1, `${color}a0`);
  ctx.fillStyle = trail; ctx.fillRect(14, 0, 4, 86);
  const glow = ctx.createRadialGradient(16, 88, 1, 16, 88, 15);
  glow.addColorStop(0, highlight); glow.addColorStop(.16, color); glow.addColorStop(1, `${color}00`);
  ctx.fillStyle = glow; ctx.fillRect(0, 72, 32, 32);
  return canvas;
}
function artwork(dark) {
  if (sprites?.dark === dark) return sprites;
  const color = readColors(), colors = Array.from({ length: 4 }, (_, i) => color(`palette-photon-${i + 1}`));
  const highlight = color('palette-photon-glow');
  sprites = { dark, colors, photons: colors.map(paint => photonSprite(paint, highlight)), arrow: arrowSprite(color),
    gesture: color('palette-game-gesture'), chapter: color('palette-game-chapter'), stream: color('palette-game-stream') };
  return sprites;
}
function arrowSprite(color) {
  const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 144;
  const ctx = canvas.getContext('2d'); ctx.scale(2, 2);
  // Pearl/slate facets keep the arrows light. A small rose edge distinguishes hazards
  // from photons without turning them into heavy red UI icons.
  const trail = ctx.createLinearGradient(0, 1, 0, 18);
  trail.addColorStop(0, color('palette-arrow-trail-start')); trail.addColorStop(1, color('palette-arrow-trail-end'));
  ctx.fillStyle = trail; ctx.fillRect(15.6, 1, .8, 17);
  const metal = ctx.createLinearGradient(10, 0, 22, 0);
  metal.addColorStop(0, color('palette-arrow-metal-edge')); metal.addColorStop(.48, color('palette-arrow-metal-highlight'));
  metal.addColorStop(.56, color('palette-arrow-metal-face')); metal.addColorStop(1, color('palette-arrow-metal-shadow'));
  ctx.fillStyle = metal;
  ctx.fill(new Path2D('M15.15 19Q16 17 16.85 19L16.7 50H15.3Z'));
  // Two shaped vanes, with fine etched ribs instead of an open chevron tail.
  const vanes = new Path2D('M15.2 27.5L11.5 23.6Q11 23.1 11 22.2V15.5Q11 14.8 11.6 15.4L15.2 19.6ZM16.8 27.5L20.5 23.6Q21 23.1 21 22.2V15.5Q21 14.8 20.4 15.4L16.8 19.6Z');
  ctx.fillStyle = color('palette-arrow-vane'); ctx.fill(vanes);
  ctx.strokeStyle = color('palette-arrow-vane-rib'); ctx.lineWidth = .55;
  ctx.beginPath(); ctx.moveTo(12, 18); ctx.lineTo(14.5, 21); ctx.moveTo(12, 21); ctx.lineTo(14.5, 24);
  ctx.moveTo(20, 18); ctx.lineTo(17.5, 21); ctx.moveTo(20, 21); ctx.lineTo(17.5, 24); ctx.stroke();
  const head = new Path2D('M16 60L10.8 46.3Q10.4 45.3 11.4 45.9L16 48L20.6 45.9Q21.6 45.3 21.2 46.3Z');
  ctx.fillStyle = metal; ctx.fill(head);
  ctx.fillStyle = color('palette-arrow-head-highlight'); ctx.fill(new Path2D('M16 48L11.3 46.3L16 59Z'));
  // The leading point has an actual red coating, with its own lit facet.
  const redTip = ctx.createLinearGradient(13.5, 53, 18.5, 60);
  redTip.addColorStop(0, color('palette-arrow-tip-light')); redTip.addColorStop(1, color('palette-arrow-tip-shadow'));
  ctx.fillStyle = redTip; ctx.fill(new Path2D('M13.8 54.2L16 55L18.2 54.2L16 60Z'));
  ctx.fillStyle = color('palette-arrow-tip-glow'); ctx.fill(new Path2D('M13.8 54.2L16 55V59.4Z'));
  ctx.strokeStyle = color('palette-arrow-head-outline'); ctx.lineWidth = .55; ctx.lineJoin = 'round'; ctx.stroke(head);
  ctx.strokeStyle = color('palette-arrow-facet'); ctx.lineWidth = .7;
  ctx.beginPath(); ctx.moveTo(16.2, 49.5); ctx.lineTo(16.2, 53.7); ctx.stroke();
  ctx.fillStyle = color('palette-arrow-shaft-inlay'); ctx.fillRect(14.8, 30, 2.4, 1.2);
  ctx.strokeStyle = color('palette-arrow-tip-shine'); ctx.lineWidth = .45;
  ctx.beginPath(); ctx.moveTo(15.55, 32.5); ctx.lineTo(15.55, 44.5); ctx.stroke();
  return canvas;
}

/** An entirely local, bounded Canvas scene. No network, DOM animation loop or assets. */
export function createImageGeneration() {
  if (!games.size) startObservers();
  const node = el('div', 'image-generation'), canvas = el('canvas', 'image-generation-canvas');
  node.setAttribute('role', 'group'); node.setAttribute('aria-label', '接光点养团子');
  canvas.tabIndex = 0; canvas.setAttribute('role', 'slider');
  canvas.setAttribute('aria-label', '左右移动小球接光点、躲避箭'); canvas.setAttribute('aria-orientation', 'horizontal');
  canvas.setAttribute('aria-valuemin', '0'); canvas.setAttribute('aria-valuemax', '100'); canvas.setAttribute('aria-valuenow', '50');
  node.append(canvas);
  // Transparent all the way through: the conversation's actual background shows
  // through in both themes. Only flowing particles define the waiting region.
  const ctx = canvas.getContext('2d'), hue = randomMochiHue();
  const faces = { open: createMochiSprite('open', hue), happy: createMochiSprite('happy', hue),
    blink: createMochiSprite('shut', hue), hurt: createMochiSprite('hurt', hue) };
  const events = new AbortController();
  let width = 0, scale = 1, dark, art, boundary, cornerRadius = 20, dead = false, age = 0, spawn = 0, arrowSpawn = 4.5, started = false;
  let x = WIDTH / 2, target = x, travel = 0, targetSize = BASE_SIZE, size = BASE_SIZE, bounce = 0;
  let injured = false, impact = 0, invulnerable = 0, recovery = 0;
  let level = 0, levelTransition;
  let pointer, lastAria = 50;
  // Fixed pools keep both memory and draw cost constant, even during long waits.
  const photons = Array.from({ length: 24 }, () => ({ active: false }));
  const arrows = Array.from({ length: 16 }, () => ({ active: false }));
  const sparks = Array.from({ length: 24 }, () => ({ life: 0 }));
  const splashDrops = Array.from({ length: 48 }, () => ({ life: 0 }));
  const ripples = Array.from({ length: 8 }, () => ({ life: 0 }));
  const streams = Array.from({ length: 192 }, (_, i) => ({ x: 8 + Math.random() * (WIDTH - 16),
    y: Math.random() * HEIGHT, speed: 48 + Math.random() * 52, length: 3 + Math.random() * 15,
    band: i % 3, ambient: i < 36, tick: i % 5 === 0, active: i < 96, depth: 0, wrap: true }));
  const game = { node, visible: false, reduceMotion: motion.matches, resize: resizeCanvas, advance, dispose };

  function resizeCanvas(nextWidth = width || 288) {
    if (dead || nextWidth <= 0) return;
    width = nextWidth;
    const pixels = Math.max(1, Math.round(width * Math.min(devicePixelRatio || 1, 2)));
    if (canvas.width === pixels && canvas.height === Math.round(pixels * HEIGHT / WIDTH) && boundary) return;
    canvas.width = pixels; canvas.height = Math.round(pixels * HEIGHT / WIDTH); scale = pixels / WIDTH;
    // Match the CSS corner in logical coordinates, including narrower cards.
    cornerRadius = Math.min(WIDTH / 2, (parseFloat(getComputedStyle(node).borderBottomLeftRadius) || 20) * WIDTH / width);
    const r = cornerRadius;
    boundary = new Path2D(); boundary.moveTo(r, 0); boundary.lineTo(WIDTH - r, 0);
    boundary.arcTo(WIDTH, 0, WIDTH, r, r); boundary.lineTo(WIDTH, HEIGHT - r);
    boundary.arcTo(WIDTH, HEIGHT, WIDTH - r, HEIGHT, r); boundary.lineTo(r, HEIGHT);
    boundary.arcTo(0, HEIGHT, 0, HEIGHT - r, r); boundary.lineTo(0, r);
    boundary.arcTo(0, 0, r, 0, r); boundary.closePath();
    draw();
  }
  function move(next) {
    const bounded = clamp(next, SIDE_MARGIN, WIDTH - SIDE_MARGIN);
    // Only intentional input contributes to catch eligibility; smoothing/resize never do.
    travel += Math.abs(bounded - target); target = bounded;
    const percent = Math.round((target - SIDE_MARGIN) / (WIDTH - 2 * SIDE_MARGIN) * 100);
    if (percent !== lastAria) { canvas.setAttribute('aria-valuenow', `${percent}`); lastAria = percent; }
  }
  function pointerX(event) {
    const rect = canvas.getBoundingClientRect();
    const screenX = (event.clientX - rect.left) / rect.width * WIDTH;
    return WIDTH / 2 + (screenX - WIDTH / 2) / sceneZoom();
  }
  canvas.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    const rect = canvas.getBoundingClientRect(), zoom = sceneZoom();
    const screenY = (event.clientY - rect.top) / rect.height * HEIGHT;
    const localY = ZOOM_Y + (screenY - ZOOM_Y) / zoom;
    // At least 96 CSS pixels around the body preserve a comfortable grab offset.
    // The rest of the canvas also accepts taps and horizontal drags.
    const pickupRadius = Math.max(size * .5 + 24, 48 * WIDTH / rect.width / zoom);
    const pickup = Math.abs(pointerX(event) - x) <= pickupRadius && Math.abs(localY - (ZOOM_Y - size * 22 / 64)) <= pickupRadius;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY,
      start: pickup ? target : pointerX(event), dragging: event.pointerType === 'mouse', tap: true };
    if (event.pointerType === 'mouse') { move(pointerX(event)); pointer.start = target; }
    canvas.setPointerCapture(event.pointerId);
  }, { signal: events.signal });
  canvas.addEventListener('pointermove', event => {
    if (event.pointerType === 'mouse' && !pointer) { move(pointerX(event)); return; }
    if (!pointer || event.pointerId !== pointer.id) return;
    const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y;
    pointer.lastX = event.clientX; pointer.lastY = event.clientY;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) pointer.tap = false;
    if (!pointer.dragging) {
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 6) { pointer = undefined; return; }
      if (Math.abs(dx) < 5) return;
      pointer.dragging = true;
    }
    const rect = canvas.getBoundingClientRect();
    move(pointer.start + dx / rect.width * WIDTH / sceneZoom());
  }, { signal: events.signal, passive: true });
  canvas.addEventListener('pointerup', event => {
    if (pointer?.id !== event.pointerId) return;
    if (pointer.tap && !pointer.dragging) move(pointerX(event));
    pointer = undefined;
  }, { signal: events.signal });
  for (const type of ['pointercancel', 'lostpointercapture']) canvas.addEventListener(type, () => { pointer = undefined; }, { signal: events.signal });
  canvas.addEventListener('keydown', event => {
    const delta = { ArrowLeft: -22, ArrowRight: 22, Home: -WIDTH, End: WIDTH }[event.key];
    if (delta === undefined) return;
    event.preventDefault(); event.stopPropagation(); move(target + delta);
  }, { signal: events.signal });
  canvas.addEventListener('blur', () => { pointer = undefined; }, { signal: events.signal });

  function emit(seed = false) {
    const photon = photons.find(item => !item.active);
    if (!photon) return;
    // Exclude the body projection, including the smoothed destination and growth.
    // Vertical trajectories can never drift into a stationary player later.
    const halfBody = Math.max(size, targetSize) * .39;
    const left = Math.max(12, Math.min(x, target) - halfBody - 14);
    const right = Math.min(WIDTH - 12, Math.max(x, target) + halfBody + 14);
    const leftSpace = left - 12, rightSpace = WIDTH - 12 - right;
    if (leftSpace + rightSpace < 1) return;
    const sample = Math.random() * (leftSpace + rightSpace);
    photon.x = sample < leftSpace ? 12 + sample : right + sample - leftSpace;
    photon.y = seed ? Math.random() * 270 - 40 : -28;
    photon.speed = 83 + Math.random() * 36;
    photon.color = Math.floor(Math.random() * art.colors.length);
    photon.radius = 3 + Math.random() * 1.7;
    photon.travel = travel; photon.active = true; photon.scale = 1;
  }
  function catchPhoton(photon) {
    photon.active = false; targetSize = Math.min(MAX_SIZE, targetSize + 2.6); bounce = 1;
    if (injured) { injured = false; recovery = 1; impact = 0; invulnerable = Math.max(invulnerable, .8); }
    burst(photon.x, photon.y, photon.color);
  }
  function burst(atX, atY, color) {
    let count = 0;
    for (const spark of sparks) {
      if (spark.life > 0) continue;
      const angle = Math.PI * (1.12 + count * .15);
      spark.x = atX; spark.y = atY;
      spark.vx = Math.cos(angle) * 28; spark.vy = Math.sin(angle) * 42;
      spark.life = .55; spark.color = color; spark.scale = 1;
      if (++count === (game.reduceMotion ? 2 : 6)) break;
    }
  }
  function floorSurface(atX, inset = 0) {
    // Inset a falling disc from the true quarter-circle, rather than letting
    // its glow disappear past the CSS clipping edge before the collision.
    const radius = Math.max(.1, cornerRadius - inset);
    const dx = Math.max(cornerRadius - atX, atX - (WIDTH - cornerRadius), 0);
    return HEIGHT - cornerRadius + Math.sqrt(Math.max(0, radius * radius - dx * dx));
  }
  function splash(photon, speedFactor) {
    const floorY = floorSurface(photon.x, photon.radius);
    let nx = 0, ny = -1;
    if (photon.x < cornerRadius || photon.x > WIDTH - cornerRadius) {
      const centerX = photon.x < cornerRadius ? cornerRadius : WIDTH - cornerRadius;
      const radius = Math.max(.1, cornerRadius - photon.radius);
      nx = (centerX - photon.x) / radius; ny = (HEIGHT - cornerRadius - floorY) / radius;
    }
    // The fan follows the inward surface normal. Corner hits travel diagonally
    // into the scene instead of being sprayed out of the rounded rectangle.
    const atX = photon.x - nx * photon.radius, atY = floorY - ny * photon.radius;
    const strength = clamp(Math.sqrt(speedFactor), .7, 1.7), count = game.reduceMotion ? 3 : 7;
    let emitted = 0;
    for (const drop of splashDrops) {
      if (drop.life > 0) continue;
      const spread = ((emitted / (count - 1) - .5) * 104 + (Math.random() - .5) * 12) * strength;
      const lift = (35 + Math.random() * 38) * strength;
      drop.x = atX + nx * 2; drop.y = atY + ny * 2;
      drop.vx = nx * lift - ny * spread; drop.vy = ny * lift + nx * spread;
      drop.life = drop.duration = .45 + Math.random() * .25;
      drop.radius = .8 + Math.random() * .85; drop.color = photon.color; drop.scale = 1;
      if (++emitted === count) break;
    }
    const ripple = ripples.find(item => item.life <= 0);
    if (ripple) Object.assign(ripple, { x: atX + nx, y: atY + ny, nx, ny, life: .35, color: photon.color, scale: 1 });
    photon.active = false;
  }
  function emitArrow(index, count) {
    const arrow = arrows.find(item => !item.active);
    if (!arrow) return;
    const atY = -60 - index * 54;
    for (let attempt = 0; attempt < 16; attempt++) {
      const lane = (index + .5) * (WIDTH - 36) / count + 18;
      const atX = attempt === 0 ? clamp(index === 0 ? x + (Math.random() - .5) * 90 : lane, 18, WIDTH - 18) : 18 + Math.random() * (WIDTH - 36);
      // Include earlier waves, not just siblings. Never force a blocked spawn.
      if (arrows.some(other => other.active && Math.abs(other.y - atY) <= ARROW_BAND && Math.abs(other.x - atX) <= ARROW_GAP)) continue;
      // All damaging arrows share one speed, preserving their safe spacing
      // throughout the fall. Carried scenery has level-change protection.
      Object.assign(arrow, { x: atX, y: atY, active: true, scale: 1, carried: false });
      return;
    }
  }
  function hitsMochi(item, previousY, previousX, padding = 3) {
    // Sweep relative movement against the body, including fast sideways dodges.
    // Padding covers the arrowhead or photon radius.
    const centerY = MOCHI_Y - 2 - size * 22 / 64;
    const rx = size * .39 + padding, ry = size * .33 + padding;
    const x0 = (item.x - previousX) / rx, y0 = (previousY - centerY) / ry;
    const dx = (previousX - x) / rx, dy = (item.y - previousY) / ry;
    const length = dx * dx + dy * dy;
    const t = length ? clamp(-(x0 * dx + y0 * dy) / length, 0, 1) : 0;
    return (x0 + dx * t) ** 2 + (y0 + dy * t) ** 2 <= 1;
  }
  function transition() { return game.reduceMotion ? 1 : ease((age - INTRO_HOLD) / 2.1); }
  function levelProgress() { return levelTransition ? clamp(levelTransition.elapsed / LEVEL_DURATION, 0, 1) : 0; }
  function sceneZoom() { return 1 - .5 * zoomEase(levelProgress()); }
  function beginNextLevel() {
    levelTransition = { elapsed: 0 };
    size = targetSize = MAX_SIZE; bounce = impact = recovery = 0;
    injured = false;
    for (const particle of streams) if (particle.active) {
      particle.wrap = false;
      // Four inherited zooms leave a stroke at most .05 logical pixels. Reuse
      // that imperceptible detail so even an endless world keeps a fixed pool.
      if (particle.depth >= STREAM_DEPTH_LIMIT) particle.active = false;
    }
    let added = 0;
    for (const particle of streams) {
      if (particle.active) continue;
      // Populate the surrounding 2x world before moving the camera. These
      // particles enter through the viewport edges, never by a crossfade.
      const region = (added + Math.random()) / 36 * WIDTH * HEIGHT * 3;
      const topArea = WIDTH * 2 * ZOOM_Y;
      if (region < topArea) {
        particle.x = -WIDTH / 2 + Math.random() * WIDTH * 2;
        particle.y = -ZOOM_Y + Math.random() * ZOOM_Y;
      } else if (region < topArea + WIDTH * HEIGHT) {
        const side = Math.random() * WIDTH;
        particle.x = side < WIDTH / 2 ? side - WIDTH / 2 : side + WIDTH / 2;
        particle.y = Math.random() * HEIGHT;
      } else {
        particle.x = -WIDTH / 2 + Math.random() * WIDTH * 2;
        particle.y = HEIGHT + Math.random() * (HEIGHT - ZOOM_Y);
      }
      Object.assign(particle, { active: true, ambient: true, depth: 0, wrap: true,
        speed: 48 + Math.random() * 52, length: 3 + Math.random() * 15 });
      if (++added === 36) break;
    }
    if (game.reduceMotion) finishNextLevel();
  }
  function finishNextLevel() {
    // Rebase after the 1:2 camera zoom: no accumulating world coordinates,
    // tiny hit targets or unbounded speeds even after hundreds of chapters.
    x = WIDTH / 2 + (x - WIDTH / 2) / 2;
    target = WIDTH / 2 + (target - WIDTH / 2) / 2;
    size = targetSize = BASE_SIZE; level++; levelTransition = undefined;
    invulnerable = 1.2; spawn = .15; arrowSpawn = 2.2;
    // Bake the final camera transform into every retained object. The first
    // frame of the new level is the same scene as the last frame of the zoom.
    for (const pool of [photons, arrows, sparks, splashDrops, ripples, streams]) for (const item of pool) {
      if (!item.active && !(item.life > 0)) continue;
      item.x = WIDTH / 2 + (item.x - WIDTH / 2) / 2;
      item.y = ZOOM_Y + (item.y - ZOOM_Y) / 2;
      if (item.scale !== undefined) item.scale /= 2;
      if (item.radius !== undefined) item.radius /= 2;
      if (item.speed !== undefined) item.speed /= 2;
      if (item.vx !== undefined) { item.vx /= 2; item.vy /= 2; }
      if (item.length !== undefined) { item.length /= 2; item.depth++; }
    }
    // Old, now distant arrows complete their visible fall under level-change
    // grace. Only freshly generated arrows can hurt, with full safe spacing.
    for (const arrow of arrows) if (arrow.active) arrow.carried = true;
    if (pointer) {
      pointer.start = target; pointer.x = pointer.lastX; pointer.y = pointer.lastY;
    }
    move(target);
  }
  function advance(dt) {
    age += dt;
    const previousX = x;
    x += (target - x) * (1 - Math.exp(-18 * dt));
    if (levelTransition) {
      levelTransition.elapsed += dt;
      if (levelProgress() >= 1 || game.reduceMotion) finishNextLevel();
      draw(); return;
    }
    bounce = Math.max(0, bounce - dt * 2.4);
    impact = Math.max(0, impact - dt * 3);
    invulnerable = Math.max(0, invulnerable - dt);
    recovery = Math.max(0, recovery - dt * 2);
    size += (targetSize - size) * (1 - Math.exp(-(targetSize < size ? 13 : 5) * dt));
    // Area-based scaling gives a visible .47x–4x range, continuous across hits
    // and growth. Every airborne object uses the same current factor.
    const difficulty = 1 + .25 * (1 - Math.exp(-level / 5));
    const speedFactor = (size / BASE_SIZE) ** 2 * difficulty, blend = transition();
    const growth = clamp((size - BASE_SIZE) / (MAX_SIZE - BASE_SIZE), 0, 1);
    for (const particle of streams) {
      if (!particle.active) continue;
      if ((!particle.ambient && blend === 1) || (game.reduceMotion && !particle.ambient)) { particle.active = false; continue; }
      particle.y += particle.speed * (.45 + .55 * (1 - blend)) * speedFactor * dt;
      if (particle.y > HEIGHT + particle.length) {
        if (particle.wrap) particle.y = -particle.length;
        else particle.active = false;
      }
    }
    if (!started && (game.reduceMotion || age >= INTRO_HOLD + .15)) {
      started = true;
      for (let i = 0; i < (game.reduceMotion ? 4 : 7); i++) emit(true);
    }
    if (started) {
      spawn -= dt;
      if (spawn <= 0) { emit(); spawn = game.reduceMotion ? .9 : .36; }
    }
    // Requested density rises with growth, but safe spacing always wins.
    arrowSpawn -= dt * (1 + growth * 2.8);
    if (arrowSpawn <= 0) {
      const count = 1 + Math.floor(growth * 3.05);
      for (let i = 0; i < count; i++) emitArrow(i, count);
      arrowSpawn = 2.7 + Math.random() * .8;
    }
    for (const photon of photons) {
      if (!photon.active) continue;
      const previousY = photon.y;
      photon.y += photon.speed * speedFactor * dt;
      if ((game.reduceMotion || age > INTRO_HOLD + .8) && travel - photon.travel >= 8 && hitsMochi(photon, previousY, previousX, photon.radius)) catchPhoton(photon);
      else if (photon.y >= floorSurface(photon.x, photon.radius)) splash(photon, speedFactor);
    }
    for (const arrow of arrows) {
      if (!arrow.active) continue;
      const previousY = arrow.y;
      arrow.y += ARROW_SPEED * arrow.scale * speedFactor * dt;
      if (!arrow.carried && hitsMochi(arrow, previousY, previousX)) {
        arrow.active = false;
        if (!invulnerable) {
          injured = true; impact = 1; invulnerable = 1.2; recovery = 0;
          // Persistent loss: the target itself shrinks, so interpolation cannot
          // silently grow the body back without the player catching photons.
          targetSize = Math.max(MIN_SIZE, Math.min(size, targetSize) * .82);
          bounce = 0;
          burst(arrow.x, arrow.y, 1);
        }
      } else if (arrow.y > HEIGHT + 60) arrow.active = false;
    }
    for (const spark of sparks) if (spark.life > 0) {
      spark.life -= dt; spark.x += spark.vx * dt; spark.y += spark.vy * dt; spark.vy += 70 * spark.scale * dt;
    }
    for (const drop of splashDrops) if (drop.life > 0) {
      drop.life -= dt; drop.x += drop.vx * dt; drop.y += drop.vy * dt; drop.vy += 175 * drop.scale * dt;
      if (drop.x < drop.radius || drop.x > WIDTH - drop.radius || drop.y >= floorSurface(drop.x, drop.radius)) drop.life = 0;
    }
    for (const ripple of ripples) if (ripple.life > 0) ripple.life -= dt;
    if (targetSize >= MAX_SIZE && size >= MAX_SIZE - .5) beginNextLevel();
    draw();
  }
  function draw() {
    dark = document.documentElement.dataset.theme === 'dark';
    if (!art || art.dark !== dark) art = artwork(dark);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.save(); ctx.clip(boundary);
    const progress = levelProgress(), zoom = sceneZoom();
    ctx.save();
    ctx.translate(WIDTH / 2, ZOOM_Y); ctx.scale(zoom, zoom); ctx.translate(-WIDTH / 2, -ZOOM_Y);
    drawStreams(zoom);
    drawSplashes();
    const photonReveal = game.reduceMotion ? 1 : ease((age - INTRO_HOLD - .15) / 1.15);
    for (const photon of photons) if (photon.active) {
      const r = photon.radius, length = (game.reduceMotion ? 16 : 43) * photon.scale;
      ctx.globalAlpha = (dark ? .78 : .92) * photonReveal;
      ctx.drawImage(art.photons[photon.color], photon.x - r * 2, photon.y - length, r * 4, length * 112 / 88);
    }
    ctx.globalAlpha = dark ? .95 : 1;
    for (const arrow of arrows) if (arrow.active) ctx.drawImage(art.arrow, arrow.x - 16 * arrow.scale, arrow.y - 60 * arrow.scale, 32 * arrow.scale, 72 * arrow.scale);
    ctx.globalAlpha = 1;
    const enter = game.reduceMotion ? 1 : ease((age - INTRO_HOLD) / .8);
    const shake = game.reduceMotion ? 0 : Math.sin(impact * Math.PI * 5) * impact * 2;
    ctx.save(); ctx.translate(x + shake, ZOOM_Y + (1 - enter) * 42); ctx.globalAlpha = enter;
    const squash = game.reduceMotion ? 0 : Math.sin(bounce * Math.PI * 2) * bounce * .12 + impact * .05;
    ctx.save(); ctx.scale(1 + squash, 1 - squash);
    const face = injured ? faces.hurt : levelTransition || bounce > .4 ? faces.happy : age % 5.2 > 5.04 ? faces.blink : faces.open;
    ctx.drawImage(face, -size / 2, -size * 56 / 64, size, size); ctx.restore();
    if (recovery > 0 && !game.reduceMotion) {
      ctx.globalAlpha = recovery * .35; ctx.strokeStyle = art.colors[0]; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.ellipse(0, -size * .34, size * (.38 + (1 - recovery) * .18), size * .35, 0, 0, Math.PI * 2); ctx.stroke();
    }
    // A brief, wordless horizontal gesture cue; it never moves the player.
    if (!travel && age > 2 && age < 7 && !game.reduceMotion) {
      ctx.globalAlpha = enter * Math.min(1, 7 - age) * .32;
      ctx.strokeStyle = art.gesture; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(-28, 20); ctx.lineTo(28, 20); ctx.moveTo(-23, 17); ctx.lineTo(-28, 20); ctx.lineTo(-23, 23);
      ctx.moveTo(23, 17); ctx.lineTo(28, 20); ctx.lineTo(23, 23); ctx.stroke();
    }
    ctx.restore();
    for (const spark of sparks) if (spark.life > 0) {
      ctx.globalAlpha = spark.life / .55; ctx.fillStyle = art.colors[spark.color];
      ctx.beginPath(); ctx.arc(spark.x, spark.y, 1.7 * spark.scale, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    if (levelTransition) {
      // A small chapter marker accompanies the continuous camera pullback.
      ctx.globalAlpha = Math.sin(progress * Math.PI) * .72;
      ctx.fillStyle = art.chapter; ctx.font = '500 18px serif'; ctx.textAlign = 'center';
      ctx.fillText(String(level + 2).padStart(2, '0'), WIDTH / 2, 112 - ease(progress) * 10);
    }
    ctx.restore(); ctx.globalAlpha = 1;
  }
  function drawSplashes() {
    for (const ripple of ripples) if (ripple.life > 0) {
      const progress = 1 - ripple.life / .35;
      ctx.save(); ctx.translate(ripple.x, ripple.y);
      ctx.transform(-ripple.ny, ripple.nx, ripple.nx, ripple.ny, 0, 0);
      ctx.scale(ripple.scale, ripple.scale);
      ctx.globalAlpha = (1 - progress) * .5; ctx.strokeStyle = art.colors[ripple.color]; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(0, 1, 3 + progress * 13, 1.5 + progress * 3, 0, 0, Math.PI); ctx.stroke(); ctx.restore();
    }
    for (const drop of splashDrops) if (drop.life > 0) {
      ctx.globalAlpha = Math.min(1, drop.life / drop.duration * 1.4);
      const r = drop.radius * 3;
      // Reuse the photon's cached glow; splashes allocate no new gradients.
      ctx.drawImage(art.photons[drop.color], 0, 72, 32, 32, drop.x - r, drop.y - r, r * 2, r * 2);
      ctx.strokeStyle = art.colors[drop.color]; ctx.lineWidth = drop.radius;
      ctx.beginPath(); ctx.moveTo(drop.x, drop.y); ctx.lineTo(drop.x - drop.vx * .018, drop.y - drop.vy * .018); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  function drawStreams(zoom) {
    const blend = transition();
    ctx.strokeStyle = art.stream; ctx.lineCap = 'round';
    // Batch retained depths too, preserving stroke widths across the rebase.
    // Imperceptible old depths are recycled before another zoom.
    for (let layer = 0; layer < 2; layer++) {
      const ambient = layer === 0;
      if (!ambient && (blend === 1 || game.reduceMotion)) continue;
      for (let depth = 0; depth <= STREAM_DEPTH_LIMIT; depth++) for (let band = 0; band < 3; band++) {
        ctx.lineWidth = .8 * 2 ** -depth;
        ctx.globalAlpha = ((1 - blend) * (dark ? .48 : .42) + (ambient ? blend * (dark ? .32 : .28) : 0)) * (1 - band * .2);
        ctx.beginPath();
        for (const particle of streams) {
          if (!particle.active || particle.ambient !== ambient || particle.band !== band || particle.depth !== depth) continue;
          // Clip against the camera's viewport, not the old world's rectangle:
          // surrounding particles are revealed as the field of view expands.
          const screenX = WIDTH / 2 + (particle.x - WIDTH / 2) * zoom;
          const screenY = ZOOM_Y + (particle.y - ZOOM_Y) * zoom;
          const edge = Math.min(screenX / 14, (WIDTH - screenX) / 14, screenY / 16, (HEIGHT - screenY) / 10);
          if (edge < .2 + band * .16) continue;
          const tail = particle.y - particle.length * (1 - blend * .25);
          ctx.moveTo(particle.x, tail); ctx.lineTo(particle.x, particle.y);
          if (particle.tick && !game.reduceMotion) {
            const halfTick = 1.2 * 2 ** -particle.depth;
            ctx.moveTo(particle.x - halfTick, particle.y); ctx.lineTo(particle.x + halfTick, particle.y);
          }
        }
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }
  function dispose() {
    if (dead) return;
    dead = true; events.abort(); intersection.unobserve(node); resize.unobserve(node);
    byNode.delete(node); games.delete(game);
    canvas.width = canvas.height = 1;
    for (const face of Object.values(faces)) face.width = face.height = 1;
    if (!games.size) stopObservers();
  }
  games.add(game); byNode.set(node, game); resizeCanvas(288);
  draw(); intersection.observe(node); resize.observe(node);
  return game;
}
