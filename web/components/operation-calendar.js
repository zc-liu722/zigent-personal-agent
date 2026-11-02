import { el } from '../dom.js';
import { scheduleLink } from './schedule-link.js';

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const DAY_MS = 86400000;
const clean = value => typeof value === 'string' ? value : '';
const pad = value => String(value).padStart(2, '0');

function calendarDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const stamp = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(stamp.getTime()) && stamp.toISOString().slice(0, 10) === value ? stamp : undefined;
}
function dayKey(date) { return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`; }
function addDays(date, count) { return new Date(date.getTime() + count * DAY_MS); }
function dateLabel(value) {
  const date = calendarDay(value);
  return date ? `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日` : value;
}
function boundary(value, fallbackZone) {
  if (!value || typeof value !== 'object') return undefined;
  if (calendarDay(clean(value.date))) return { date: value.date, allDay: true };
  const raw = clean(value.dateTime), match = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/);
  if (!match || !calendarDay(match[1]) || Number(match[2].slice(0, 2)) > 23 || Number(match[2].slice(3)) > 59) return undefined;
  const zone = clean(value.timeZone) || fallbackZone;
  // Never let the viewer's local timezone reinterpret a saved event.
  if (zone && match[3]) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(raw));
      const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
      return { date: `${fields.year}-${fields.month}-${fields.day}`, time: `${fields.hour}:${fields.minute}`, zone, raw, allDay: false };
    } catch { /* An unsupported timezone still has an unambiguous source offset. */ }
  }
  return { date: match[1], time: match[2], zone: match[3] === 'Z' ? 'UTC' : match[3] ? `UTC${match[3]}` : zone, raw, allDay: false };
}
function eventRange(state) {
  const start = boundary(state.start, clean(state.end?.timeZone)), end = boundary(state.end, clean(state.start?.timeZone));
  if (!start) return undefined;
  let endOnStartClock = end;
  if (end?.raw && start.raw && /(?:Z|[+-]\d{2}:\d{2})$/.test(end.raw) && /(?:Z|[+-]\d{2}:\d{2})$/.test(start.raw)) {
    const sameZone = boundary({ dateTime: end.raw, timeZone: start.zone });
    if (sameZone?.zone === start.zone) endOnStartClock = sameZone;
    else {
      const offset = start.raw.match(/(Z|([+-])(\d{2}):(\d{2}))$/);
      const offsetMinutes = offset[1] === 'Z' ? 0 : (offset[2] === '+' ? 1 : -1) * (Number(offset[3]) * 60 + Number(offset[4]));
      const shifted = new Date(new Date(end.raw).getTime() + offsetMinutes * 60000);
      if (Number.isFinite(shifted.getTime())) endOnStartClock = { ...end, date: dayKey(shifted), time: `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`, zone: start.zone };
    }
  }
  let last = endOnStartClock?.date || start.date;
  if (endOnStartClock && (start.allDay && endOnStartClock.allDay || !endOnStartClock.allDay && endOnStartClock.time === '00:00') && last > start.date) last = dayKey(addDays(calendarDay(last), -1));
  if (last < start.date) last = start.date;
  return { start, end, endOnStartClock, last };
}
function timeText(range) {
  const { start, end, last } = range;
  if (start.allDay) return last !== start.date ? `全天 · 至 ${dateLabel(last)}` : '全天';
  const first = start.time;
  if (!end) return first;
  if (end.date !== start.date) return `${first} — ${dateLabel(end.date)} ${end.time || '全天'}`;
  return `${first} — ${end.time || '全天'}`;
}
/** Local visual projection only; confirmation remains in the conversation operation area. */
export function renderCalendarPreview(presentation) {
  if (presentation?.kind !== 'calendar') return undefined;
  const before = presentation.before, after = presentation.after, initial = after || before;
  if (!initial || typeof initial !== 'object') return undefined;
  const root = el('section', 'calendar-preview'), content = el('div', 'calendar-preview-content');
  root.setAttribute('aria-label', '日程预览');
  const deleting = !after || presentation.action === 'delete_event';
  const state = initial, range = eventRange(state);
  root.append(content);
  const event = el('div', `calendar-preview-event${deleting ? ' is-deleting' : ''}`), badge = el('div', 'calendar-preview-datebadge'), copy = el('div', 'calendar-preview-copy');
  if (range) {
    const date = calendarDay(range.start.date);
    badge.append(el('span', '', `${date.getUTCMonth() + 1}月`), el('strong', '', String(date.getUTCDate())), el('span', '', `周${WEEKDAYS[(date.getUTCDay() + 6) % 7]}`));
    event.append(badge);
  }
  copy.append(el('h4', 'calendar-preview-eventtitle', clean(state.title) || '日程'));
  if (range) {
    copy.append(el('p', 'calendar-preview-time', timeText(range)));
  }
  const url = scheduleLink(`${clean(state.meetingUrl)} ${clean(state.hangoutLink)} ${clean(state.location)} ${clean(state.description)}`);
  if (url) {
    const location = el('p', 'calendar-preview-location');
    const link = el('a', 'calendar-preview-link', '线上会议');
    link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', '线上会议（在新页面打开）');
    location.append(link); copy.append(location);
  } else if (clean(state.location)) copy.append(el('p', 'calendar-preview-location', state.location));
  if (state.reminderMinutes === null) copy.append(el('p', 'calendar-preview-time', '无提醒'));
  else if (Number.isInteger(state.reminderMinutes)) copy.append(el('p', 'calendar-preview-time', state.reminderMinutes === 0 ? '开始时提醒' : `提前 ${state.reminderMinutes} 分钟提醒`));
  for (const row of copy.querySelectorAll('.calendar-preview-location, .calendar-preview-time')) {
    const location = row.classList.contains('calendar-preview-location');
    if (!location && !/提醒/.test(row.textContent)) continue;
    row.classList.add('calendar-preview-meta');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', location ? 'M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 1 1 16 0ZM15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0' : 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4');
    svg.append(path); row.prepend(svg);
  }
  event.append(copy); content.append(event);
  if (clean(state.description) || Array.isArray(state.recurrence) && state.recurrence.length) {
    const details = el('details', 'calendar-preview-details'); details.append(el('summary', '', '日程详情'));
    if (clean(state.description)) details.append(el('p', 'calendar-preview-description', state.description));
    if (Array.isArray(state.recurrence) && state.recurrence.length) {
      details.append(el('span', 'calendar-preview-repeatlabel', '重复规则'), el('p', 'calendar-preview-recurrence', state.recurrence.filter(value => typeof value === 'string').join('\n')));
    }
    content.append(details);
  }
  return root;
}

/** Historical records use these exact localized field names, never arbitrary prose. */
export function inferLegacyCalendar(change) {
  if (!change || typeof change !== 'object') return undefined;
  function parse(text) {
    if (typeof text !== 'string') return undefined;
    const lines = text.split('\n'), state = {};
    let sawBoundary = false;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index], field = line.match(/^(标题|说明|地点)：(.*)$/);
      if (field) {
        const key = { 标题: 'title', 说明: 'description', 地点: 'location' }[field[1]];
        if (state[key] !== undefined) return undefined;
        state[key] = field[2]; continue;
      }
      const match = line.match(/^(开始|结束)：(日期|时间)：(.+)$/);
      if (!match) continue;
      const key = match[1] === '开始' ? 'start' : 'end';
      if (state[key]) return undefined;
      if (match[2] === '日期') {
        if (!calendarDay(match[3])) return undefined;
        state[key] = { date: match[3] };
      } else {
        const time = match[3].match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})（UTC([+-]\d{2}:\d{2})）$/);
        if (!time || !calendarDay(time[1])) return undefined;
        state[key] = { dateTime: `${time[1]}T${time[2]}:00${time[3]}` };
        const zone = lines[index + 1]?.match(/^时区：([^\s]+)$/);
        if (zone) { state[key].timeZone = zone[1]; index++; }
      }
      sawBoundary = true;
    }
    if (!sawBoundary || !state.start || typeof state.title !== 'string') return undefined;
    return state;
  }
  const before = parse(change.before), after = parse(change.after);
  // A partial historical parse must not replace an unreadable counterpart.
  if (typeof change.before === 'string' && !before || typeof change.after === 'string' && !after) return undefined;
  if (!before && !after) return undefined;
  return { kind: 'calendar', action: !after ? 'delete_event' : !before ? 'create_event' : 'update_event', ...(before ? { before } : {}), ...(after ? { after } : {}) };
}
