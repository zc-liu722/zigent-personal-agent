import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { watch, unlinkSync } from 'node:fs';
import { mkdir, open, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComponentStudioChat } from './codex-chat.mjs';
import { ComponentStudioStore } from './store.mjs';
import { conversationOutputSchema } from '../../src/channels/output.ts';
import { interactiveOutputPage } from '../../src/web/interactive-output.ts';
const directory = dirname(fileURLToPath(import.meta.url)), root = await realpath(resolve(directory, '../..'));
const port = Number(process.env.COMPONENT_STUDIO_PORT || 4317), previewPort = Number(process.env.COMPONENT_STUDIO_PREVIEW_PORT || 4318);
if (![port, previewPort].every(value => Number.isInteger(value) && value > 1024 && value <= 65535) || port === previewPort) throw new Error('本地工作台端口配置无效');
const origin = `http://127.0.0.1:${port}`, previewOrigin = `http://127.0.0.1:${previewPort}`;
const store = new ComponentStudioStore(root);
await mkdir(store.directory, { recursive: true, mode: 0o700 });
if (await realpath(store.directory) !== store.directory) throw new Error('工作台目录不能使用符号链接');
const lockPath = join(store.directory, 'server.lock');
let locked = false;
for (let attempt = 0; attempt < 2 && !locked; attempt++) {
  try {
    const lock = await open(lockPath, 'wx', 0o600);
    try { await lock.writeFile(JSON.stringify({ pid: process.pid, origin })); locked = true; }
    finally { await lock.close(); }
  } catch (cause) {
    if (cause.code !== 'EEXIST') throw cause;
    let previous;
    try { previous = JSON.parse(await readFile(lockPath, 'utf8')); } catch { throw new Error('工作台正在启动，或锁记录损坏，请检查 .runtime/component-studio/server.lock'); }
    if (!Number.isInteger(previous.pid) || previous.pid < 1) throw new Error('工作台锁记录无效');
    let alive = true;
    try { process.kill(previous.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; }
    if (alive) throw new Error(`工作台已经运行：${previous.origin || origin}`);
    await rm(lockPath, { force: true });
  }
}
if (!locked) throw new Error('无法取得工作台写入锁');
process.once('exit', () => { try { unlinkSync(lockPath); } catch {} });
await store.init();
const token = randomBytes(32).toString('hex'), cookieName = `zigent-component-studio-${port}`;
const streams = new Set();
const chat = new ComponentStudioChat(store, (event, value) => { for (const res of streams) res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`); });
await chat.init();
let revision = 0, debounce;
const notify = () => { clearTimeout(debounce); debounce = setTimeout(() => { revision++; for (const res of streams) res.write(`data: ${JSON.stringify({ revision })}\n\n`); }, 250); };
const watchers = [watch(join(root, 'web'), { recursive: true }, (_, file) => { if (file && !String(file).includes('.component-studio-')) notify(); }),
  watch(join(store.directory, 'proposals'), { recursive: true }, notify)];
const mime = path => path.endsWith('.js') ? 'text/javascript; charset=utf-8' : path.endsWith('.css') ? 'text/css; charset=utf-8' : path.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8';
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
async function body(req) {
  let bytes = 0; const chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 2_100_000) throw Object.assign(new Error('内容超过大小限制'), { status: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('请求格式无效'), { status: 400 }); }
}
const authenticated = req => (req.headers.cookie || '').split(';').some(value => value.trim() === `${cookieName}=${token}`);
function headers(res) { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); }
async function serve(res, path, method) { const bytes = await readFile(path); res.writeHead(200, { 'Content-Type': mime(path) }); res.end(method === 'HEAD' ? undefined : bytes); }
function ids(input) {
  if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 100 || !input.ids.every(id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id))) throw Object.assign(new Error('请选择有效草稿'), { status: 400 });
  return [...new Set(input.ids)];
}
const app = createServer(async (req, res) => {
  headers(res);
  res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src ${previewOrigin}; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'`);
  try {
    if (req.headers.host !== `127.0.0.1:${port}`) { json(res, 403, { error: '请使用工作台的本地地址' }); return; }
    const path = new URL(req.url, origin).pathname;
    if (path === '/' && req.method === 'GET') {
      res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`); await serve(res, join(directory, 'studio.html'), req.method); return;
    }
    if (path === '/healthz' && req.method === 'GET') { json(res, 200, { status: 'ok', component: 'local-component-studio', previewOrigin }); return; }
    if (!authenticated(req)) { json(res, 401, { error: '请重新打开本地工作台' }); return; }
    if (req.headers.origin && req.headers.origin !== origin || !['GET', 'HEAD'].includes(req.method) && req.headers.origin !== origin) { json(res, 403, { error: '请在本地工作台内操作' }); return; }
    if (path === '/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' }); res.write(`data: ${JSON.stringify({ revision })}\n\n`); streams.add(res); req.on('close', () => streams.delete(res)); return;
    }
    if (path === '/studio.js' || path === '/studio.css' || path === '/chat.js') { if (!['GET', 'HEAD'].includes(req.method)) { json(res, 405, { error: '请求方法无效' }); return; } await serve(res, join(directory, path.slice(1)), req.method); return; }
    if (path === '/fixtures.js' && req.method === 'GET') { await serve(res, join(root, 'web/components/fixtures.js'), req.method); return; }
    if (path === '/api/state' && req.method === 'GET') { json(res, 200, { root, origin, previewOrigin, revision, chatting: [...chat.runs].filter(([, run]) => !run.done).map(([id]) => id), proposals: await store.serial(() => store.list()) }); return; }
    if (path === '/api/proposals' && req.method === 'POST') {
      const input = await body(req);
      if (typeof input.scenarioId !== 'string' || !/^[a-z0-9-]{1,80}$/.test(input.scenarioId) || typeof input.name !== 'string' || input.name.length > 120) throw Object.assign(new Error('场景信息无效'), { status: 400 });
      const proposal = await store.serial(() => store.create(input.scenarioId, input.name)); notify(); const { resolvedBases, ...info } = proposal; json(res, 200, info); return;
    }
    if (path === '/api/codex/status' && req.method === 'GET') { json(res, 200, await chat.status(new URL(req.url, origin).searchParams.get('refresh') === '1')); return; }
    const conversation = path.match(/^\/api\/proposals\/([a-f0-9-]{36})\/chat(?:\/(stop|preview|merge))?$/);
    if (conversation) {
      const [, id, action] = conversation; store.get(id);
      if (!action && req.method === 'GET') { json(res, 200, await chat.state(id)); return; }
      if (!action && req.method === 'POST') { json(res, 200, await chat.send(id, await body(req))); return; }
      if (action === 'merge' && req.method === 'POST') { json(res, 200, await chat.merge(id, await body(req))); return; }
      if (action === 'stop' && req.method === 'POST') { await chat.stop(id); json(res, 200, await chat.state(id)); return; }
      if (action === 'preview' && req.method === 'POST') { const input = await body(req); chat.receivePreview(id, input.requestId, input.context); json(res, 200, { ok: true }); return; }
    }
    const match = path.match(/^\/api\/proposals\/([a-f0-9-]{36})\/(preview|file|resolve)$/);
    if (match) {
      if (match[2] === 'preview' && req.method === 'GET') { json(res, 200, await store.serial(() => store.preview(match[1]))); return; }
      const query = new URL(req.url, origin).searchParams;
      if (match[2] === 'file' && req.method === 'GET') { json(res, 200, await store.serial(() => store.inspect(match[1], query.get('path') || ''))); return; }
      if (match[2] === 'resolve' && req.method === 'POST') {
        const input = await body(req);
        const result = await store.serial(() => { chat.assertIdle([match[1]]); return store.resolveConflict(match[1], input); });
        notify(); json(res, 200, result); return;
      }
      if (match[2] === 'file' && req.method === 'POST') {
        const input = await body(req);
        if (typeof input.path !== 'string' || input.content !== null && typeof input.content !== 'string' || input.revision !== null && typeof input.revision !== 'string') throw Object.assign(new Error('文件内容无效'), { status: 400 });
        await store.serial(() => { chat.assertIdle([match[1]]); return store.edit(match[1], input.path, input.content, input.revision); }); notify(); json(res, 200, { ok: true }); return;
      }
    }
    if ((path === '/api/save' || path === '/api/discard') && req.method === 'POST') {
      const input = await body(req), selected = ids(input);
      if (path === '/api/discard') await Promise.all(selected.map(id => chat.stop(id)));
      const result = await store.serial(() => { chat.assertIdle(selected); return path === '/api/save' ? store.save(selected, input.revisions) : store.discard(selected); }); notify(); json(res, 200, { ok: true, ...result }); return;
    }
    if (path === '/api/component-output' && req.method === 'POST') {
      const input = await body(req), output = conversationOutputSchema.safeParse(input.output);
      if (!output.success || !['light', 'dark'].includes(input.theme)) throw Object.assign(new Error('可视化 mock 数据无效'), { status: 400 });
      if (!/^[a-f0-9-]{36}$/.test(input.id || '') || !/^[a-f0-9]{24}$/.test(input.version || '') || !['before', 'after'].includes(input.side)) throw Object.assign(new Error('预览版本无效'), { status: 400 });
      store.get(input.id);
      const tokens = await readFile(await store.safePath(join(store.directory, 'renders', input.id, input.version, input.side), 'components/interactive-tokens.css'), 'utf8');
      json(res, 200, { pages: Object.fromEntries(output.data.blocks.flatMap((block, index) => ['interactive', 'animation'].includes(block.type) ? [[index, interactiveOutputPage(block, previewOrigin, input.theme, tokens)]] : [])) }); return;
    }
    json(res, 404, { error: '页面不存在' });
  } catch (cause) { if (!res.headersSent) json(res, cause.status || 500, { error: cause.code === 'ENOENT' ? '文件不存在' : cause.message || '操作失败' }); else res.end(); }
});
const preview = createServer(async (req, res) => {
  headers(res);
  res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data:; frame-src 'self' about:; frame-ancestors ${origin}; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`);
  try {
    if (req.headers.host !== `127.0.0.1:${previewPort}` || !['GET', 'HEAD'].includes(req.method)) { json(res, 403, { error: '预览服务只读' }); return; }
    const path = new URL(req.url, previewOrigin).pathname;
    if (path === '/preview-context.js') {
      const script = `window.ZigentComponentPreviewContext = ${JSON.stringify({ parentOrigin: origin })};\n` + await readFile(join(directory, 'preview-context.js'), 'utf8');
      res.writeHead(200, { 'Content-Type': mime(path) }); res.end(req.method === 'HEAD' ? undefined : script); return;
    }
    const match = path.match(/^\/([a-f0-9-]{36})\/([a-f0-9]{24})\/(before|after)\/(.+)$/);
    if (!match) { json(res, 404, { error: '预览版本不存在' }); return; }
    store.get(match[1]);
    const target = await store.safePath(join(store.directory, 'renders', match[1], match[2], match[3]), match[4]);
    if (match[4] === 'component-preview.html') {
      const html = (await readFile(target, 'utf8')).replace('</head>', '<script src="/preview-context.js"></script></head>');
      res.writeHead(200, { 'Content-Type': mime(target) }); res.end(req.method === 'HEAD' ? undefined : html); return;
    }
    await serve(res, target, req.method);
  } catch (cause) { json(res, cause.code === 'ENOENT' ? 404 : cause.status || 500, { error: cause.message || '预览加载失败' }); }
});
await new Promise((resolve, reject) => { preview.once('error', reject); preview.listen(previewPort, '127.0.0.1', resolve); });
try { await new Promise((resolve, reject) => { app.once('error', reject); app.listen(port, '127.0.0.1', resolve); }); }
catch (cause) { preview.close(); throw cause; }
console.info(`COMPONENT_STUDIO_READY url=${origin} preview=${previewOrigin}`);
console.info(`COMPONENT_STUDIO_DRAFTS ${store.directory}`);
const heartbeat = setInterval(() => { for (const res of streams) res.write(': keepalive\n\n'); }, 20000); heartbeat.unref();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  clearInterval(heartbeat); clearTimeout(debounce); watchers.forEach(watcher => watcher.close()); for (const res of streams) res.end(); streams.clear(); app.close(); preview.close(); await chat.close();
});
