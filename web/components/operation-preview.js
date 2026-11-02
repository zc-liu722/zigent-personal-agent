import { renderMindmapPreview, inferLegacyMindmap } from './operation-mindmap.js';
import { renderCalendarPreview, inferLegacyCalendar } from './operation-calendar.js';
import { renderTodoPreview, inferLegacyTodo } from './operation-todo.js';
import { renderContentPreview } from './operation-content.js';

/** Older saved cards can be upgraded using their explicit display fields only. */
export function projectOperationChange(change, item) {
  if (!change || typeof change !== 'object' || change.presentation || item.kind !== 'operation-confirmation') return change;
  const presentation = item.operationView === 'calendar' ? inferLegacyCalendar(change)
    : item.operationView === 'todo' ? inferLegacyTodo(change)
    : /XMind/.test(item.title || '') ? inferLegacyMindmap(change) : undefined;
  return presentation ? { ...change, presentation } : change;
}

export function renderOperationPreview(presentation) {
  if (presentation?.kind === 'mindmap') return renderMindmapPreview(presentation);
  if (presentation?.kind === 'calendar') return renderCalendarPreview(presentation);
  if (presentation?.kind === 'todo') return renderTodoPreview(presentation);
  return renderContentPreview(presentation);
}
