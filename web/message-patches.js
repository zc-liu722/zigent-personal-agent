/** Apply a whole batch to copies. A malformed target never leaves a partial update behind. */
export function applyMessagePatch(previous, patch) {
  if (!previous?.snapshot || previous.activityDeferred || previous.conversationId !== patch.conversationId || previous.streamEpoch !== patch.streamEpoch
    || previous.streamRevision !== patch.baseRevision || !Number.isSafeInteger(patch.streamRevision)
    || patch.streamRevision <= patch.baseRevision || !Array.isArray(patch.operations)) return;
  const snapshot = { ...previous.snapshot, items: [...previous.snapshot.items] };
  const positions = new Map(snapshot.items.map((item, index) => [item.id, index]));
  let text = previous.text, fields = {};
  for (const operation of patch.operations) {
    if (!operation || typeof operation.type !== 'string') return;
    const id = operation.item?.id ?? operation.id, index = positions.get(id);
    switch (operation.type) {
      case 'add_item':
        if (typeof id !== 'string' || index !== undefined || !validItem(operation.item)) return;
        positions.set(id, snapshot.items.length); snapshot.items.push({ ...operation.item }); break;
      case 'replace_item':
        if (index === undefined || !validItem(operation.item)) return;
        snapshot.items[index] = { ...operation.item }; break;
      case 'remove_item':
        if (index === undefined) return;
        snapshot.items.splice(index, 1); positions.delete(id);
        for (let i = index; i < snapshot.items.length; i++) positions.set(snapshot.items[i].id, i);
        break;
      case 'append_text':
        if (index === undefined || typeof operation.text !== 'string' || typeof snapshot.items[index].text !== 'string') return;
        snapshot.items[index] = { ...snapshot.items[index], text: snapshot.items[index].text + operation.text }; break;
      case 'append_answer':
        if (typeof operation.text !== 'string') return;
        snapshot.answerDraft += operation.text; text = snapshot.answerDraft; break;
      case 'set_answer':
        if (typeof operation.text !== 'string') return;
        text = snapshot.answerDraft = operation.text; break;
      case 'update_message':
        if (!operation.fields || Object.keys(operation.fields).some(key => !['text', 'assets', 'interactions', 'replyDurationMs'].includes(key))) return;
        if ('replyDurationMs' in operation.fields && (!Number.isFinite(operation.fields.replyDurationMs) || operation.fields.replyDurationMs < 0)) return;
        if ('text' in operation.fields) {
          if (typeof operation.fields.text !== 'string') return;
          text = operation.fields.text;
        }
        fields = { ...fields, ...operation.fields }; break;
      case 'run_state':
        if (!['running', 'completed', 'failed', 'cancelled'].includes(operation.status)) return;
        snapshot.status = operation.status; snapshot.failureMessage = operation.failureMessage; break;
      default: return;
    }
  }
  return { ...previous, ...fields, snapshot, text, streamEpoch: patch.streamEpoch, streamRevision: patch.streamRevision,
    busy: patch.busy, activeMessageId: patch.activeMessageId };
}

function validItem(item) {
  if (item?.type === 'subagent') return typeof item.id === 'string' && typeof item.agentId === 'string'
    && typeof item.title === 'string' && typeof item.name === 'string' && typeof item.profession === 'string'
    && typeof item.model === 'string' && typeof item.task === 'string'
    && Number.isSafeInteger(item.generation) && item.generation > 0 && Number.isFinite(item.startedAt)
    && ['running', 'completed', 'failed', 'cancelled'].includes(item.status)
    && item.snapshot && ['running', 'completed', 'failed', 'cancelled'].includes(item.snapshot.status)
    && typeof item.snapshot.answerDraft === 'string' && Array.isArray(item.snapshot.items)
    && item.snapshot.items.every(child => child?.type !== 'subagent' && validItem(child));
  return item && typeof item.id === 'string' && ['running', 'completed', 'failed'].includes(item.status)
    && (item.type === 'tool' ? typeof item.name === 'string' && item.presentation && typeof item.presentation.message === 'string'
      : ['thought', 'response', 'commentary'].includes(item.type) && typeof item.text === 'string');
}

export function isNewerMessage(current, incoming) {
  return current?.streamEpoch && current.streamEpoch === incoming.streamEpoch
    && Number.isSafeInteger(current.streamRevision) && Number.isSafeInteger(incoming.streamRevision)
    && current.streamRevision > incoming.streamRevision;
}
