(() => {
  'use strict';
  const node = (tag, className, text) => { const item = document.createElement(tag); item.className = className; if (text !== undefined) item.textContent = text; return item; };
  const svg = (tag, attributes = {}) => { const item = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, value); return item; };
  const duration = value => value % 3600 === 0 && value > 0 ? `${value / 3600} 小时` : value % 60 === 0 && value > 0 ? `${value / 60} 分钟` : `${value} 秒`;
  const zone = value => value === 'Asia/Shanghai' ? '' : value;
  const eventName = value => value === 'alarm_stopped' ? '闹钟停止' : value === 'charging_started' ? '开始充电' : value === 'notification_received' ? '收到通知' : value;
  const metricName = value => ({ sleep_analysis: '睡眠', heart_rate_variability: 'HRV', heart_rate: '心率' })[value] || value;
  const days = [1, 2, 3, 4, 5, 6, 0], dayNames = ['日', '一', '二', '三', '四', '五', '六'];
  function clockPosition(time) {
    if (!/^\d{2}:\d{2}$/.test(time || '')) return undefined;
    const [hour, minute] = time.split(':').map(Number);
    return hour < 24 && minute < 60 ? (hour * 60 + minute) / 1440 * 100 : undefined;
  }
  function timeline(time, window = false) {
    const item = node('div', 'trigger-visual-timeline'), track = node('div', 'trigger-visual-track');
    const position = clockPosition(time);
    if (position !== undefined) {
      const marker = node('span', `trigger-visual-marker${window ? ' window' : ''}`);
      marker.style.setProperty('--position', `${position}%`); marker.dataset.time = time;
      if (!window) { const label = node('span', 'trigger-visual-time-label', time); label.style.setProperty('--position', `${Math.min(91, Math.max(9, position))}%`); item.append(label); }
      track.append(marker);
    }
    const ticks = node('div', 'trigger-visual-ticks');
    for (const label of ['00', '06', '12', '18', '24']) ticks.append(node('span', '', label));
    item.append(track, ticks); return item;
  }
  function icon(kind) {
    const item = svg('svg', { viewBox: '0 0 32 32', 'aria-hidden': 'true' });
    const paths = { device: 'M10 3h12v26H10z M14 25h4', event: 'M16 4v3 M7 8l2 2 M25 8l-2 2 M6 23h20l-3-4v-5a7 7 0 0 0-14 0v5z M13 27h6',
      health: 'M3 17h6l4-9 6 17 4-8h6', merge: 'M3 7h5l8 9h13 M3 25h5l8-9 M24 11l5 5-5 5', action: 'M8 6l18 10L8 26z' };
    item.append(svg('path', { d: paths[kind] })); return item;
  }
  function sequence(stages) {
    const item = node('div', 'trigger-visual-sequence');
    for (const [kind, title, detail] of stages) {
      const stage = node('div', 'trigger-visual-stage'); stage.append(icon(kind), node('strong', '', title));
      if (detail) stage.append(node('span', '', detail)); item.append(stage);
    }
    return item;
  }
  function render(value, context) {
    if (!value || !['time', 'location', 'external', 'health_change'].includes(value.type)) return null;
    const item = node('figure', `trigger-visual trigger-visual-${value.type}`); item.dataset.visualType = value.type;
    const heading = node('figcaption', 'trigger-visual-heading'), identity = node('div', 'trigger-visual-identity');
    const title = node('strong', 'trigger-visual-title'), subtitle = node('span', 'trigger-visual-subtitle'); identity.append(title, subtitle);
    const label = node('span', 'trigger-visual-kind', ({ time: '时间轴', location: '范围示意', external: '设备事件', health_change: '数据窗口' })[value.type]);
    heading.append(identity, label); item.append(heading);
    const facts = node('div', 'trigger-visual-facts');
    const fact = text => facts.append(node('span', '', text));
    if (value.type === 'time') {
      const schedule = value.schedule === 'once' ? `${value.date || '选择日期'} ` : value.schedule === 'weekly'
        ? `每周${days.filter(day => (value.weekdays || []).includes(day)).map(day => dayNames[day]).join('、')}` : '每天';
      title.textContent = `${schedule}${value.time || '选择时间'}`; subtitle.textContent = zone(value.timezone) || '';
      item.append(timeline(value.time));
      fact(`补跑 ≤ ${duration(value.maxLatenessSeconds ?? 3600)}`);
      if (value.schedule !== 'once') {
        const week = node('div', 'trigger-visual-week'); week.setAttribute('aria-label', '触发日期');
        for (const day of days) {
          const active = value.schedule === 'daily' || (value.weekdays || []).includes(day), cell = node('span', active ? 'selected' : '', dayNames[day]);
          cell.setAttribute('aria-label', `周${dayNames[day]}${active ? '触发' : '不触发'}`); week.append(cell);
        }
        item.append(week);
      }
    } else if (value.type === 'location') {
      const leave = value.event === 'leave'; title.textContent = `${leave ? '离开' : '到达'}${value.place || '所选地点'}`;
      const drawing = svg('svg', { viewBox: '0 0 520 180', class: 'trigger-visual-geofence', role: 'img', 'aria-label': `${title.textContent}，${value.radiusMeters ? `半径 ${value.radiusMeters} 米，` : ''}围栏边界穿越示意` });
      const grid = svg('g', { class: 'trigger-visual-grid' });
      for (let x = 20; x < 520; x += 40) grid.append(svg('path', { d: `M${x} 0v180` }));
      for (let y = 10; y < 180; y += 40) grid.append(svg('path', { d: `M0 ${y}h520` }));
      const circle = svg('circle', { cx: 280, cy: 90, r: 66, class: 'trigger-visual-boundary' });
      const route = svg('path', { d: leave ? 'M280 90H135' : 'M110 90H250', class: 'trigger-visual-route' });
      const arrow = svg('path', { d: leave ? 'M147 81l-12 9 12 9' : 'M238 81l12 9-12 9', class: 'trigger-visual-route' });
      drawing.append(grid, circle, svg('path', { d: 'M280 90h66', class: 'trigger-visual-radius' }), route, arrow,
        svg('circle', { cx: leave ? 280 : 110, cy: 90, r: 5, class: 'trigger-visual-origin' }), svg('circle', { cx: 280, cy: 90, r: 4, class: 'trigger-visual-center' }));
      item.append(drawing);
      if (Number.isFinite(value.radiusMeters) && value.radiusMeters > 0) fact(`半径 ${value.radiusMeters} 米`);
      const min = value.minSpeedKph, max = value.maxSpeedKph;
      if (Number.isFinite(min) && Number.isFinite(max)) fact(`速度 ${min}–${max} km/h`);
      else if (Number.isFinite(min)) fact(`速度 ≥ ${min} km/h`);
      else if (Number.isFinite(max)) fact(`速度 ≤ ${max} km/h`);
    } else if (value.type === 'external') {
      title.textContent = eventName(value.event) || '选择事件';
      item.append(sequence([['device', '设备'], ['event', '收到事件'], ['action', '检查条件']]));
    } else {
      title.textContent = (value.metrics || []).map(metricName).join('、') || '健康数据';
      subtitle.textContent = [value.afterTime ? `${value.afterTime} 后收到` : '', zone(value.timezone)].filter(Boolean).join(' · ');
      if (value.afterTime) item.append(timeline(value.afterTime, true));
      const validWindow = Number.isFinite(value.debounceSeconds);
      item.append(sequence([['health', '数据更新'], ['merge', validWindow ? value.debounceSeconds > 0 ? '合并更新' : '立即处理' : '合并窗口', validWindow ? duration(value.debounceSeconds) : '选择时长'], ['action', '检查条件']]));
    }
    subtitle.hidden = !subtitle.textContent;
    if (facts.childNodes.length) item.append(facts);
    window.ZigentTriggerContext?.attach(item, value, context);
    return item;
  }
  window.ZigentTriggerVisual = { render };
})();
