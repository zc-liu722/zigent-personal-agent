import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
await build({entryPoints:[fileURLToPath(new URL('./browser/client.js',import.meta.url))],outfile:fileURLToPath(new URL('../../web/meeting-rtc.js',import.meta.url)),bundle:true,minify:true,format:'iife',target:['safari16','chrome100'],legalComments:'inline'});
