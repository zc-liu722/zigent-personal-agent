import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
  await build({ ...options, entryPoints: [join(source, 'app.js')], outfile: join(destination, 'app.js'), format: 'esm' });
  for (const file of styles.slice(1)) html = html.replace(`<link rel="stylesheet" href="${file}">`, '');
  html = html.replace(`src="${scripts[0]}"`, 'src="./shell-runtime.js"');
  for (const file of scripts.slice(1)) html = html.replace(`<script src="${file}" defer></script>`, '');
  await writeFile(join(destination, 'index.html'), html);
  console.info(`WEB_BUILD styles=${styles.length}->1 scripts=${scripts.length}->1 modules=bundled`);
}
