import { el } from '../dom.js';

const asText = value => typeof value === 'string' ? value : '';
const labels = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];

function icon(name) {
  const paths = {
    date: ['M7 3v4M17 3v4M4 10h16', 'M5 5h14a1 1 0 0 1 1 1v14H4V6a1 1 0 0 1 1-1Z'],
    repeat: ['m16 3 4 4-4 4M20 7H8a4 4 0 0 0-4 4', 'm8 21-4-4 4-4M4 17h12a4 4 0 0 0 4-4'],
    check: ['m5 12 4 4L19 6'],
    cross: ['m7 7 10 10M17 7 7 17'],
    flag: ['M5 21V3', 'M5 4c5-3 9 3 14 0v10c-5 3-9-3-14 0Z']
  };
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 24 24'); node.setAttribute('aria-hidden', 'true');
  for (const d of paths[name] || []) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); node.append(path);
  }
  return node;
}

// Keep provider calendar dates and explicit clock offsets; never reinterpret a
// floating deadline in the viewing device's timezone.
function dateParts(due) {
  const value = asText(due?.dateTime) || asText(due?.date);
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(value);
  if (!match) return { full: asText(due?.label) || value };
  const [, year, month, day, time, offset] = match;
  return { year, month: Number(month), day: Number(day),
    full: `${year}/${month}/${day}${time ? ` · ${time}${offset ? ` UTC${offset === 'Z' ? '+00:00' : offset}` : ''}` : ''}` };
}

