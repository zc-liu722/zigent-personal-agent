import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const lazySpecifiers = new Set(['./schedule.js', './file-workbench.js', './document-reader.js', './mermaid.js']);
function externalLazyImports() {
  return { name: 'external-lazy-imports', setup(build) {
    build.onResolve({ filter: /.*/ }, args => {
      if (args.kind === 'dynamic-import' && lazySpecifiers.has(args.path.split('?')[0])) return { path: args.path, external: true };
    });
  } };
}

/** Compile the public shell inside the release copy; development sources stay editable. */
export async function buildWeb(source, destination) {
  let html = await readFile(join(source, 'index.html'), 'utf8');
  const styles = [...html.matchAll(/<link rel="stylesheet" href="(\.\/[^"?]+\.css)">/g)].map(match => match[1]);
  const scripts = [...html.matchAll(/<script src="(\.\/[^"?]+\.js)" defer><\/script>/g)]
    .map(match => match[1]).filter(file => file !== './telemetry.js');
  if (styles[0] !== './style.css' || scripts[0] !== './components/interactive-output.js') throw new Error('Unexpected web shell entrypoints');
  const options = { bundle: true, minify: true, target: ['safari16', 'chrome100'], legalComments: 'inline', logLevel: 'warning' };
  // Preserve stylesheet and classic-script order, including globals used by app.js.
  await build({ ...options, stdin: { contents: styles.map(file => `@import ${JSON.stringify(file)};`).join('\n'),
    resolveDir: source, loader: 'css' }, external: ['./components/paper-grain.svg'], outfile: join(destination, 'style.css') });
  await build({ ...options, entryPoints: [join(source, 'shell-runtime.js')], outfile: join(destination, 'shell-runtime.js'), format: 'iife' });
  // import.meta.url stays on app.js so lazy assets retain their content version and base path.
  // Heavy panels stay real dynamic imports so the first paint does not download them.
  await build({ ...options, entryPoints: [join(source, 'app.js')], outfile: join(destination, 'app.js'), format: 'esm', plugins: [externalLazyImports()] });
  await build({ ...options, entryPoints: ['schedule.js', 'file-workbench.js', 'document-reader.js', 'mermaid.js', 'components/meeting-orb.js'].map(file => join(source, file)),
    outdir: destination, outbase: source, format: 'esm' });
  // Preserve Mermaid's lazy diagram imports: a flowchart must not download and
  // compile every diagram engine. These public modules run in the opaque frame.
  await build({ ...options, entryPoints: [join(source, 'mermaid-frame.js')], outdir: destination,
    chunkNames: 'mermaid/chunk-[hash]', splitting: true, format: 'esm' });
  for (const file of styles.slice(1)) html = html.replace(`<link rel="stylesheet" href="${file}">`, '');
  html = html.replace(`src="${scripts[0]}"`, 'src="./shell-runtime.js"');
  for (const file of scripts.slice(1)) html = html.replace(`<script src="${file}" defer></script>`, '');
  await writeFile(join(destination, 'index.html'), html);
  console.info(`WEB_BUILD styles=${styles.length}->1 scripts=${scripts.length}->1 modules=bundled`);
}
