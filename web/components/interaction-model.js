const interactionStates = { pending: '待操作', completed: '已完成', failed: '未完成', expired: '已过期', cancelled: '已取消' };
export function interactionUrl(value, authorization = false) {
  try {
    const url = new URL(value);
    return (!url.username && !url.password && (url.protocol === 'https:' || (!authorization && url.protocol === 'http:'))) ? url.href : undefined;
  } catch { return undefined; }
}
export function interactionStatus(item) {
  const status = Object.hasOwn(interactionStates, item.status) ? item.status : 'pending';
  return status === 'pending' && Number.isFinite(item.expiresAt) && item.expiresAt <= Date.now() ? 'expired' : status;
}
export function messageInteractions(message) {
  if (Array.isArray(message.interactions)) return message.interactions.filter(item => item && typeof item.id === 'string' && ['schedule-reminder', 'browser', 'authorization', 'actions', 'output', 'task-proposal', 'memory-proposal', 'operation-confirmation', 'user-question'].includes(item.kind));
  const action = message.action;
  if (action?.type === 'authorization') return [{ id: 'legacy-authorization', kind: 'authorization', title: '连接账号', service: action.service,
    status: 'pending', expiresAt: action.expiresAt, actions: [{ id: 'authorize', kind: 'link', label: '前往授权', url: action.url }] }];
  if (action?.type === 'model-fallback') return [{ id: 'legacy-fallback', kind: 'actions', title: '确认切换模型', status: action.status || 'pending', legacy: true,
    actions: [{ id: 'confirm', kind: 'submit', label: '切换并继续', value: { type: 'model-fallback', requestId: action.requestId, confirm: true } },
      { id: 'cancel', kind: 'submit', label: '取消', value: { type: 'model-fallback', requestId: action.requestId, confirm: false } }] }];
  return [];
}
