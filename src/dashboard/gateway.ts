import { componentAssets } from '../web/component-assets.js';
import { conversationOutputSchema } from '../channels/output.js';
import { interactiveOutputPage } from '../web/interactive-output.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { readManifest } from '../config/manifest.js';
import type { Manifest } from '../config/schemas.js';
import { data, json } from '../web/http.js';
import { prepareStaticAssets } from '../web/static-assets.js';
import { DashboardAuth } from './auth.js';
import { DashboardData } from './data.js';

const query = z.object({ hours: z.coerce.number().pipe(z.union([z.literal(1), z.literal(24), z.literal(168), z.literal(720)])).default(24),
  period: z.enum(['today', '7d', '30d', 'all']).default('30d'), agent: z.string().max(64).default(''), model: z.string().max(160).default('') });

/** Server administration has its own password, cookie and database. Agent cookies never grant access. */
export async function createDashboardGateway(manifest?: Manifest, environment = process.env) {
  manifest ??= await readManifest(environment.AGENTS_CONFIG_PATH ?? 'config/agents.json');
  const config = manifest.integrations.dashboard;
  if (!config) return;
  const storage = resolve(config.storage), base = '/dashboard/', origin = new URL(config.publicUrl).origin;
  await mkdir(dirname(storage), { recursive: true, mode: 0o700 });
  const auth = new DashboardAuth(storage, environment[config.passwordHashEnv]), reports = new DashboardData(manifest, storage);
  const types: Record<string, [string, string]> = { '': ['dashboard.html', 'text/html; charset=utf-8'], 'dashboard.js': ['dashboard.js', 'text/javascript; charset=utf-8'], 'dashboard.css': ['dashboard.css', 'text/css; charset=utf-8'] };
  Object.assign(types, componentAssets, Object.fromEntries([
    'component-lab.js', 'component-preview.js', 'components/fixtures.js', 'dom.js', 'markdown.js', 'lazy-assets.js'
  ].map(file => [file, [file, 'text/javascript; charset=utf-8']])), {
    'component-preview.html': ['component-preview.html', 'text/html; charset=utf-8'],
    'component-preview.css': ['component-preview.css', 'text/css; charset=utf-8'],
    'style.css': ['style.css', 'text/css; charset=utf-8'], 'theme.css': ['theme.css', 'text/css; charset=utf-8']
  });
  const files = new Map<string, Buffer>();
  for (const [route, [file]] of Object.entries(types)) files.set(route, await readFile(new URL(`../../web/${file}`, import.meta.url)));
  const serveStatic = prepareStaticAssets(files, types);
  const route = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (url.pathname === '/dashboard') { res.writeHead(308, { Location: base }); res.end(); return; }
    const path = url.pathname.slice(base.length);
    if (path === 'component-preview.html') {
      if (!auth.authenticate(req.headers.cookie)) { json(res, 401, { error: '请先登录 Dashboard。' }); return; }
      // The frame can execute the shared renderer, but cannot make network requests or submit forms.
      // Inline script permission is inherited only by opaque-origin srcdoc output sandboxes.
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data:; frame-src 'self' about:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && types[path]) {
      if (serveStatic(req, res, path, url)) return;
      res.writeHead(200, { 'Content-Type': types[path]![1] }); res.end(req.method === 'HEAD' ? undefined : files.get(path)); return;
    }
    if (path === 'healthz' && req.method === 'GET') { json(res, auth.ready ? 200 : 503, { status: auth.ready ? 'ok' : 'unconfigured', component: 'dashboard' }); return; }
    const mutation = !['GET', 'HEAD'].includes(req.method ?? '');
    if (req.headers.origin && req.headers.origin !== origin || mutation && req.headers.origin !== origin
      || req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site']))) { json(res, 403, { error: '请在 Dashboard 页面内操作。' }); return; }
    if (path === 'api/login' && req.method === 'POST') {
      if (!auth.ready) { json(res, 503, { error: 'Dashboard 管理密码尚未配置。' }); return; }
      if (!auth.allow(String(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? 'local'))) { json(res, 429, { error: '尝试次数过多，请 15 分钟后再试。' }); return; }
      const input = z.object({ password: z.string().min(1).max(256) }).strict().parse(await data(req, 2048));
      const cookie = await auth.login(input.password);
      if (!cookie) { json(res, 401, { error: '密码不正确。' }); return; }
      res.setHeader('Set-Cookie', cookie); json(res, 200, { ok: true }); return;
    }
    if (!auth.authenticate(req.headers.cookie)) { json(res, 401, { error: '请先登录 Dashboard。' }); return; }
    if (path === 'api/logout' && req.method === 'POST') { res.setHeader('Set-Cookie', auth.logout(req.headers.cookie)); json(res, 200, { ok: true }); return; }
    if (path === 'api/password' && req.method === 'POST') {
      if (!auth.allow(`password:${req.socket.remoteAddress ?? 'local'}`)) { json(res, 429, { error: '尝试次数过多，请稍后再试。' }); return; }
      const input = z.object({ current: z.string().min(1).max(256), password: z.string().min(12).max(256) }).strict().parse(await data(req, 2048));
      const cookie = await auth.change(input.current, input.password);
      if (!cookie) { json(res, 403, { error: '当前密码不正确。' }); return; }
      res.setHeader('Set-Cookie', cookie); json(res, 200, { ok: true }); return;
    }
    if (path === 'api/component-output' && req.method === 'POST') {
      const input = z.object({ output: conversationOutputSchema, theme: z.enum(['light', 'dark']) }).strict().parse(await data(req, 64_000));
      const tokens = files.get('components/interactive-tokens.css')!.toString('utf8');
      const pages = Object.fromEntries(input.output.blocks.flatMap((block, index) =>
        block.type === 'interactive' || block.type === 'animation'
          ? [[index, interactiveOutputPage(block, origin, input.theme, tokens)]] : []));
      json(res, 200, { pages }); return;
    }
    if (path === 'api/report' && req.method === 'GET') {
      const input = query.parse(Object.fromEntries(url.searchParams));
      if (input.agent && !manifest!.agents.some(agent => agent.id === input.agent)) { json(res, 400, { error: 'Agent 不存在。' }); return; }
      json(res, 200, await reports.report(input.hours, input.period, input.agent, input.model)); return;
    }
    json(res, 404, { error: '页面不存在。' });
  };
  return {
    async handle(req: IncomingMessage, res: ServerResponse) {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/dashboard' && !url.pathname.startsWith(base)) return false;
      try { await route(req, res, url); }
      catch (error) { if (!res.headersSent) json(res, error instanceof z.ZodError ? 400 : 503, { error: error instanceof z.ZodError ? '请求参数不正确。' : '监控数据暂不可用，请重试。' }); else res.end(); }
      return true;
    },
    close() { reports.close(); auth.close(); }
  };
}
