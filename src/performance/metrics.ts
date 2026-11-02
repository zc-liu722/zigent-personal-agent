export const latencyMetrics = {
  'media.image': { label: '图像生成', group: '模型', target: 120000, percentile: 95 },
  'media.image_context': { label: '图片上下文准备', group: '模型', target: 1000, percentile: 95 },
  'media.image_history': { label: '官方图片历史同步', group: '模型', target: 1000, percentile: 95 },
  'media.image_dispatch': { label: '图片请求到生成开始', group: '模型', target: 10000, percentile: 95 },
  'media.image_render': { label: '图片实际生成', group: '模型', target: 120000, percentile: 95 },
  'media.image_finish': { label: '图片生成后收尾', group: '模型', target: 3000, percentile: 95 },
  'media.image_delivery': { label: '图片回传', group: '网络', target: 1000, percentile: 95 },
  'media.video': { label: '视频生成', group: '模型', target: 300000, percentile: 95 },
  'notification.send': { label: '通知服务受理', group: '网络', target: 1500, percentile: 95 },
  'web.speech_connect': { label: '语音连接', group: '浏览器', target: 1000, percentile: 95 },
  'web.speech_socket': { label: '语音传输就绪', group: '网络', target: 500, percentile: 95 },
  'web.speech_resume': { label: '语音会话往返', group: '网络', target: 500, percentile: 95 },
  'web.speech_audio_ack': { label: '音频分片往返', group: '网络', target: 500, percentile: 95 },
  'web.speech_upstream': { label: '识别服务握手', group: '网络', target: 500, percentile: 95 },
  'web.speech_queue': { label: '音频转发等待', group: '服务端', target: 200, percentile: 95 },
  'web.speech_capture': { label: '点击到首段采音', group: '浏览器', target: 1000, percentile: 95 },
  'web.speech_provider': { label: '点击到识别连接', group: '浏览器', target: 1000, percentile: 95 },
  'web.speech_first_text': { label: '采音到首次文字', group: '浏览器', target: 1500, percentile: 95 },
  'web.speech_render': { label: '转录文字同步', group: '浏览器', target: 50, percentile: 95 },
  'web.speech_finish': { label: '语音收尾转录', group: '浏览器', target: 2500, percentile: 95 },
  'web.conversation': { label: '会话切换可见', group: '浏览器', target: 800, percentile: 95 },
  'web.reply_first': { label: '发送到首段可见', group: '对话', target: 6000, percentile: 95 },
  'web.reply_receive': { label: '发送到首段推送', group: '对话', target: 6000, percentile: 95 },
  'web.reply_paint': { label: '首段推送到绘制', group: '浏览器', target: 200, percentile: 95 },
  'web.reply_total': { label: '发送到回复完成', group: '对话', target: 60000, percentile: 95 },
  'http.request': { label: '服务端 API', group: '服务端', target: 300, percentile: 95 },
  'http.headers': { label: '服务端响应头', group: '服务端', target: 200, percentile: 95 },
  'turn.queue': { label: '消息排队', group: '对话', target: 500, percentile: 95 },
  'turn.serial_wait': { label: '会话串行等待', group: '对话', target: 500, percentile: 95 },
  'turn.preflight': { label: '消息前置处理', group: '对话', target: 500, percentile: 95 },
  'turn.total': { label: '消息处理全程', group: '对话', target: 60000, percentile: 95 },
  'task.execute': { label: '后台任务执行', group: '对话', target: 60000, percentile: 95 },
  'task.delivery': { label: '后台结果投递', group: '对话', target: 60000, percentile: 95 },
  'agent.run': { label: 'Agent 执行', group: '对话', target: 60000, percentile: 95 },
  'memory.operation': { label: '上下文与存储', group: '服务端', target: 200, percentile: 95 },
  'model.call': { label: '模型调用', group: '模型', target: 30000, percentile: 95 },
  'model.first_output': { label: '模型首段文本', group: '模型', target: 5000, percentile: 95 },
  'model.first_tool_arguments': { label: '模型首段工具参数', group: '模型', target: 5000, percentile: 95 },
  'model.first_reasoning': { label: '模型首段推理摘要', group: '模型', target: 5000, percentile: 95 },
  'model.codex_setup': { label: '订阅模型启动', group: '模型', target: 1000, percentile: 95 },
  'model.codex_setup_warm': { label: '订阅模型预热启动', group: '模型', target: 1000, percentile: 95 },
  'model.codex_setup_cold': { label: '订阅模型冷启动', group: '模型', target: 1000, percentile: 95 },
  'model.codex_account': { label: '订阅账户检查', group: '模型', target: 500, percentile: 95 },
  'model.codex_first': { label: '订阅请求到首段', group: '模型', target: 4000, percentile: 95 },
  'tool.call': { label: '工具执行', group: '工具', target: 5000, percentile: 95 },
  'network.headers': { label: '外部请求响应头', group: '网络', target: 1500, percentile: 95 },
  'network.total': { label: '外部请求全程', group: '网络', target: 10000, percentile: 95 },
  'server.event_loop': { label: '事件循环延迟', group: '服务端', target: 50, percentile: 95 },
  'web.api': { label: '浏览器 API 全程', group: '浏览器', target: 800, percentile: 95 },
  'web.network': { label: 'API 往返与下载估算', group: '浏览器', target: 500, percentile: 95 },
  'web.ttfb': { label: '页面首字节', group: '浏览器', target: 800, percentile: 75 },
  'web.lcp': { label: '最大内容绘制', group: '浏览器', target: 2500, percentile: 75 },
  'web.interaction': { label: '交互绘制延迟', group: '浏览器', target: 200, percentile: 75 },
  'web.dns': { label: 'DNS 查询', group: '网络', target: 100, percentile: 95 },
  'web.connect': { label: 'TCP 连接', group: '网络', target: 300, percentile: 95 },
  'web.tls': { label: 'TLS 握手', group: '网络', target: 300, percentile: 95 },
  'web.sse_connect': { label: '推送连接', group: '浏览器', target: 1000, percentile: 95 },
  'web.sse_delivery': { label: '推送往返估算', group: '浏览器', target: 500, percentile: 95 },
  'web.render': { label: '对话渲染', group: '浏览器', target: 50, percentile: 95 }
} as const;
export type LatencyMetric = keyof typeof latencyMetrics;
export type Outcome = 'ok' | 'error' | 'cancelled';
export type BrowserApiTiming = { headersMs: number; bodyMs: number; resourceMs?: number; background: boolean;
  beforeResourceMs?: number; afterResourceMs?: number; workerMs?: number };
