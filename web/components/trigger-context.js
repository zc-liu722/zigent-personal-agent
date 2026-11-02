(() => {
  'use strict';
  const node = (tag, className, text) => { const item = document.createElement(tag); item.className = className; if (text !== undefined) item.textContent = text; return item; };
  const svg = (tag, attributes = {}, text) => { const item = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, value); if (text !== undefined) item.textContent = text; return item; };
  const button = (text, action, label) => { const item = node('button', 'trigger-context-button', text); item.type = 'button'; item.onclick = action; if (label) item.setAttribute('aria-label', label); return item; };
  let api, discuss, capabilities = {};
  const observed = new Map(), active = new Set(), drawings = new Map();
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { const load = observed.get(entry.target); observed.delete(entry.target); observer.unobserve(entry.target); load?.(); }
  });
  // Parameter edits replace their previews. Cancel obsolete reads and release observers.
  new MutationObserver(() => {
    for (const [element] of observed) if (!element.isConnected) { observed.delete(element); observer.unobserve(element); }
    for (const state of active) if (!state.host.isConnected) { state.controller.abort(); active.delete(state); }
    for (const [element, cleanup] of drawings) if (!element.isConnected) { cleanup(); drawings.delete(element); }
  }).observe(document.documentElement, { childList: true, subtree: true });

  async function request(host, input) {
    const controller = new AbortController(), state = { host, controller }; active.add(state);
    const timeout = setTimeout(() => controller.abort(), 29000);
    try { return await api('proactive-tasks/visual-context', 'POST', input, controller.signal); }
    finally { clearTimeout(timeout); active.delete(state); }
  }
  function failure(host, message, retry) {
    host.replaceChildren(node('span', 'trigger-context-status', message), button('重试', retry));
  }
  function mapDrawing(data, visual, viewport) {
    const drawing = svg('svg', { viewBox: `0 0 ${data.width} ${data.height}`, class: 'trigger-map-svg', role: 'img', 'aria-label': `${visual.place || '所选地点'}周边地图，围栏半径 ${data.radiusMeters} 米` });
    for (const path of data.paths) drawing.append(svg('path', { d: path.d, class: `trigger-map-${path.kind}` }));
    data.labels.forEach((label, index) => drawing.append(svg('text', { x: label.x, y: label.y, class: 'trigger-map-roadname', 'data-label-index': index }, label.text)));
    const cx = data.width / 2, cy = data.height / 2, radius = data.radius;
    drawing.append(svg('circle', { cx, cy, r: radius, class: 'trigger-map-boundary' }), svg('path', { d: `M${cx} ${cy}h${radius}`, class: 'trigger-map-radius' }));
    const leave = visual.event === 'leave', start = leave ? cx - radius * .25 : cx - radius * 1.5, end = leave ? cx - radius * 1.5 : cx - radius * .7;
    const direction = svg('path', { class: 'trigger-map-direction' });
    drawing.append(direction,
      svg('circle', { cx, cy, r: 13, class: 'trigger-map-pin-halo' }), svg('circle', { cx, cy, r: 5, class: 'trigger-map-pin' }));
    const scale = svg('g', { class: 'trigger-map-scale' });
    scale.append(svg('path', { d: `M30 ${data.height - 40}v8h${data.scale.pixels}v-8` }),
      svg('text', { x: 30 + data.scale.pixels / 2, y: data.height - 48, 'text-anchor': 'middle' }, data.scale.meters >= 1000 ? `${data.scale.meters / 1000} 千米` : `${data.scale.meters} 米`));
    drawing.append(scale);
    let view = { x: 0, y: 0, width: data.width, height: data.height }, drag;
    const update = () => {
      drawing.setAttribute('viewBox', `${view.x} ${view.y} ${view.width} ${view.height}`);
      const unit = view.width / Math.max(200, drawing.getBoundingClientRect().width);
      const wing = (leave ? 7 : -7) * unit;
      direction.setAttribute('d', `M${start} ${cy}H${end} m${wing} ${-5 * unit}l${-wing} ${5 * unit} ${wing} ${5 * unit}`);
      for (const label of drawing.querySelectorAll('text')) { label.setAttribute('font-size', 11 * unit); if (label.hasAttribute('data-label-index')) label.style.display = drawing.clientWidth < 400 && Number(label.dataset.labelIndex) > 2 ? 'none' : ''; }
      drawing.querySelector('.trigger-map-pin').setAttribute('r', 4 * unit);
      drawing.querySelector('.trigger-map-pin-halo').setAttribute('r', 9 * unit);
    };
    const resize = new ResizeObserver(update); resize.observe(drawing);
    const cleanup = () => resize.disconnect();
    const zoom = factor => {
      const width = Math.max(data.width / 5, Math.min(data.width, view.width / factor)), height = width * data.height / data.width;
      view.x = Math.max(0, Math.min(data.width - width, view.x + (view.width - width) / 2));
      view.y = Math.max(0, Math.min(data.height - height, view.y + (view.height - height) / 2));
      view.width = width; view.height = height; update();
    };
    if (viewport) {
      drawing.onpointerdown = event => { if (event.button !== 0 || view.width === data.width) return; drag = { x: event.clientX, y: event.clientY, left: view.x, top: view.y }; drawing.setPointerCapture(event.pointerId); };
      drawing.onpointermove = event => { if (!drag) return; const bounds = drawing.getBoundingClientRect();
        view.x = Math.max(0, Math.min(data.width - view.width, drag.left - (event.clientX - drag.x) / bounds.width * view.width));
        view.y = Math.max(0, Math.min(data.height - view.height, drag.top - (event.clientY - drag.y) / bounds.height * view.height)); update(); };
      drawing.onpointerup = drawing.onpointercancel = () => { drag = undefined; };
    }
    // The parent releases this observer when the drawing is removed.
    return { drawing, zoom, reset: () => { view = { x: 0, y: 0, width: data.width, height: data.height }; update(); }, cleanup };
  }
  function attribution(data) {
    const item = node('span', 'trigger-map-attribution');
    const link = (label, url) => { const anchor = node('a', '', label); anchor.href = url; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; return anchor; };
    if (data.tileAttribution) item.append(link('© OpenMapTiles', 'https://openmaptiles.org/'), ' · ');
    item.append(link('© OpenStreetMap', 'https://www.openstreetmap.org/copyright')); return item;
  }
  function expandMap(data, visual, opener) {
    const dialog = node('dialog', 'trigger-map-dialog'), heading = node('div', 'trigger-map-dialog-heading');
    const close = button('关闭', () => dialog.close()); heading.append(node('strong', '', visual.place || '所选地点'), close);
    const canvas = node('div', 'trigger-map-expanded'), map = mapDrawing(data, visual, true), tools = node('div', 'trigger-map-tools');
    canvas.append(map.drawing, attribution(data));
    tools.append(button('−', () => map.zoom(1 / 1.5), '缩小地图'), button('＋', () => map.zoom(1.5), '放大地图'), button('复位', map.reset));
    dialog.append(heading, canvas, tools); document.body.append(dialog);
    dialog.onclose = () => { map.cleanup(); dialog.remove(); if (opener.isConnected && opener.getClientRects().length) opener.focus({ preventScroll: true }); };
    dialog.showModal();
  }
  function attachMap(figure, visual, input) {
    const original = figure.querySelector('.trigger-visual-geofence'); if (!original) return;
    const host = node('div', 'trigger-context trigger-context-map'); host.setAttribute('aria-label', '地点地图');
    original.replaceWith(host);
    let current, timer;
    const load = async () => {
      clearTimeout(timer); if (!host.isConnected) return;
      current?.cleanup(); host.replaceChildren(node('span', 'trigger-context-status', '正在加载地图'));
      try {
        const result = await request(host, input); if (!host.isConnected) return;
        if (result.type !== 'location' || !result.map) throw new Error('地图暂不可用。');
        const resolved = { ...visual, ...(result.place ? { place: result.place } : {}) };
        if (result.place) figure.querySelector('.trigger-visual-title').textContent = `${visual.event === 'leave' ? '离开' : '到达'}${result.place}`;
        const data = result.map, map = mapDrawing(data, resolved, false); current = map;
        const open = button('', () => expandMap(data, resolved, open), '放大查看地图'); open.className = 'trigger-map-open'; open.append(map.drawing);
        const radius = node('span', 'trigger-map-radius-label', `半径 ${data.radiusMeters} 米`);
        host.replaceChildren(open, radius, attribution(data));
        figure.querySelector('.trigger-visual-kind').textContent = '地图';
        drawings.set(host, map.cleanup);
      } catch (error) { if (host.isConnected) failure(host, error.name === 'AbortError' ? '地图加载超时。' : error.message || '地图暂不可用。', load); }
    };
    observed.set(host, () => { timer = setTimeout(load, 450); }); observer.observe(host);
  }
  const time = (at, timezone) => new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
  function calendarView(data, visual) {
    const body = node('div', 'trigger-calendar-body'), heading = node('div', 'trigger-calendar-heading');
    heading.append(node('span', '', [data.day, data.timezone === 'Asia/Shanghai' ? '' : data.timezone].filter(Boolean).join(' · ')));
    if (visual.schedule !== 'once' || visual.date !== data.day) body.append(heading);
    if (!data.events.length) { body.append(node('span', 'trigger-context-status', data.truncated ? '部分日程未加载' : '附近暂无日程')); return body; }
    const chart = node('div', 'trigger-calendar-chart'), ticks = node('div', 'trigger-calendar-ticks'), marker = node('span', 'trigger-calendar-marker');
    const label = at => {
      const date = new Intl.DateTimeFormat('en-CA', { timeZone: data.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
      return `${date === data.day ? '' : `${date.slice(5).replace('-', '/')} `}${time(at, data.timezone)}`;
    };
    for (const at of [data.from, data.at, data.to]) ticks.append(node('span', '', label(at)));
    chart.append(ticks, marker);
    const detail = node('div', 'trigger-calendar-detail'); detail.setAttribute('role', 'status');
    const lanes = [], overflow = [], allDay = [];
    for (const event of data.events) {
      if (event.allDay) { allDay.push(event); continue; }
      let lane = lanes.find(item => item.end <= event.start);
      if (!lane) { if (lanes.length === 3) { overflow.push(event); continue; } lane = { end: data.from, element: node('div', 'trigger-calendar-lane') }; lanes.push(lane); }
      lane.end = event.end;
      const mark = button(event.title, () => { detail.textContent = `${event.title} · ${label(event.start)}–${label(event.end)}`; });
      mark.className = 'trigger-calendar-event'; mark.setAttribute('aria-label', `${event.title}，${label(event.start)}至${label(event.end)}`);
      mark.style.left = `${Math.max(0, (event.start - data.from) / (data.to - data.from) * 100)}%`;
      mark.style.width = `${(Math.min(event.end, data.to) - Math.max(event.start, data.from)) / (data.to - data.from) * 100}%`;
      lane.element.append(mark);
    }
    chart.append(...lanes.map(lane => lane.element)); body.append(chart);
    const extra = node('div', 'trigger-calendar-extra');
    for (const event of allDay.slice(0, 2)) extra.append(button(`全天 · ${event.title}`, () => { detail.textContent = `全天 · ${event.title}`; }));
    const hidden = [...allDay.slice(2), ...overflow];
    if (hidden.length) extra.append(button(`另 ${hidden.length} 项`, () => {
      const list = node('div', 'trigger-calendar-overflow');
      for (const event of hidden) list.append(node('span', '', `${event.allDay ? '全天' : `${label(event.start)}–${label(event.end)}`} · ${event.title}`));
      detail.replaceChildren(list);
    }));
    if (data.truncated) extra.append(node('span', 'trigger-context-status', '部分日程未加载'));
    body.append(extra, detail); return body;
  }
  function attachCalendar(figure, visual, input) {
    const host = node('div', 'trigger-context trigger-context-calendar'); host.hidden = true;
    const timeline = figure.querySelector('.trigger-visual-timeline'), kind = figure.querySelector('.trigger-visual-kind');
    const toggle = button('日程', () => { if (host.hidden) { host.hidden = false; timeline.hidden = true; toggle.textContent = '收起日程'; toggle.setAttribute('aria-expanded', 'true'); void load(); }
      else { host.hidden = true; timeline.hidden = false; toggle.textContent = '日程'; toggle.setAttribute('aria-expanded', 'false'); } }, '查看附近日程');
    toggle.classList.add('trigger-context-toggle'); toggle.setAttribute('aria-expanded', 'false'); kind.replaceWith(toggle); timeline.after(host);
    let loading = false;
    const load = async () => {
      if (loading) return; loading = true; host.replaceChildren(node('span', 'trigger-context-status', '正在加载日程'));
      try {
        const result = await request(host, input); if (!host.isConnected) return;
        if (result.status === 'connect') { host.replaceChildren(button('连接日历', () => discuss('连接 Google Calendar，以查看触发时刻附近的日程。'))); return; }
        if (!result.calendar) throw new Error('日程暂不可用。');
        host.replaceChildren(calendarView(result.calendar, visual));
      } catch (error) { if (host.isConnected) failure(host, error.name === 'AbortError' ? '日程加载超时。' : error.message || '日程暂不可用。', load); }
      finally { loading = false; }
    };
  }
  window.ZigentTriggerContext = {
    initialize(options) {
      ({ api, discuss } = options);
      document.getElementById('automation-dialog')?.addEventListener('close', () => {
        for (const dialog of document.querySelectorAll('.trigger-map-dialog[open]')) dialog.close();
        for (const state of active) state.controller.abort();
      });
    },
    capabilities(value) { capabilities = value || {}; },
    attach(figure, visual, input) {
      if (!input || !api) return;
      if (visual.type === 'location' && capabilities.location) attachMap(figure, visual, input);
      if (visual.type === 'time' && capabilities.calendar) attachCalendar(figure, visual, input);
    }
  };
})();
