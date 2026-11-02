import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildWeb } from '../ops/build-web.mjs';
const output = resolve('build/web');
await mkdir(output, { recursive: true });
await cp(resolve('web'), output, { recursive: true });
await buildWeb(resolve('web'), output);