export type BrowserLcpAssetTiming = { name: 'app' | 'components' | 'styles' | 'telemetry' | 'bootstrap';
  startMs: number; endMs: number; transferBytes?: number; encodedBytes?: number; decodedBytes?: number };
export type BrowserLcpTiming = { kind: 'lcp'; background: boolean; ttfbMs?: number; appReadyMs?: number; bootstrapReadyMs?: number;
  assets?: BrowserLcpAssetTiming[];
  firstMessageLcpMs?: number; candidateCount?: number; messageRenderCount?: number; lastMessageRenderStartMs?: number; lastMessageRenderEndMs?: number;
  navigationFetchStartMs?: number; navigationRequestStartMs?: number; navigationWorkerStartMs?: number; navigationResponseMs?: number;
  bootstrapStartMs?: number; bootstrapEndMs?: number; renderStartMs?: number; renderEndMs?: number;
  resourceStartMs?: number; resourceEndMs?: number; resourceLoadDelayMs?: number; resourceLoadMs?: number; elementRenderDelayMs?: number };
export type BrowserReplyTiming = { kind: 'reply'; hiddenMs: number; observedMs: number };
export type BrowserTiming = BrowserApiTiming | BrowserLcpTiming | BrowserReplyTiming;
export const browserMetrics = new Set<LatencyMetric>(Object.keys(latencyMetrics).filter(key => key.startsWith('web.')) as LatencyMetric[]);
export const buckets = [1, 5, 10, 25, 50, 100, 200, 300, 500, 800, 1000, 1500, 2500, 5000, 6000, 10000, 15000, 30000, 60000, 120000, 300000, 900000, 3600000, 86400000];
// The legacy 10s reply bucket contains both sides of 6s. Keep newer >6s
// observations distinct without rewriting historical aggregates.
export const replyAboveTargetBucket = 10001;
export function histogramBucket(metric: LatencyMetric, ms: number): number {
  if (metric === 'web.reply_first' && ms > 6000 && ms <= 10000) return replyAboveTargetBucket;
  return buckets.find(value => value >= ms) ?? 86400000;
}
/** Upper bounds with 0.1ms minimum resolution and three significant decimal digits.
 * All latency targets are boundaries, so successful attainment remains exact.
 * Version 2 is stored separately: legacy buckets cannot be split retrospectively.
 */
export function preciseHistogramBucket(ms: number): number {
  if (ms === 0) return 0;
  const ticks = Math.max(1, 10 ** (Math.floor(Math.log10(ms)) - 1));
  return Math.ceil(ms * 10 / ticks) * ticks / 10;
}
/** Drop query strings and all identifiers; never retain raw paths. */
export function routeLabel(path: string): string {
  const root = path.split('?')[0]!.replace(/^\/+/, '').split('/');
  const known = new Set(['api', 'bootstrap', 'me', 'login', 'logout', 'password', 'messages', 'activity', 'assets', 'conversations', 'models', 'default', 'reasoning', 'events', 'usage', 'performance', 'client', 'ping', 'trace', 'interactions', 'proactive-tasks', 'runs', 'browser', 'speech', 'codex', 'task', 'result', 'memory', 'documents', 'healthz', 'theme', 'cached', 'remote', 'queue', 'edit', 'fork', 'stop']);
  return root.slice(0, 6).map(part => known.has(part) ? part : ':id').join('/') || 'page';
}
