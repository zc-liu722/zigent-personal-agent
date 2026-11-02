import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { posix } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

type Representation = { body: Buffer; etag: string; encoding?: string };

/** Content versions follow actual imports and CSS resources; unrelated changes keep warm assets cached. */
export function prepareStaticAssets(files: Map<string, Buffer>, types: Record<string, [string, string]>) {
  // Start bootstrap during parsing and keep monitoring off the external-script critical path.
  // Authorize these exact bytes through CSP; no general inline-script permission is added.
  const inlineScripts = new Map<string, string>();
  for (const file of ['startup.js', 'telemetry.js']) {
    const source = files.get(file)?.toString('utf8').replace(/\r\n?/g, '\n').replace(/<\/script/gi, '<\\/script');
    if (source) inlineScripts.set(file, source);
  }
  const inlineCspHashes = [...inlineScripts.values()].map(source => `'sha256-${createHash('sha256').update(source).digest('base64')}'`).join(' ');
  const imports = new Map<string, string[]>();
  for (const [path, bytes] of files) {
    if (!path.endsWith(".js")) continue;
    imports.set(path, [...bytes.toString("utf8").matchAll(/^\s*import\s+(?:[^'";\n]+\s+from\s*)?(['"])(\.{1,2}\/[^'"]+)\1/gm)]
      .map(match => posix.normalize(posix.join(posix.dirname(path), match[2]!))).filter(value => files.has(value)));
  }
  const dependencies = new Map<string, string[]>();
  for (const [path, bytes] of files) {
    if (!path.endsWith('.js') && !path.endsWith('.css')) { dependencies.set(path, []); continue; }
    const content = bytes.toString('utf8');
    const references = path.endsWith('.js')
      ? [...content.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])(\.{1,2}\/[^'"]+)\1/g)].map(match => match[2]!)
      : path.endsWith('.css') ? [...content.matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/g)].map(match => match[1]!) : [];
    dependencies.set(path, references.filter(value => !/^(?:[a-z]+:|\/|#)/i.test(value))
      .map(value => posix.normalize(posix.join(posix.dirname(path), value.split(/[?#]/, 1)[0]!))).filter(value => files.has(value)));
  }
  const versions = new Map<string, string>();
  for (const path of files.keys()) {
    const reachable = new Set<string>();
    const visit = (file: string) => { if (reachable.has(file)) return; reachable.add(file); for (const dependency of dependencies.get(file) ?? []) visit(dependency); };
    visit(path);
    const hash = createHash('sha256');
    for (const file of [...reachable].sort()) hash.update(file).update('\0').update(files.get(file)!);
    versions.set(path, hash.digest('hex').slice(0, 24));
  }
  // Lazy assets resolve their own immutable version from fresh public HTML, rather than inheriting app.js's version.
  const assetVersions = JSON.stringify(Object.fromEntries([...versions].filter(([path]) => /\.(?:m?js|css)$/.test(path))))
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
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
    let text = bytes.toString("utf8");
    if (path === "" || path.endsWith(".html")) {
      text = modulePreloads(path, text);
      text = text.replace(/\b(src|href)=(['"])([^'"]+)\2/g, (_, attribute, quote, value) => `${attribute}=${quote}${versionUrl(path, value)}${quote}`);
      if (path === '') text = text.replace(/<script\b[^>]*\bsrc=['"]\.\/(startup|telemetry)\.js(?:\?[^'"]*)?['"][^>]*><\/script>/g,
        (tag, name) => !inlineScripts.has(`${name}.js`) ? tag : name === 'telemetry' ? '' : `<script>${inlineScripts.get(`${name}.js`)}</script>`);
      // Discover styles/app first, but install the collector before deferred app execution and the first body paint.
      if (path === '') text = text.replace('</head>', `<meta name="zigent-asset-versions" content="${assetVersions}">\n${inlineScripts.has('telemetry.js') ? `<script>${inlineScripts.get('telemetry.js')}</script>\n` : ''}</head>`);
    } else if (path.endsWith(".js")) {
      text = text.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])(\.{1,2}\/[^'"]+)\2/g,
        (_, prefix, quote, value) => `${prefix}${quote}${versionUrl(path, value)}${quote}`);
    } else if (path.endsWith(".css")) {
      text = text.replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g, (_, quote, value) => `url(${quote}${versionUrl(path, value)}${quote})`);
    } else continue;
    files.set(path, Buffer.from(text));
  }
  const representations = new Map<string, Representation[]>();
  function representation(body: Buffer, encoding?: string): Representation {
    return { body, encoding, etag: `"${createHash("sha256").update(body).digest("hex")}"` };
  }
  for (const [path, bytes] of files) {
    if (!path || path.endsWith(".html") || path === "manifest.webmanifest") continue;
    const variants = [representation(bytes)];
    if (bytes.length > 1024 && /(?:javascript|text\/|svg)/.test(types[path]![1])) {
      variants.push(representation(gzipSync(bytes), "gzip"));
      variants.push(representation(brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }), "br"));
    }
    representations.set(path, variants);
  }
  const serve = (req: IncomingMessage, res: ServerResponse, path: string, url: URL): boolean => {
    const variants = representations.get(path);
    if (!variants) return false;
    const encodings = (req.headers["accept-encoding"] ?? "").split(",").map(value => {
      const [name, ...parameters] = value.trim().split(";");
      const quality = parameters.find(value => value.trim().startsWith("q="))?.trim().slice(2);
      return { name, quality: quality === undefined ? 1 : Number(quality) };
    });
    const accepted = (name: string) => (encodings.find(value => value.name === name) ?? encodings.find(value => value.name === "*"))?.quality ?? 0;
    const variant = variants.find(value => value.encoding === "br" && accepted("br") > 0)
      ?? variants.find(value => value.encoding === "gzip" && accepted("gzip") > 0) ?? variants[0]!;
    res.setHeader("Cache-Control", url.searchParams.get("v") === versions.get(path) ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate");
    res.setHeader("Vary", "Accept-Encoding");
    res.setHeader("ETag", variant.etag);
    res.setHeader("Content-Type", types[path]![1]);
    if (variant.encoding) res.setHeader("Content-Encoding", variant.encoding);
    if (req.headers["if-none-match"]?.split(",").some(value => value.trim().replace(/^W\//, "") === variant.etag || value.trim() === "*")) {
      res.writeHead(304); res.end(); return true;
    }
    res.setHeader("Content-Length", variant.body.length);
    res.writeHead(200); res.end(req.method === "HEAD" ? undefined : variant.body); return true;
  };
  return Object.assign(serve, { inlineCspHashes });
}
