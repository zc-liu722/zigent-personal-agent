// Trusted renderer for inert program attachment data. Persisted HTML is never mounted or evaluated here.
const stageNames = { awake: '清醒', rem: 'REM', core: '核心', deep: '深睡', asleep: '睡眠', inBed: '卧床', unspecified: '未分类', unknown: '未记录', conflict: '阶段冲突' };
const stages = new Set(Object.keys(stageNames)), sleeping = new Set(['core', 'deep', 'rem', 'asleep']);
function validData(data) {
  if (data?.type !== 'sleep-timeline' || data.version !== 1 || !Number.isSafeInteger(data.start) || data.start < 0 || data.start > 8e15
    || !Array.isArray(data.segments) || !data.segments.length || data.segments.length > 500) return false;
  let end = 0;
  for (const row of data.segments) {
    if (!Array.isArray(row) || row.length !== 3 || !Number.isSafeInteger(row[0]) || !Number.isSafeInteger(row[1])
      || row[0] !== end || row[1] <= row[0] || row[1] > 48 * 3600000 || !stages.has(row[2])) return false;
    end = row[1];
  }
  return true;
}
/** Legacy compatibility reads only the bounded JSON declaration from known program attachments. */
function readData(data, block) {
  if (data !== undefined) return validData(data) ? data : undefined;
  if (block?.type !== 'interactive' || typeof block.html !== 'string' || block.html.length > 32000) return;
  const saved = /const base=(\d+),D=(\[[^\n]+\]);\nconst names=/.exec(block.html);
  if (!saved) return;
  try {
    const legacy = { type: 'sleep-timeline', version: 1, start: Number(saved[1]), segments: JSON.parse(saved[2]) };
    return validData(legacy) ? legacy : undefined;
  } catch { return; }
}
const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
};

