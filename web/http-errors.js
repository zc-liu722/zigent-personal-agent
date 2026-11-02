function operation(path = '', method = 'GET') {
  const route = path.split('?')[0].replace(/^\/+/, '');
  const read = method === 'GET';
  const labels = {
    bootstrap: '打开页面', login: '登录', logout: '退出登录', password: '修改密码',
    conversations: read ? '加载对话列表' : method === 'DELETE' ? '删除对话' : '新建对话',
    messages: read ? '加载对话消息' : '发送消息', 'messages/activity': '加载回复过程',
    'messages/queue': '更新待发送消息', 'messages/stop': '停止回复', branches: '创建对话分支',
    assets: '上传图片', models: read ? '加载模型列表' : '切换模型', 'models/default': '设置默认模型',
    memory: '加载记忆', documents: read ? '打开文档' : '保存文档',
    'memory/document': read ? '打开记忆文档' : '保存记忆文档',
    browser: read ? '加载浏览器' : '操作浏览器', 'browser/upload': '上传浏览器文件'
  };
  return labels[route] || labels[route.split('/')[0]] || (read ? '加载数据' : '提交操作');
}

function statusReason(status) {
  const reasons = {
    400: '请求内容不符合接口要求', 401: '登录已失效，请重新登录', 403: '请求被拒绝，请检查访问权限',
    404: '请求的接口或内容不存在', 408: '请求超时', 409: '内容已变化，请刷新后重试',
    413: '上传内容超过大小限制', 429: '请求过于频繁，请稍后重试',
    500: '服务器处理请求时出错', 502: '网关无法取得服务的有效响应',
    503: '服务暂时不可用', 504: '网关等待服务响应超时',
    520: '网关收到异常响应', 521: '网关连接服务被拒绝', 522: '网关连接服务超时',
    523: '网关无法找到源站', 524: '服务处理超时，网关已断开',
    525: '网关与服务的安全连接失败', 526: '源站证书验证失败'
  };
  return reasons[status] || (status >= 500 ? '服务或网关发生错误' : '请求未成功');
}

export function requestError(cause, { path, method = 'GET' } = {}) {
  if (cause?.name === 'AbortError' || cause?.requestMethod) return cause;
  const invalid = cause?.name === 'SyntaxError' || /expected pattern|invalid url/i.test(cause?.message || '');
  const timeout = cause?.name === 'TimeoutError';
  const reason = timeout ? '读取超时，请重试' : invalid ? '请求地址或参数格式不正确，请刷新页面后重试' : '网络连接中断，请检查网络';
  const uncertain = method !== 'GET' ? '，操作结果未确认，请刷新后核对' : '';
  return Object.assign(new Error(`${operation(path, method)}失败：${reason}${uncertain}。`, { cause }), {
    network: !invalid, timeout, requestPath: path, requestMethod: method
  });
}

// Never include response bodies or redirect URLs in feedback: they may contain private data.
export function parseJsonResponse(text, response, { path, method = 'GET' } = {}) {
  let result, format;
  const type = response.headers.get('Content-Type') || '';
  if (!text.trim()) format = 'empty';
  else if (/\btext\/html\b/i.test(type) || /^\s*</.test(text)) format = 'html';
  else {
    try { result = JSON.parse(text); } catch { format = 'invalid'; }
    if (!format && (!result || typeof result !== 'object' || Array.isArray(result))) format = 'invalid';
  }
  if (response.ok && !format) return result;
  const details = { empty: '服务返回了空内容', html: response.redirected ? '请求被重定向到网页，未收到接口数据' : '接口返回了网页，未收到所需数据', invalid: '服务返回的数据格式错误或不完整' };
  const serverMessage = typeof result?.error === 'string' ? result.error.trim() : '';
  const rawPattern = /the string did not match the expected pattern/i.test(serverMessage);
  const reason = !response.ok ? (serverMessage && !rawPattern ? serverMessage : statusReason(response.status)) : details[format];
  const detail = !response.ok && format ? `；${details[format]}` : '';
  const uncertain = method !== 'GET' && (response.ok || response.status >= 500) ? '；操作结果未确认，请刷新后核对' : '';
  const retry = method === 'GET' && response.status !== 401 && response.status !== 403 && !/请/.test(reason) ? '，请稍后重试' : '';
  throw Object.assign(new Error(`${operation(path, method)}失败：${reason}${detail}（HTTP ${response.status}）${uncertain}${retry}。`), {
    status: response.status, responseFormat: format, requestPath: path, requestMethod: method
  });
}

export async function readJsonResponse(response, context) {
  let text;
  try { text = await response.text(); }
  catch (cause) {
    if (cause?.name === 'AbortError') throw cause;
    const { path, method = 'GET' } = context || {};
    const uncertain = method !== 'GET' ? '；操作结果未确认，请刷新后核对' : '，请重试';
    throw Object.assign(new Error(`${operation(path, method)}失败：响应接收中断或内容无法解码（HTTP ${response.status}）${uncertain}。`, { cause }), {
      status: response.status, network: true, requestPath: path, requestMethod: method
    });
  }
  return parseJsonResponse(text, response, context);
}

export function errorMessage(value) {
  const message = typeof value === 'string' ? value : value?.message;
  if (/the string did not match the expected pattern/i.test(message || '')) return '浏览器无法解析数据或参数格式，请刷新页面后重试。';
  return message;
}
