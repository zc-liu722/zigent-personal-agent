import { el } from '../dom.js';
import { createMochiSprite, randomMochiHue } from './mochi.js';

const WIDTH = 300, HEIGHT = 400, BOARD_Y = 348, HALF_BOARD = 45;
const BASE_SIZE = 64, MIN_SIZE = 44, MAX_SIZE = 128, INTRO_HOLD = 1;
const colors = ['#66d9bb', '#f4a69e', '#b3a1ed', '#f0cc83'];
const games = new Set();
let frame, lastTime = 0, intersection, resize, sprites, motion;
const byNode = new WeakMap();
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const ease = value => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };
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

function photonSprite(color) {
  const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 112;
  const ctx = canvas.getContext('2d');
  const trail = ctx.createLinearGradient(0, 0, 0, 87);
  trail.addColorStop(0, `${color}00`); trail.addColorStop(1, `${color}a0`);
  ctx.fillStyle = trail; ctx.fillRect(14, 0, 4, 86);
  const glow = ctx.createRadialGradient(16, 88, 1, 16, 88, 15);
  glow.addColorStop(0, '#fffef2'); glow.addColorStop(.16, color); glow.addColorStop(1, `${color}00`);
  ctx.fillStyle = glow; ctx.fillRect(0, 72, 32, 32);
  return canvas;
}
function artwork() {
  return sprites ||= { photons: colors.map(photonSprite), arrows: [arrowSprite(false), arrowSprite(true)] };
}
function arrowSprite(dark) {
  const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 144;
  const ctx = canvas.getContext('2d'); ctx.scale(2, 2);
  // Pearl/slate facets echo the paddle. A small rose edge distinguishes hazards
  // from photons without turning them into heavy red UI icons.
  const trail = ctx.createLinearGradient(0, 1, 0, 18);
  trail.addColorStop(0, '#acb6d000'); trail.addColorStop(1, dark ? '#c3cce480' : '#8c98ba50');
  ctx.fillStyle = trail; ctx.fillRect(15.6, 1, .8, 17);
  const metal = ctx.createLinearGradient(10, 0, 22, 0);
  metal.addColorStop(0, dark ? '#8796b8' : '#8793ae'); metal.addColorStop(.48, dark ? '#eef0fc' : '#e0e5f3');
  metal.addColorStop(.56, dark ? '#bdc8e5' : '#b2bdd7'); metal.addColorStop(1, dark ? '#7383a9' : '#74819e');
  ctx.fillStyle = metal;
  ctx.fill(new Path2D('M15.15 19Q16 17 16.85 19L16.7 50H15.3Z'));
  // Two shaped vanes, with fine etched ribs instead of an open chevron tail.
  const vanes = new Path2D('M15.2 27.5L11.5 23.6Q11 23.1 11 22.2V15.5Q11 14.8 11.6 15.4L15.2 19.6ZM16.8 27.5L20.5 23.6Q21 23.1 21 22.2V15.5Q21 14.8 20.4 15.4L16.8 19.6Z');
  ctx.fillStyle = dark ? '#aab6d9ba' : '#a8b2d0a6'; ctx.fill(vanes);
  ctx.strokeStyle = dark ? '#eef1ff99' : '#f5f6ffcc'; ctx.lineWidth = .55;
  ctx.beginPath(); ctx.moveTo(12, 18); ctx.lineTo(14.5, 21); ctx.moveTo(12, 21); ctx.lineTo(14.5, 24);
  ctx.moveTo(20, 18); ctx.lineTo(17.5, 21); ctx.moveTo(20, 21); ctx.lineTo(17.5, 24); ctx.stroke();
  const head = new Path2D('M16 60L10.8 46.3Q10.4 45.3 11.4 45.9L16 48L20.6 45.9Q21.6 45.3 21.2 46.3Z');
  ctx.fillStyle = metal; ctx.fill(head);
  ctx.fillStyle = dark ? '#eff2ff66' : '#fbfcff99'; ctx.fill(new Path2D('M16 48L11.3 46.3L16 59Z'));
  ctx.strokeStyle = dark ? '#dfe7ffb3' : '#7d8ba580'; ctx.lineWidth = .55; ctx.lineJoin = 'round'; ctx.stroke(head);
  ctx.strokeStyle = dark ? '#f2b4ad' : '#c28686'; ctx.lineWidth = .7;
  ctx.beginPath(); ctx.moveTo(16.2, 49.5); ctx.lineTo(16.2, 57.8); ctx.stroke();
  ctx.fillStyle = dark ? '#e6b4b7' : '#c298a3'; ctx.fillRect(14.8, 30, 2.4, 1.2);
  ctx.strokeStyle = '#ffffffb3'; ctx.lineWidth = .45;
  ctx.beginPath(); ctx.moveTo(15.55, 32.5); ctx.lineTo(15.55, 44.5); ctx.stroke();
  return canvas;
}

