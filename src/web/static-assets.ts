import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";
import { setImmediate } from "node:timers/promises";
import { posix } from "node:path";
import { brotliCompress, brotliCompressSync, constants, gzip, gzipSync } from "node:zlib";
import { pageColors, paletteAsset } from "./palette.js";

export type Representation = { body: Buffer; etag: string; encoding?: string };

/** Content versions follow actual imports and CSS resources; unrelated changes keep warm assets cached. */
function* rewriteAssets(files: Map<string, Buffer>) {
  // Start bootstrap during parsing and keep monitoring off the external-script critical path.
  // Authorize these exact bytes through CSP; no general inline-script permission is added.
  const inlineScripts = new Map<string, string>();
  for (const file of ['startup.js', 'telemetry.js', 'shell-hint.js', 'shell-reveal.js']) {
    const source = files.get(file)?.toString('utf8').replace(/\r\n?/g, '\n').replace(/<\/script/gi, '<\\/script');
    if (source) inlineScripts.set(file, source);
  }
  const inlineCspHashes = [...inlineScripts.values()].map(source => `'sha256-${createHash('sha256').update(source).digest('base64')}'`).join(' ');
  const imports = new Map<string, string[]>();
  for (const [path, bytes] of files) {
    if (!path.endsWith(".js")) continue;
    yield;
    imports.set(path, [...bytes.toString("utf8").matchAll(/^\s*import\s+(?:[^'";\n]+\s+from\s*)?(['"])(\.{1,2}\/[^'"]+)\1/gm)]
      .map(match => posix.normalize(posix.join(posix.dirname(path), match[2]!))).filter(value => files.has(value)));
  }
  const dependencies = new Map<string, string[]>();
  for (const [path, bytes] of files) {
    if (!path.endsWith('.js') && !path.endsWith('.css') && !path.endsWith('.html')) { dependencies.set(path, []); continue; }
    yield;
    const content = bytes.toString('utf8');
    const references = path.endsWith('.js')
      ? [...content.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\bnew\s+URL\(\s*)(['"])(\.{1,2}\/[^'"]+)\1/g)].map(match => match[2]!)
      : path.endsWith('.css') ? [...content.matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/g)].map(match => match[1]!)
      : [...content.matchAll(/\b(?:src|href)=(['"])(\.{1,2}\/[^'"]+)\1/g)].map(match => match[2]!);
    dependencies.set(path, references.filter(value => !/^(?:[a-z]+:|\/|#)/i.test(value))
      .map(value => posix.normalize(posix.join(posix.dirname(path), value.split(/[?#]/, 1)[0]!))).filter(value => files.has(value)));
  }
  const versions = new Map<string, string>();
  for (const path of files.keys()) {
    yield;
    const reachable = new Set<string>();
    const visit = (file: string) => { if (reachable.has(file)) return; reachable.add(file); for (const dependency of dependencies.get(file) ?? []) visit(dependency); };
    visit(path);
    const hash = createHash('sha256');
    for (const file of [...reachable].sort()) hash.update(file).update('\0').update(files.get(file)!);
    versions.set(path, hash.digest('hex').slice(0, 24));
  }
  // Lazy assets resolve their own immutable version from this document's map, rather than inheriting app.js's version.
  const versionBody = Buffer.from(JSON.stringify(Object.fromEntries([...versions].filter(([path]) => /\.(?:m?js|css|html)$/.test(path)))));
  files.set('asset-versions.json', versionBody);
  const versionHash = createHash('sha256').update('asset-versions.json').update('\0').update(versionBody).digest('hex').slice(0, 24);
  versions.set('asset-versions.json', versionHash);
  const assetVersionsUrl = `./asset-versions.json?v=${versionHash}`;
  const paletteCss = files.get(paletteAsset)?.toString('utf8');
  const pageColorList = paletteCss ? JSON.stringify(pageColors(paletteCss)).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;') : '';
  function modulePreloads(path: string, html: string): string {
    return html.replace(/<script\b[^>]*\btype=['"]module['"][^>]*\bsrc=['"]([^'"]+)['"][^>]*>/g, (tag, source: string) => {
      const entry = posix.normalize(posix.join(posix.dirname(path), source)), dependencies = new Set<string>();
      const visit = (file: string) => {
        for (const dependency of imports.get(file) ?? []) {
          if (dependency === entry || dependencies.has(dependency)) continue;
          dependencies.add(dependency); visit(dependency);
        }
      };
      visit(entry);
      return [...dependencies].map(file => `<link rel="modulepreload" href="${posix.relative(posix.dirname(path), file)}">`).join("\n") + "\n" + tag;
    });
  }
  function versionUrl(from: string, value: string): string {
    if (/^(?:[a-z]+:|\/|#)/i.test(value)) return value;
    const [path, fragment] = value.split("#", 2);
    if (path!.includes("?") || !files.has(posix.normalize(posix.join(posix.dirname(from), path!)))) return value;
    const file = posix.normalize(posix.join(posix.dirname(from), path!));
    return `${path}?v=${versions.get(file)}${fragment === undefined ? "" : `#${fragment}`}`;
  }
  // Resolve URLs once at startup. API data and private media never enter this map.
  for (const [path, bytes] of files) {
    yield;
    let text = bytes.toString("utf8");
    if (path === "" || path.endsWith(".html")) {
      text = modulePreloads(path, text);
      text = text.replace(/\b(src|href)=(['"])([^'"]+)\2/g, (_, attribute, quote, value) => `${attribute}=${quote}${versionUrl(path, value)}${quote}`);
      if (path === '' && pageColorList) text = text.replace('name="zigent-page-colors" content=""', `name="zigent-page-colors" content="${pageColorList}"`);
      if (path === '') text = text.replace(/<script\b[^>]*\bsrc=['"]\.\/(startup|telemetry|shell-hint|shell-reveal)\.js(?:\?[^'"]*)?['"][^>]*><\/script>/g,
        (tag, name) => !inlineScripts.has(`${name}.js`) ? tag : name === 'telemetry' ? '' : `<script>${inlineScripts.get(`${name}.js`)}</script>`);
      // Discover styles/app first, but install the collector before deferred app execution and the first body paint.
      if (path === '') text = text.replace('</head>', `<meta name="zigent-asset-versions" content="${assetVersionsUrl}">\n${inlineScripts.has('telemetry.js') ? `<script>${inlineScripts.get('telemetry.js')}</script>\n` : ''}</head>`);
    } else if (path.endsWith(".js")) {
      text = text.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\bnew\s+URL\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g,
        (_, prefix, quote, value) => `${prefix}${quote}${versionUrl(path, value)}${quote}`);
      if (path === 'sw.js') {
        const shellVersion = versions.get('') ?? 'dev';
        const precache = ['./'];
        for (const file of ['style.css', 'app.js', 'shell-runtime.js', 'asset-versions.json']) {
          const version = versions.get(file);
          if (version) precache.push(`./${file}?v=${version}`);
        }
        text = text.replace('const CACHE = "zigent-shell-dev";', `const CACHE = "zigent-shell-${shellVersion.slice(0, 16)}";`)
          .replace('const PRECACHE = [];', `const PRECACHE = ${JSON.stringify(precache)};`);
      }
    } else if (path.endsWith(".css")) {
      text = text.replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g, (_, quote, value) => `url(${quote}${versionUrl(path, value)}${quote})`);
    } else continue;
    files.set(path, Buffer.from(text));
  }
  return { inlineCspHashes, versions };
}
function representation(body: Buffer, encoding?: string): Representation {
  return { body, encoding, etag: `"${createHash("sha256").update(body).digest("hex")}"` };
}
const compressible = (bytes: Buffer, mime: string) => bytes.length > 1024 && /(?:javascript|json|text\/|svg)/.test(mime);
function staticServer(types: Record<string, [string, string]>,
  metadata: { inlineCspHashes: string; versions: Map<string, string> }, representations: Map<string, Representation[]>) {
  const serve = (req: IncomingMessage, res: ServerResponse, path: string, url: URL): boolean => {
    if (!path || path.endsWith(".html") || path === "manifest.webmanifest") return false;
    const variants = representations.get(path);
    if (!variants) return false;
    return serveRepresentations(req, res, url, metadata.versions.get(path), types[path]![1], variants);
  };
  return Object.assign(serve, metadata, { representations });
}

/** Build-time rewriting and compression. Runtime releases read these exact prepared bytes. */
export function prepareStaticAssets(files: Map<string, Buffer>, types: Record<string, [string, string]>) {
  const rewrite = rewriteAssets(files);
  let next = rewrite.next();
  while (!next.done) next = rewrite.next();
  const representations = new Map<string, Representation[]>();
  for (const [path, bytes] of files) {
    if (!types[path]) types[path] = [path, path.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/octet-stream'];
    const variants = [representation(bytes)];
    if (compressible(bytes, types[path]![1])) {
      variants.push(representation(gzipSync(bytes), "gzip"));
      variants.push(representation(brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }), "br"));
    }
    representations.set(path, variants);
  }
  return staticServer(types, next.value, representations);
}

/** One-time compatibility migration for pre-prepared releases; yield CPU work and use zlib's worker pool. */
export async function prepareLegacyStaticAssets(files: Map<string, Buffer>, types: Record<string, [string, string]>) {
  const rewrite = rewriteAssets(files);
  let next = rewrite.next();
  while (!next.done) { await setImmediate(); next = rewrite.next(); }
  const representations = new Map<string, Representation[]>();
  for (const [path, bytes] of files) {
    if (!types[path]) types[path] = [path, path.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/octet-stream'];
    const variants = [representation(bytes)];
    if (compressible(bytes, types[path]![1])) {
      variants.push(representation(await promisify(gzip)(bytes), "gzip"));
      variants.push(representation(await promisify(brotliCompress)(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }), "br"));
    }
    representations.set(path, variants);
    await setImmediate();
  }
  return staticServer(types, next.value, representations);
}

export function serveRepresentations(req: IncomingMessage, res: ServerResponse, url: URL,
  version: string | undefined, mime: string, variants: Representation[]): boolean {
    const encodings = (req.headers["accept-encoding"] ?? "").split(",").map(value => {
      const [name, ...parameters] = value.trim().split(";");
      const quality = parameters.find(value => value.trim().startsWith("q="))?.trim().slice(2);
      return { name, quality: quality === undefined ? 1 : Number(quality) };
    });
    const accepted = (name: string) => (encodings.find(value => value.name === name) ?? encodings.find(value => value.name === "*"))?.quality ?? 0;
    const variant = variants.find(value => value.encoding === "br" && accepted("br") > 0)
      ?? variants.find(value => value.encoding === "gzip" && accepted("gzip") > 0) ?? variants[0]!;
    res.setHeader("Cache-Control", url.searchParams.get("v") === version ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate");
    res.setHeader("Vary", "Accept-Encoding");
    res.setHeader("ETag", variant.etag);
    res.setHeader("Content-Type", mime);
    if (variant.encoding) res.setHeader("Content-Encoding", variant.encoding);
    if (req.headers["if-none-match"]?.split(",").some(value => value.trim().replace(/^W\//, "") === variant.etag || value.trim() === "*")) {
      res.writeHead(304); res.end(); return true;
    }
    res.setHeader("Content-Length", variant.body.length);
    res.writeHead(200); res.end(req.method === "HEAD" ? undefined : variant.body); return true;
}

export type PreparedAssetIndex = { inlineCspHashes: string; files: Record<string, Array<{ sha256: string; encoding?: string }>> };

/** Content-addressed wire representations are immutable and verified independently on read. */
export async function writePreparedAssets(root: string, prepared: ReturnType<typeof prepareStaticAssets>): Promise<PreparedAssetIndex> {
  await mkdir(root, { recursive: true });
  const files: PreparedAssetIndex["files"] = {};
  for (const [path, variants] of prepared.representations) {
    files[path] = [];
    for (const variant of variants) {
      const sha256 = variant.etag.slice(1, -1);
      await writeFile(join(root, sha256), variant.body);
      files[path]!.push({ sha256, ...(variant.encoding ? { encoding: variant.encoding } : {}) });
    }
  }
  return { inlineCspHashes: prepared.inlineCspHashes, files };
}