export function createSleepTimeline(data, block, options = {}) {
  if (block?.type !== 'interactive') return;
  const saved = readData(data, block);
  if (!saved) return;
  const { start: base, segments: D } = saved;
  const root = node('div', 'sleep-timeline'), hero = node('div', 'sleep-hero'), plot = node('div', 'sleep-plot'),
    labels = node('div', 'sleep-labels'), graph = node('div', 'sleep-graph'), axis = node('div', 'sleep-axis'),
    selection = node('div', 'sleep-selection'), slider = node('input', 'sleep-sr'), accessible = node('ol', 'sleep-sr');
  selection.setAttribute('aria-live', 'polite'); selection.setAttribute('aria-atomic', 'true');
  slider.type = 'range'; slider.min = '-1'; slider.step = '1'; slider.value = '-1';
  slider.setAttribute('aria-label', '查看睡眠时刻（北京时间）'); slider.setAttribute('aria-valuetext', '未选择时刻');
  accessible.setAttribute('aria-label', '全部睡眠分段明细'); axis.setAttribute('aria-hidden', 'true');
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.classList.add('sleep-chart'); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '睡眠阶段时间线，可点按查看；键盘用户可用下一个滑块选择时刻');
  graph.append(svg, axis); plot.append(labels, graph); root.append(hero, plot, selection, slider, accessible);
  const lanes = ['awake', 'rem', 'core', 'deep', ...['asleep', 'inBed', 'unspecified', 'conflict'].filter(k => D.some(d => d[2] === k))],
    row = 30, height = lanes.length * row, total = D.at(-1)[1], width = 600;
  const paint = k => 'var(--' + k + ')', x = t => t / total * width, y = k => lanes.indexOf(k) * row + row / 2;
  const fmt = (t, sec = false) => new Date(base + t + 28800000).toISOString().slice(11, sec ? 19 : 16);
  const duration = t => {
    const s = Math.round(t / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
    return h ? h + '小时' + (m % 60 ? m % 60 + '分' : '') : m ? m + '分' + (s % 60 ? s % 60 + '秒' : '') : s + '秒';
  };
  const briefDuration = t => {
    const m = Math.max(1, Math.round(t / 60000)), h = Math.floor(m / 60);
    return t < 60000 ? '不足1分' : h ? h + '时' + (m % 60 ? m % 60 + '分' : '') : m + '分';
  };
  const asleep = D.filter(d => sleeping.has(d[2])), sleepTime = asleep.reduce((sum, d) => sum + d[1] - d[0], 0),
    minutes = Math.round(sleepTime / 60000), hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (asleep.length) {
    if (hours) hero.append(node('strong', '', hours), node('small', '', '小时'));
    if (rest || !hours) hero.append(node('strong', '', rest), node('small', '', '分'));
  } else hero.append(node('strong', '', '—'));
  hero.setAttribute('aria-label', asleep.length ? '已记录睡眠 ' + duration(sleepTime) : '暂无已分类睡眠');
  function mark(tag, attrs, parent = svg) {
    const element = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
    parent.append(element); return element;
  }
  svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height); svg.setAttribute('preserveAspectRatio', 'none'); svg.style.height = height + 'px';
  labels.style.gridTemplateRows = 'repeat(' + lanes.length + ',' + row + 'px)';
  for (const k of lanes) labels.append(node('span', '', stageNames[k]));
  for (const t of [0, total]) axis.append(node('span', '', fmt(t)));
  for (let i = 0; i < D.length; i++) {
    const [s, e, k] = D[i], prev = D[i - 1];
    if (k === 'unknown') mark('rect', { x: x(s), y: 0, width: x(e) - x(s), height, fill: 'var(--ui-muted)', 'fill-opacity': .1 });
    else {
      if (prev && prev[2] !== 'unknown') mark('line', { x1: x(s), x2: x(s), y1: y(prev[2]), y2: y(k), stroke: paint(k), 'stroke-opacity': .14, 'stroke-width': 1.2 });
      const rect = mark('rect', { x: x(s), y: y(k) - 7, width: Math.max(.8, x(e) - x(s)), height: 14, rx: 3, fill: paint(k) });
      mark('title', {}, rect).textContent = fmt(s, true) + '–' + fmt(e, true) + ' ' + stageNames[k];
    }
    accessible.append(node('li', '', fmt(s, true) + '–' + fmt(e, true) + ' ' + stageNames[k] + '，' + duration(e - s)));
  }
  const marker = mark('line', { x1: 0, x2: 0, y1: 0, y2: height, stroke: 'var(--ui-text)', 'stroke-opacity': .45, 'stroke-width': 1, visibility: 'hidden' });
  slider.max = String(Math.max(0, Math.ceil(total / 1000) - 1));
  const storageKey = options.key ? 'zigent:interactive:sleep-timeline:' + options.key : undefined;
  function show() {
    if (Number(slider.value) < 0) {
      selection.removeAttribute('data-active'); marker.setAttribute('visibility', 'hidden'); slider.setAttribute('aria-valuetext', '未选择时刻'); return;
    }
    const t = Number(slider.value) * 1000, d = D.find(d => t >= d[0] && t < d[1]) || D[0], k = d[2];
    selection.textContent = fmt(d[0]) + '–' + fmt(d[1]) + ' · ' + stageNames[k] + ' · ' + briefDuration(d[1] - d[0]);
    selection.setAttribute('aria-label', fmt(d[0], true) + '至' + fmt(d[1], true) + '，' + stageNames[k] + '，' + duration(d[1] - d[0]));
    selection.title = selection.getAttribute('aria-label'); selection.setAttribute('data-active', '');
    slider.setAttribute('aria-valuetext', fmt(t, true) + ' ' + stageNames[k]);
    marker.setAttribute('x1', x(t)); marker.setAttribute('x2', x(t)); marker.setAttribute('visibility', 'visible');
  }
  function update() {
    show();
    if (storageKey) try { sessionStorage.setItem(storageKey, slider.value); } catch { /* Optional tab-local state. */ }
  }
  if (storageKey) try {
    const value = sessionStorage.getItem(storageKey), parsed = value === null ? -1 : Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= -1 && parsed <= Number(slider.max)) slider.value = String(parsed);
  } catch { /* Optional tab-local state. */ }
  show();
  slider.addEventListener('input', update);
  slider.addEventListener('focus', () => { if (Number(slider.value) < 0) slider.value = '0'; update(); });
  slider.addEventListener('keydown', event => { if (event.key === 'Escape') { slider.value = '-1'; update(); } });
  function point(event) {
    const rect = svg.getBoundingClientRect(); if (!rect.width) return;
    slider.value = String(Math.min(Number(slider.max), Math.max(0, Math.floor((event.clientX - rect.left) / rect.width * total / 1000)))); update();
  }
  let drag;
  svg.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    if (event.pointerType !== 'touch') svg.setPointerCapture(event.pointerId);
    point(event);
  });
  svg.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId) return;
    if (!svg.hasPointerCapture(event.pointerId)) {
      if (Math.abs(event.clientY - drag.y) > Math.abs(event.clientX - drag.x)) { drag = undefined; return; }
      if (Math.abs(event.clientX - drag.x) < 5) return;
      svg.setPointerCapture(event.pointerId);
    }
    point(event);
  });
  function finish(event) {
    if (drag?.id === event.pointerId) drag = undefined;
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
  }
  svg.addEventListener('pointerup', finish); svg.addEventListener('pointercancel', finish);
  svg.addEventListener('lostpointercapture', () => { drag = undefined; });
  return root;
}
