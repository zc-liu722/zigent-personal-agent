import { scheduleLink as safeLink } from './components/schedule-link.js';
const node = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; };
const button = (label, fn, className = '') => { const value = node('button', className, label); value.type = 'button'; value.onclick = fn; return value; };
const pad = n => String(n).padStart(2, '0');
const dayKey = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const dayDate = key => new Date(`${key}T12:00:00`);
const shiftDay = (key, count) => { const date = dayDate(key); date.setDate(date.getDate() + count); return dayKey(date); };
const localTime = value => { if (!value || value.length === 10) return ''; const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : `${dayKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`; };
const localDay = value => !value ? '' : value.length === 10 ? value : localTime(value).slice(0, 10);
const dateLabel = key => { const date = dayDate(key), today = dayKey(new Date()); const relative = key === today ? '今天 · ' : key === shiftDay(today, 1) ? '明天 · ' : key === shiftDay(today, -1) ? '昨天 · ' : ''; return `${relative}${date.getMonth() + 1}月${date.getDate()}日 · 周${'日一二三四五六'[date.getDay()]}`; };
const sameZone = zone => !zone || zone === Intl.DateTimeFormat().resolvedOptions().timeZone;


export function createSchedule({ root, api, day = '' }) {
  let items = [], filter = 'event', editing, selectedDay = day, calendarDay = day || dayKey(new Date()), monthOpen = true, undo;
  const status = node('div', 'schedule-status'); status.setAttribute('role', 'status');
  const notify = (message, action) => { status.replaceChildren(document.createTextNode(message)); if (action) status.append(button('撤销', action, 'schedule-undo')); };
  async function load() { try { ({ items } = await api('schedule')); render(); } catch (error) { notify(error.message); if (!root.contains(status)) root.replaceChildren(status, button('重试', () => void load(), 'schedule-retry')); } }
  async function save(value, onSuccess) {
    status.replaceChildren();
    try { await api('schedule', 'POST', value); editing = undefined; await load(); onSuccess?.(); }
    catch (error) { if (!editing) render(); notify(error.message); }
  }
  function changeComplete(item, completed) {
    void save({ action: 'update', id: item.id, revision: item.revision, item: { completed } }, () => {
      undo = { id: item.id, completed: item.completed };
      notify(completed ? '已完成' : '已重新打开', () => { const current = items.find(value => value.id === undo?.id); if (current) changeComplete(current, undo.completed); });
    });
  }
  function actions(item) {
    const menu = node('details', 'schedule-menu'), summary = node('summary', '', '⋯'); summary.setAttribute('aria-label', `${item.title}的操作`); menu.append(summary);
    const popup = node('div', 'schedule-menu-popup');
    const edit = button('编辑', () => { editing = item; render(); }, 'schedule-menu-item'); edit.disabled = Boolean(item.recurrence);
    popup.append(edit, button('删除', () => { menu.open = false; if (window.confirm(`删除“${item.title}”？`)) void save({ action: 'delete', id: item.id, revision: item.revision }); }, 'schedule-menu-item schedule-delete')); menu.append(popup); return menu;
  }
  function renderCalendar(container) {
    const calendar = node('section', 'schedule-calendar'), bar = node('div', 'schedule-monthbar');
    const anchor = dayDate(calendarDay);
    const title = button(`${anchor.getFullYear()}年${anchor.getMonth() + 1}月 ${monthOpen ? '⌃' : '⌄'}`, () => { monthOpen = !monthOpen; render(); }, 'schedule-month-title'); title.setAttribute('aria-expanded', String(monthOpen));
    const nav = node('div', 'schedule-calendar-nav');
    for (const [delta, label, mark] of [[-1, '上一段', '‹'], [1, '下一段', '›']]) { const control = button(mark, () => { if (monthOpen) { const d = dayDate(calendarDay); d.setDate(1); d.setMonth(d.getMonth() + delta); calendarDay = dayKey(d); } else calendarDay = shiftDay(calendarDay, delta * 7); selectedDay = ''; render(); }, 'schedule-calendar-arrow'); control.setAttribute('aria-label', monthOpen ? (delta < 0 ? '上个月' : '下个月') : (delta < 0 ? '上一周' : '下一周')); nav.append(control); }
    bar.append(title, nav); calendar.append(bar);
    const grid = node('div', 'schedule-calendar-grid');
    for (const day of '一二三四五六日') grid.append(node('span', 'schedule-weekday', day));
    const first = monthOpen ? dayKey(new Date(anchor.getFullYear(), anchor.getMonth(), 1, 12)) : calendarDay;
    const start = shiftDay(first, -((dayDate(first).getDay() + 6) % 7));
    const count = monthOpen ? Math.ceil((((new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)).getDate()) + (dayDate(first).getDay() + 6) % 7) / 7) * 7 : 7;
    for (let i = 0; i < count; i++) {
      const key = shiftDay(start, i), day = dayDate(key), hasEvent = items.some(item => item.kind === 'event' && eventCovers(item, key));
      const cell = button(String(day.getDate()), () => { selectedDay = key; calendarDay = key; render(); root.querySelector(`[data-day="${key}"]`)?.focus({ preventScroll: true }); }, `schedule-day${key === selectedDay ? ' is-selected' : ''}${key === dayKey(new Date()) ? ' is-today' : ''}${day.getMonth() !== anchor.getMonth() ? ' is-outside' : ''}${hasEvent ? ' has-event' : ''}`);
      cell.dataset.day = key;
      cell.setAttribute('aria-label', `${dateLabel(key)}${hasEvent ? '，有日程' : ''}`); cell.setAttribute('aria-pressed', String(key === selectedDay)); grid.append(cell);
    }
    calendar.append(grid);
    if (selectedDay) calendar.append(button('查看全部日程', () => { selectedDay = ''; render(); }, 'schedule-show-all'));
    container.append(calendar);
  }
  function eventCovers(item, key) {
    const start = localDay(item.start), rawEnd = localDay(item.end); if (!start) return false;
    let end = rawEnd || start;
    if (item.end?.length === 10 && end > start) end = shiftDay(end, -1);
    else if (item.end && localTime(item.end).endsWith('T00:00') && end > start) end = shiftDay(end, -1);
    return key >= start && key <= end;
  }
  function timeLabel(item) {
    if (!item.start) return '未设置时间';
    if (item.start.length === 10) { const last = item.end?.length === 10 && item.end > item.start ? shiftDay(item.end, -1) : item.start; return last !== item.start ? `全天 · 至${dateLabel(last)}` : '全天'; }
    const start = localTime(item.start), end = localTime(item.end);
    return `${start.slice(11)}${end ? ` – ${end.slice(0, 10) !== start.slice(0, 10) ? `${dateLabel(end.slice(0, 10))} ` : ''}${end.slice(11)}` : ''}`;
  }
  function renderEvent(item) {
    const card = node('article', 'schedule-event'), top = node('div', 'schedule-event-top');
    top.append(node('span', 'schedule-event-time', timeLabel(item)), actions(item)); card.append(top, node('h3', 'schedule-event-title', item.title));
    if (item.location) card.append(node('p', 'schedule-event-location', item.location));
    const meta = node('div', 'schedule-event-meta');
    if (Number.isInteger(item.reminderMinutes)) meta.append(node('span', '', item.reminderMinutes ? `◷ 提前${item.reminderMinutes}分钟` : '◷ 开始时提醒'));
    if (!sameZone(item.timezone)) meta.append(node('span', '', `时间：${Intl.DateTimeFormat().resolvedOptions().timeZone}`));
    const link = safeLink(`${item.location || ''} ${item.description || ''}`);
    if (link) { const join = node('a', 'schedule-join', '链接'); join.href = link; join.target = '_blank'; join.rel = 'noopener noreferrer'; meta.append(join); }
    if (meta.childNodes.length) card.append(meta);
    if (item.description || item.recurrence) { const details = node('details', 'schedule-details'); details.append(node('summary', '', '详情')); if (item.description) details.append(node('p', '', item.description)); if (item.recurrence) details.append(node('p', '', Array.isArray(item.recurrence) ? item.recurrence.join('\n') : String(item.recurrence))); card.append(details); }
    return card;
  }
  function renderTodo(item) {
    const row = node('article', `schedule-todo${item.completed ? ' is-complete' : ''}`), check = node('input', 'schedule-check'); check.type = 'checkbox'; check.checked = Boolean(item.completed); check.disabled = Boolean(item.recurrence); check.setAttribute('aria-label', `${item.completed ? '重新打开' : '完成'} ${item.title}`); check.onchange = () => { check.disabled = true; void changeComplete(item, check.checked); };
    const copy = node('div', 'schedule-todo-copy'); copy.append(node('h3', 'schedule-todo-title', item.title));
    const metadata = []; if (item.due) metadata.push(dateLabel(localDay(item.due)) + (item.due.length > 10 ? ` ${localTime(item.due).slice(11)}` : '')); if (Array.isArray(item.labels)) metadata.push(...item.labels.map(label => `#${label}`)); if (item.priority > 1) metadata.push(`P${5 - item.priority}`);
    if (metadata.length) copy.append(node('p', 'schedule-todo-meta', metadata.join(' · ')));
    if (item.description || item.recurrence) { const details = node('details', 'schedule-details'); details.append(node('summary', '', '详情')); if (item.description) details.append(node('p', '', item.description)); if (item.recurrence) details.append(node('p', '', Array.isArray(item.recurrence) ? item.recurrence.join('\n') : String(item.recurrence))); copy.append(details); }
    row.append(check, copy, actions(item)); return row;
  }
  function renderList(container) {
    const list = node('div', 'schedule-list');
    const visible = items.filter(item => item.kind === filter).sort((a, b) => (a.due || a.start || '9999').localeCompare(b.due || b.start || '9999'));
    if (filter === 'event') {
      const events = selectedDay ? visible.filter(item => eventCovers(item, selectedDay)) : visible;
      if (selectedDay) list.append(node('h3', 'schedule-group-title', dateLabel(selectedDay)));
      if (!events.length) list.append(node('p', 'schedule-empty', selectedDay ? '这天暂无日程' : '暂无日程'));
      let previous;
      for (const item of events) { const key = localDay(item.start); if (!selectedDay && key !== previous) { list.append(node('h3', 'schedule-group-title', key ? dateLabel(key) : '未设日期')); previous = key; } list.append(renderEvent(item)); }
    } else {
      const today = dayKey(new Date()), groups = new Map([['已逾期', []], ['今天', []], ['接下来', []], ['未设日期', []], ['已完成', []]]);
      for (const item of visible) { const due = localDay(item.due), group = item.completed ? '已完成' : !due ? '未设日期' : due < today ? '已逾期' : due === today ? '今天' : '接下来'; groups.get(group).push(item); }
      if (!visible.length) list.append(node('p', 'schedule-empty', '暂无待办'));
      for (const [name, group] of groups) { if (!group.length) continue; if (name === '已完成') { const completed = node('details', 'schedule-completed'); completed.append(node('summary', 'schedule-group-title', `${name} · ${group.length}`)); group.forEach(item => completed.append(renderTodo(item))); list.append(completed); } else { list.append(node('h3', 'schedule-group-title', `${name} · ${group.length}`)); group.forEach(item => list.append(renderTodo(item))); } }
    }
    container.append(list);
  }
  function renderForm() {
    const form = node('form', 'schedule-form'), header = node('div', 'schedule-form-header');
    header.append(button('取消', () => { editing = undefined; render(); }, 'schedule-form-cancel'), node('h3', '', `${editing.id ? '编辑' : '新建'}${filter === 'todo' ? '待办' : '日程'}`), Object.assign(node('button', 'schedule-form-save', '保存'), { type: 'submit' })); form.append(header);
    const fields = node('div', 'schedule-fields'); form.append(fields);
    const field = (label, name, type, value = '') => { const wrap = node('label', 'schedule-field'); wrap.append(node('span', '', label)); const input = node(type === 'textarea' ? 'textarea' : 'input'); if (type !== 'textarea') input.type = type; input.name = name; input.value = value ?? ''; wrap.append(input); fields.append(wrap); return input; };
    const title = field('标题', 'title', 'text', editing.title); title.required = true; title.maxLength = 500; title.placeholder = '添加标题';
    let allDay, startDate, endDate, startTime, endTime, dueDate, dueTime, reminder;
    if (filter === 'event') {
      const allWrap = node('label', 'schedule-all-day'); allWrap.append(node('span', '', '全天')); allDay = node('input'); allDay.type = 'checkbox'; allDay.checked = editing.start?.length === 10; allWrap.append(allDay); fields.append(allWrap);
      const dateFields = node('div', 'schedule-date-fields'); fields.append(dateFields);
      startDate = field('开始日期', 'startDate', 'date', editing.start?.length === 10 ? editing.start : localDay(editing.start)); dateFields.append(startDate.parentElement);
      endDate = field('结束日期', 'endDate', 'date', editing.end?.length === 10 ? shiftDay(editing.end, -1) : localDay(editing.end)); dateFields.append(endDate.parentElement);
      startTime = field('开始时间', 'startTime', 'datetime-local', localTime(editing.start)); endTime = field('结束时间', 'endTime', 'datetime-local', localTime(editing.end));
      field('地点', 'location', 'text', editing.location);
      reminder = field('提前提醒（分钟）', 'reminderMinutes', 'number', editing.reminderMinutes ?? ''); reminder.min = '0'; reminder.max = '10080'; reminder.step = '1'; reminder.placeholder = '不提醒';
      const syncAllDay = () => { dateFields.hidden = !allDay.checked; startTime.parentElement.hidden = allDay.checked; endTime.parentElement.hidden = allDay.checked; reminder.parentElement.hidden = allDay.checked; }; allDay.onchange = syncAllDay; syncAllDay();
    } else { dueDate = field('截止日期', 'due', 'date', localDay(editing.due)); dueTime = field('截止时间', 'dueTime', 'time', localTime(editing.due).slice(11)); }
    const extra = node('details', 'schedule-extra'); extra.append(node('summary', '', '说明')); fields.append(extra); const description = field('说明', 'description', 'textarea', editing.description); extra.append(description.parentElement); if (editing.description) extra.open = true;
    form.onsubmit = event => {
      event.preventDefault(); const at = (input, original) => input.value ? (localTime(original) === input.value ? original : new Date(input.value).toISOString()) : null;
      if (filter === 'todo' && dueTime.value && !dueDate.value) { dueDate.setCustomValidity('请先选择截止日期'); dueDate.reportValidity(); dueDate.setCustomValidity(''); return; }
      const dueValue = filter === 'todo' && dueDate.value && dueTime.value ? `${dueDate.value}T${dueTime.value}` : '';
      const due = dueValue ? (localTime(editing.due) === dueValue ? editing.due : new Date(dueValue).toISOString()) : dueDate?.value || null;
      const item = { title: title.value, description: description.value, ...(filter === 'todo' ? { due } : { start: allDay.checked ? startDate.value || null : at(startTime, editing.start), end: allDay.checked ? (endDate.value ? shiftDay(endDate.value, 1) : null) : at(endTime, editing.end), location: form.elements.location.value, reminderMinutes: allDay.checked || reminder.value === '' ? null : Number(reminder.value) }), timezone: editing.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone };
      void save(editing.id ? { action: 'update', id: editing.id, revision: editing.revision, item } : { action: 'create', item: { kind: filter, ...item } });
    };
    return form;
  }
  function render() {
    root.replaceChildren();
    if (editing) { root.append(renderForm(), status); return; }
    const bar = node('div', 'schedule-bar'), tabs = node('div', 'schedule-tabs'); tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', '事项类型');
    for (const [key, label] of [['event', '日程'], ['todo', '待办']]) {
      const tab = button('', () => { filter = key; render(); root.querySelector('.schedule-tab[aria-pressed="true"]')?.focus({ preventScroll: true }); }, 'schedule-tab');
      const icon = node('span', `schedule-tab-icon schedule-tab-icon-${key}`); icon.setAttribute('aria-hidden', 'true');
      tab.append(icon, node('span', '', label)); tab.setAttribute('aria-pressed', String(filter === key)); tabs.append(tab);
    }
    bar.append(tabs, button('＋ 新建', () => { editing = { kind: filter }; render(); }, 'schedule-add')); root.append(bar);
    const body = node('div', 'schedule-body'); if (filter === 'event') renderCalendar(body); renderList(body); root.append(body, status);
  }
  return { open: load };
}