function dueLabel(due) {
  if (!due || typeof due !== 'object') return '无截止日期';
  const date = dateParts(due).full;
  const label = asText(due.label).trim();
  const normalized = value => value.replace(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/, (_, year, month, day) => `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
  const sameDate = label && normalized(label) === normalized(asText(due.date));
  return [...new Set([date, sameDate ? '' : label].filter(Boolean)), ...(due.recurring ? ['重复'] : [])].join(' · ') || '无截止日期';
}

function taskBody(state, { previous = false, deleted = false } = {}) {
  const validPriority = Number.isInteger(state.priority) && state.priority >= 1 && state.priority <= 4;
  const priority = validPriority ? state.priority : 1;
  const body = el('div', `todo-preview-task${previous ? ' todo-preview-previous' : ''}${state.completed ? ' is-complete' : ''}${deleted ? ' is-deleted' : ''}`);
  body.dataset.priority = String(priority);
  const main = el('div', 'todo-preview-main'), mark = el('span', 'todo-preview-mark');
  mark.setAttribute('role', 'img'); mark.setAttribute('aria-label', deleted ? '将删除' : state.completed ? '已完成' : '未完成');
  if (deleted || state.completed) mark.append(icon(deleted ? 'cross' : 'check'));
  const copy = el('div', 'todo-preview-copy');
  copy.append(el('h4', 'todo-preview-title', asText(state.title) || '待办'));
  const description = asText(state.description);
  if (description) {
    if (description.length > 160 || description.split('\n').length > 3) {
      const details = el('details', 'todo-preview-description-details');
      details.append(el('summary', '', '任务描述'), el('p', 'todo-preview-description', description)); copy.append(details);
    } else copy.append(el('p', 'todo-preview-description', description));
  }
  main.append(mark, copy);
  body.append(main);
  const metadata = el('div', 'todo-preview-metadata');
  if (state.due && dueLabel(state.due) !== '无截止日期') {
    const due = el('span', 'todo-preview-due'); due.append(icon(state.due.recurring ? 'repeat' : 'date'), el('span', '', dueLabel(state.due))); metadata.append(due);
  }
  if (validPriority) {
    const badge = el('span', 'todo-preview-priority'); badge.append(icon('flag'), el('span', '', `P${5 - priority}`)); badge.setAttribute('aria-label', `优先级 P${5 - priority}`); metadata.append(badge);
  }
  for (const label of labels(state.labels)) metadata.append(el('span', 'todo-preview-label', `#${label}`));
  if (metadata.childNodes.length) body.append(metadata);
  return body;
}

// Old saved confirmations contain the allowlisted human-readable projection.
// Upgrade only its explicit fields; unstructured prose keeps the text renderer.
function legacyState(value) {
  if (typeof value !== 'string') return undefined;
  const entries = [], keyPattern = /^(内容|说明|截止安排|优先级（4=P1，1=P4）|标签|已完成|项目|分区|父待办)：(.*)$/;
  for (const line of value.split('\n')) {
    const field = keyPattern.exec(line);
    if (field) entries.push({ key: field[1], value: field[2] });
    else if (entries.length) entries[entries.length - 1].value += `\n${line}`;
    else if (line.trim()) return undefined;
  }
  const fields = Object.fromEntries(entries.map(({ key, value: text }) => [key, text]));
  if (!fields['内容']?.trim()) return undefined;
  const state = { title: fields['内容'] };
  if (fields['说明'] !== undefined && fields['说明'] !== '（清空）') state.description = fields['说明'];
  const priority = fields['优先级（4=P1，1=P4）'];
  if (/^[1-4]$/.test(priority)) state.priority = Number(priority);
  if (['是', '否'].includes(fields['已完成'])) state.completed = fields['已完成'] === '是';
  if (fields['标签'] && fields['标签'] !== '（空列表）') {
    const values = fields['标签'].split('\n');
    if (values.every(line => /^\d+\. .+$/.test(line))) state.labels = values.map(line => line.replace(/^\d+\. /, ''));
  }
  const due = fields['截止安排'];
  if (due && due !== '（清空）') {
    const date = /(?:^|\n)(?:截止日期|日期)：(\d{4}-\d{2}-\d{2})(?=\n|$)/.exec(due)?.[1];
    const rawTime = /(?:^|\n)(?:截止时间|时间)：([^\n]+)/.exec(due)?.[1];
    const readableTime = rawTime && /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})（UTC([+-]\d{2}:\d{2})）$/.exec(rawTime);
    const dateTime = readableTime ? `${readableTime[1]}T${readableTime[2]}${readableTime[3]}`
      : rawTime && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(rawTime) ? rawTime : undefined;
    const label = /(?:^|\n)(?:截止或重复规则|string)：([^\n]+)/.exec(due)?.[1];
    const recurring = /(?:^|\n)(?:is_recurring|重复)：是(?=\n|$)/.test(due);
    if (date || dateTime || label) state.due = { ...(date ? { date } : {}), ...(dateTime ? { dateTime } : {}), ...(label ? { label } : {}), ...(recurring ? { recurring } : {}) };
  }
  return state;
}

export function inferLegacyTodo(change) {
  if (change?.presentation) return undefined;
  const before = legacyState(change?.before), after = legacyState(change?.after);
  if (!before && !after) return undefined;
  // A present but unrecognized side must remain available in the normal diff.
  if (typeof change.before === 'string' && !before || typeof change.after === 'string' && !after) return undefined;
  const title = asText(change.title);
  const action = ['删除待办', '完成待办', '重开待办', '新建待办', '修改待办'].find(label => title === label);
  return { kind: 'todo', action: ({ 删除待办: 'delete_task', 完成待办: 'complete_task', 重开待办: 'reopen_task', 新建待办: 'create_task', 修改待办: 'update_task' })[action]
    || (before && after ? 'update_task' : after ? 'create_task' : 'delete_task'), ...(before ? { before } : {}), ...(after ? { after } : {}) };
}

export function renderTodoPreview(presentation) {
  if (presentation?.kind !== 'todo') return undefined;
  const before = presentation.before, after = presentation.after, state = after || before;
  if (!state || typeof state.title !== 'string') return undefined;
  const deleted = !after || presentation.action === 'delete_task';
  const node = el('section', 'todo-preview'); node.setAttribute('aria-label', '待办预览');
  node.append(taskBody(state, { deleted }));
  return node;
}