/** An entirely local, bounded Canvas scene. No network, DOM animation loop or assets. */
export function createImageGeneration() {
  if (!games.size) startObservers();
  const node = el('div', 'image-generation'), canvas = el('canvas', 'image-generation-canvas');
  node.setAttribute('role', 'group'); node.setAttribute('aria-label', '接光点养团子');
  canvas.tabIndex = 0; canvas.setAttribute('role', 'slider');
  canvas.setAttribute('aria-label', '左右移动滑板接光点、躲避箭'); canvas.setAttribute('aria-orientation', 'horizontal');
  canvas.setAttribute('aria-valuemin', '0'); canvas.setAttribute('aria-valuemax', '100'); canvas.setAttribute('aria-valuenow', '50');
  node.append(canvas);
  // Transparent all the way through: the conversation's actual background shows
  // through in both themes. Only flowing particles define the waiting region.
  const ctx = canvas.getContext('2d'), art = artwork(), hue = randomMochiHue();
  const faces = { open: createMochiSprite('open', hue), happy: createMochiSprite('happy', hue),
    blink: createMochiSprite('shut', hue), hurt: createMochiSprite('hurt', hue) };
  const events = new AbortController();
  let width = 0, scale = 1, dark, boardFill, dead = false, age = 0, spawn = 0, arrowSpawn = 4.5, started = false;
  let x = WIDTH / 2, target = x, travel = 0, targetSize = BASE_SIZE, size = BASE_SIZE, bounce = 0;
  let injured = false, impact = 0, invulnerable = 0, recovery = 0;
  let pointer, lastAria = 50;
  // Fixed pools keep both memory and draw cost constant, even during long waits.
  const photons = Array.from({ length: 24 }, () => ({ active: false }));
  const arrows = Array.from({ length: 16 }, () => ({ active: false }));
  const sparks = Array.from({ length: 24 }, () => ({ life: 0 }));
  const streams = Array.from({ length: 96 }, (_, i) => ({ x: 8 + Math.random() * (WIDTH - 16),
    y: Math.random() * HEIGHT, speed: 48 + Math.random() * 52, length: 3 + Math.random() * 15,
    band: i % 3, ambient: i < 15, tick: i % 5 === 0 }));
  const game = { node, visible: false, reduceMotion: motion.matches, resize: resizeCanvas, advance, dispose };

  function rebuildPaint() {
    // Gradients are cached too: the moving board allocates no paint objects.
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    boardFill = ctx.createLinearGradient(0, BOARD_Y - 10, 0, BOARD_Y + 13);
    boardFill.addColorStop(0, dark ? '#bbc2db' : '#d0d4e8'); boardFill.addColorStop(1, dark ? '#737d9f' : '#9aa4c5');
  }
  function resizeCanvas(nextWidth = width || 288) {
    if (dead || nextWidth <= 0) return;
    width = nextWidth;
    const pixels = Math.max(1, Math.round(width * Math.min(devicePixelRatio || 1, 2)));
    if (canvas.width === pixels && canvas.height === Math.round(pixels * HEIGHT / WIDTH) && boardFill) return;
    canvas.width = pixels; canvas.height = Math.round(pixels * HEIGHT / WIDTH); scale = pixels / WIDTH;
    rebuildPaint(); draw();
  }
  function move(next) {
    const bounded = clamp(next, HALF_BOARD + 8, WIDTH - HALF_BOARD - 8);
    // Only intentional input contributes to catch eligibility; smoothing/resize never do.
    travel += Math.abs(bounded - target); target = bounded;
    const percent = Math.round((target - HALF_BOARD - 8) / (WIDTH - 2 * (HALF_BOARD + 8)) * 100);
    if (percent !== lastAria) { canvas.setAttribute('aria-valuenow', `${percent}`); lastAria = percent; }
  }
  function pointerX(event) {
    const rect = canvas.getBoundingClientRect();
    return (event.clientX - rect.left) / rect.width * WIDTH;
  }
  canvas.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, start: target, dragging: event.pointerType === 'mouse' };
    if (event.pointerType === 'mouse') { move(pointerX(event)); pointer.start = target; }
    canvas.setPointerCapture(event.pointerId);
  }, { signal: events.signal });
  canvas.addEventListener('pointermove', event => {
    if (event.pointerType === 'mouse' && !pointer) { move(pointerX(event)); return; }
    if (!pointer || event.pointerId !== pointer.id) return;
    const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y;
    if (!pointer.dragging) {
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 6) { pointer = undefined; return; }
      if (Math.abs(dx) < 5) return;
      pointer.dragging = true;
    }
    const rect = canvas.getBoundingClientRect();
    move(pointer.start + dx / rect.width * WIDTH);
  }, { signal: events.signal, passive: true });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(type, () => { pointer = undefined; }, { signal: events.signal });
  canvas.addEventListener('keydown', event => {
    const delta = { ArrowLeft: -22, ArrowRight: 22, Home: -WIDTH, End: WIDTH }[event.key];
    if (delta === undefined) return;
    event.preventDefault(); event.stopPropagation(); move(target + delta);
  }, { signal: events.signal });
  canvas.addEventListener('blur', () => { pointer = undefined; }, { signal: events.signal });

  function emit(seed = false) {
    const photon = photons.find(item => !item.active);
    if (!photon) return;
    // Exclude the entire paddle projection, including the smoothed destination.
    // Vertical trajectories can never drift into a stationary paddle later.
    const left = Math.max(12, Math.min(x, target) - HALF_BOARD - 14);
    const right = Math.min(WIDTH - 12, Math.max(x, target) + HALF_BOARD + 14);
    const leftSpace = left - 12, rightSpace = WIDTH - 12 - right;
    if (leftSpace + rightSpace < 1) return;
    const sample = Math.random() * (leftSpace + rightSpace);
    photon.x = sample < leftSpace ? 12 + sample : right + sample - leftSpace;
    photon.y = seed ? Math.random() * 270 - 40 : -28;
    photon.speed = 83 + Math.random() * 36;
    photon.color = Math.floor(Math.random() * colors.length);
    photon.radius = 3 + Math.random() * 1.7;
    photon.travel = travel; photon.active = true;
  }
  function catchPhoton(photon) {
    photon.active = false; targetSize = Math.min(MAX_SIZE, targetSize + 2.6); bounce = 1;
    if (injured) { injured = false; recovery = 1; impact = 0; invulnerable = Math.max(invulnerable, .8); }
    burst(photon.x, BOARD_Y - size * .6, photon.color);
  }
  function burst(atX, atY, color) {
    let count = 0;
    for (const spark of sparks) {
      if (spark.life > 0) continue;
      const angle = Math.PI * (1.12 + count * .15);
      spark.x = atX; spark.y = atY;
      spark.vx = Math.cos(angle) * 28; spark.vy = Math.sin(angle) * 42;
      spark.life = .55; spark.color = color;
      if (++count === (game.reduceMotion ? 2 : 6)) break;
    }
  }
  function emitArrow(index, count) {
    const arrow = arrows.find(item => !item.active);
    if (!arrow) return;
    // Give a stationary player a reason to move, with a full fall's warning.
    const lane = (index + .5) * (WIDTH - 36) / count + 18;
    arrow.x = index === 0 && Math.random() < .65 ? clamp(x + (Math.random() - .5) * 90, 18, WIDTH - 18) : clamp(lane + (Math.random() - .5) * 24, 18, WIDTH - 18);
    // Stagger heights as well as lanes: larger waves must not form a solid wall.
    arrow.y = -60 - index * 54; arrow.speed = 84 + Math.random() * 18; arrow.active = true;
  }
  function hitsMochi(arrow, previousY, previousX) {
    // Sweep relative movement against the body, including fast sideways dodges.
    // Padding covers the arrowhead; the paddle itself never takes damage.
    const centerY = BOARD_Y - 2 - size * 22 / 64;
    const rx = size * .39 + 3, ry = size * .33 + 3;
    const x0 = (arrow.x - previousX) / rx, y0 = (previousY - centerY) / ry;
    const dx = (previousX - x) / rx, dy = (arrow.y - previousY) / ry;
    const length = dx * dx + dy * dy;
    const t = length ? clamp(-(x0 * dx + y0 * dy) / length, 0, 1) : 0;
    return (x0 + dx * t) ** 2 + (y0 + dy * t) ** 2 <= 1;
  }
  function transition() { return game.reduceMotion ? 1 : ease((age - INTRO_HOLD) / 2.1); }
  function advance(dt) {
    const nextDark = document.documentElement.dataset.theme === 'dark';
    if (nextDark !== dark) { dark = nextDark; rebuildPaint(); }
    age += dt;
    const previousX = x;
    x += (target - x) * (1 - Math.exp(-18 * dt));
    bounce = Math.max(0, bounce - dt * 2.4);
    impact = Math.max(0, impact - dt * 3);
    invulnerable = Math.max(0, invulnerable - dt);
    recovery = Math.max(0, recovery - dt * 2);
    size += (targetSize - size) * (1 - Math.exp(-(targetSize < size ? 13 : 5) * dt));
    // Area-based scaling gives a visible .47x–4x range, continuous across hits
    // and growth. Every airborne object uses the same current factor.
    const speedFactor = (size / BASE_SIZE) ** 2, blend = transition();
    const growth = clamp((size - BASE_SIZE) / (MAX_SIZE - BASE_SIZE), 0, 1);
    for (const particle of streams) {
      if ((!particle.ambient && blend === 1) || (game.reduceMotion && !particle.ambient)) continue;
      particle.y += particle.speed * (.45 + .55 * (1 - blend)) * speedFactor * dt;
      if (particle.y > HEIGHT + particle.length) particle.y = -particle.length;
    }
    if (!started && (game.reduceMotion || age >= INTRO_HOLD + .15)) {
      started = true;
      for (let i = 0; i < (game.reduceMotion ? 4 : 7); i++) emit(true);
    }
    if (started) {
      spawn -= dt;
      if (spawn <= 0) { emit(); spawn = game.reduceMotion ? .9 : .36; }
    }
    // Both the wave size (1–4) and cadence rise with the visible body size.
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
      const dx = Math.abs(photon.x - x);
      const surface = dx < size * .32 ? BOARD_Y - size * .62 : BOARD_Y - 7;
      if ((game.reduceMotion || age > INTRO_HOLD + .8) && previousY < surface && photon.y >= surface && dx < HALF_BOARD - 5 && travel - photon.travel >= 8) catchPhoton(photon);
      else if (photon.y > HEIGHT + 42) photon.active = false;
    }
    for (const arrow of arrows) {
      if (!arrow.active) continue;
      const previousY = arrow.y;
      arrow.y += arrow.speed * speedFactor * dt;
      if (hitsMochi(arrow, previousY, previousX)) {
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
      spark.life -= dt; spark.x += spark.vx * dt; spark.y += spark.vy * dt; spark.vy += 70 * dt;
    }
    draw();
  }
  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawStreams();
    const photonReveal = game.reduceMotion ? 1 : ease((age - INTRO_HOLD - .15) / 1.15);
    for (const photon of photons) if (photon.active) {
      const r = photon.radius, length = game.reduceMotion ? 16 : 43;
      ctx.globalAlpha = (dark ? .78 : .92) * photonReveal;
      ctx.drawImage(art.photons[photon.color], photon.x - r * 2, photon.y - length, r * 4, length * 112 / 88);
    }
    ctx.globalAlpha = dark ? .95 : 1;
    for (const arrow of arrows) if (arrow.active) ctx.drawImage(art.arrows[dark ? 1 : 0], arrow.x - 16, arrow.y - 60, 32, 72);
    ctx.globalAlpha = 1;
    const enter = game.reduceMotion ? 1 : ease((age - INTRO_HOLD) / .8);
    const shake = game.reduceMotion ? 0 : Math.sin(impact * Math.PI * 5) * impact * 2;
    ctx.save(); ctx.translate(x + shake, BOARD_Y + (1 - enter) * 42); ctx.globalAlpha = enter;
    ctx.fillStyle = dark ? '#00000026' : '#55545c12';
    ctx.beginPath(); ctx.ellipse(0, 17, 47, 4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = boardFill; ctx.lineWidth = 10; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-HALF_BOARD, -9); ctx.quadraticCurveTo(-39, 7, -28, 7);
    ctx.lineTo(28, 7); ctx.quadraticCurveTo(39, 7, HALF_BOARD, -9); ctx.stroke();
    ctx.strokeStyle = '#ffffff66'; ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.moveTo(-40, -7); ctx.quadraticCurveTo(-34, 3, -26, 3); ctx.lineTo(26, 3); ctx.stroke();
    const squash = game.reduceMotion ? 0 : Math.sin(bounce * Math.PI * 2) * bounce * .12 + impact * .05;
    ctx.save(); ctx.translate(0, -2); ctx.scale(1 + squash, 1 - squash);
    const face = injured ? faces.hurt : bounce > .4 ? faces.happy : age % 5.2 > 5.04 ? faces.blink : faces.open;
    ctx.drawImage(face, -size / 2, -size * 56 / 64, size, size); ctx.restore();
    if (recovery > 0 && !game.reduceMotion) {
      ctx.globalAlpha = recovery * .35; ctx.strokeStyle = colors[0]; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.ellipse(0, -size * .34, size * (.38 + (1 - recovery) * .18), size * .35, 0, 0, Math.PI * 2); ctx.stroke();
    }
    // A brief, wordless horizontal gesture cue; it never moves the real paddle.
    if (!travel && age > 2 && age < 7 && !game.reduceMotion) {
      ctx.globalAlpha = enter * Math.min(1, 7 - age) * .32;
      ctx.strokeStyle = dark ? '#bac4d4' : '#808694'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(-28, 31); ctx.lineTo(28, 31); ctx.moveTo(-23, 27); ctx.lineTo(-28, 31); ctx.lineTo(-23, 35);
      ctx.moveTo(23, 27); ctx.lineTo(28, 31); ctx.lineTo(23, 35); ctx.stroke();
    }
    ctx.restore();
    for (const spark of sparks) if (spark.life > 0) {
      ctx.globalAlpha = spark.life / .55; ctx.fillStyle = colors[spark.color];
      ctx.beginPath(); ctx.arc(spark.x, spark.y, 1.7, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  function drawStreams() {
    const blend = transition();
    ctx.strokeStyle = dark ? '#a8bacb' : '#718295'; ctx.lineWidth = .7; ctx.lineCap = 'round';
    // Six path batches in the intro, three afterwards. No per-particle gradients,
    // glow filters or DOM nodes; spent intro particles stop updating entirely.
    for (let layer = 0; layer < 2; layer++) {
      const ambient = layer === 0;
      if (!ambient && (blend === 1 || game.reduceMotion)) continue;
      for (let band = 0; band < 3; band++) {
        ctx.globalAlpha = ((1 - blend) * (dark ? .48 : .42) + (ambient ? blend * (dark ? .18 : .13) : 0)) * (1 - band * .2);
        ctx.beginPath();
        for (const particle of streams) {
          if (particle.ambient !== ambient || particle.band !== band) continue;
          // A soft, stepped falloff avoids a rectangular edge against the page.
          const edge = Math.min(particle.x / 22, (WIDTH - particle.x) / 22, particle.y / 26, (HEIGHT - particle.y) / 26);
          if (edge < .2 + band * .16) continue;
          const tail = particle.y - particle.length * (1 - blend * .45);
          ctx.moveTo(particle.x, tail); ctx.lineTo(particle.x, particle.y);
          if (particle.tick && !game.reduceMotion) { ctx.moveTo(particle.x - 1.2, particle.y); ctx.lineTo(particle.x + 1.2, particle.y); }
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
  dark = document.documentElement.dataset.theme === 'dark';
  games.add(game); byNode.set(node, game); resizeCanvas(288);
  draw(); intersection.observe(node); resize.observe(node);
  return game;
}
