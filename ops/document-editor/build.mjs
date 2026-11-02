import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { readFile, readdir, writeFile } from 'node:fs/promises';
const root = new URL('./', import.meta.url);
const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
const notices = [];
for (const [path, info] of Object.entries(lock.packages)) {
  if (!path || info.dev) continue;
  for (const file of await readdir(new URL(`${path}/`, root))) {
    if (!/^licen[sc]e(?:\.|$)/i.test(file)) continue;
    notices.push(`${path.replace(/^node_modules\//, '')} ${info.version}\n${await readFile(new URL(`${path}/${file}`, root), 'utf8')}`);
  }
}
await writeFile(new URL('../../web/document-editor.LICENSE.txt', root), notices.join('\n\n---\n\n'));
await build({ entryPoints: [fileURLToPath(new URL('browser.js', root))], outfile: fileURLToPath(new URL('../../web/document-editor.js', root)),
  bundle: true, minify: true, format: 'iife', target: ['safari16', 'chrome100'], legalComments: 'inline',
  banner: { js: '/*! ProseMirror Markdown editor. Source: ops/document-editor. Licenses: document-editor.LICENSE.txt */' } });
