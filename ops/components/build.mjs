import { build } from 'esbuild';
import { tsImport } from 'tsx/esm/api';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { definitions, sourceInputs } from './catalogue.mjs';
import { buildWebAssets } from './web.mjs';
import { validateBoundaries } from './validate.mjs';
import { skillAssets } from './skill-assets.mjs';
import { modelManifestPaths, splitModelManifest } from '../../skills/zigent-source/scripts/release-inputs.mjs';

function modelAssets(source) {
  return { name: 'model-catalog', setup(build) {
    build.onResolve({ filter: /^#model-assets$/ }, () => ({ path: '#model-assets', namespace: 'model-assets' }));
    build.onLoad({ filter: /.*/, namespace: 'model-assets' }, async () => {
      const paths = modelManifestPaths.map(path => join(source, path));
      const { manifestSchema } = await tsImport(pathToFileURL(join(source, 'src/config/schemas.ts')).href, import.meta.url);
      const variants = await Promise.all(paths.map(async path => {
        const manifest = JSON.parse(await readFile(path, 'utf8'));
        const parsed = manifestSchema.safeParse(manifest);
        if (!parsed.success) {
          const issues = parsed.error.issues.map(issue => issue.path.join('.')).join(', ');
          throw Error(`MODEL_CATALOG_MANIFEST_INVALID ${path}: ${issues}`);
        }
        return splitModelManifest(manifest)?.catalog ?? null;
      }));
      return { contents: JSON.stringify({ local: variants[0], production: null }), loader: 'json', watchFiles: paths };
    });
  } };
}

export async function buildComponents(source, destination, commit, ids = [...Object.keys(definitions), 'web']) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('COMPONENT_COMMIT_REQUIRED');
  const started = performance.now();
  const records = [];
  await validateBoundaries(source);
  const inputs = await sourceInputs(source), hostFingerprint = inputs.fingerprints.host;
  for (const id of ids.filter(id => id !== 'web')) {
    const definition = definitions[id]; if (!definition) throw Error('COMPONENT_UNKNOWN');
    const before = performance.now();
    const inputFingerprint = inputs.fingerprints[id];
    const cache = process.env.ZIGENT_COMPONENT_BUILD_CACHE && join(process.env.ZIGENT_COMPONENT_BUILD_CACHE, 'v2', hostFingerprint, id, inputFingerprint);
    if (cache) {
      try {
        const record = JSON.parse(await readFile(join(cache, 'component.json'), 'utf8'));
        const bytes = await readFile(join(cache, 'index.mjs'));
        if (record.inputFingerprint === inputFingerprint && createHash('sha256').update(bytes).digest('hex') === record.sha256) {
          await mkdir(join(destination,id), {recursive:true});
          await cp(cache, join(destination,id,record.version), {recursive:true});
          records.push(record); console.info(JSON.stringify({event:'component.cache',id,hit:true,ms:performance.now()-before})); continue;
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const output = await build({ absWorkingDir: source, entryPoints: [definition.entry], bundle: true, write: false,
      platform: 'node', format: 'esm', target: 'node24', packages: 'bundle', legalComments: 'inline', metafile: true,
      plugins: id === 'skill-resources' ? [skillAssets(source)] : id === 'model-catalog' ? [modelAssets(source)] : [], banner: { js: `// Zigent immutable component source: ${commit}` } });
    const bytes = output.outputFiles[0].contents;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const record = { id, inputFingerprint, version: sha256, sourceCommit: commit, hostApi: 1, provides: definition.provides, requires: definition.requires, sha256, entry: 'index.mjs' };
    const directory = join(destination, id, sha256); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'index.mjs'), bytes);
    await writeFile(join(directory, 'component.json'), JSON.stringify(record) + '\n');
    // Keep the actual transitive bundle graph with the immutable package, away
    // from compact runtime/health identities. The release inventory hashes the
    // source files and lockfile that these imports came from.
    const resources = id === 'skill-resources' ? Object.keys(inputs.files).filter(path => path.startsWith('skills/'))
      : id === 'model-catalog' ? modelManifestPaths : [];
    await writeFile(join(directory, 'build-inputs.json'), JSON.stringify({ protocol: 1,
      sourceCommit: commit, hostFingerprint, inputFingerprint, dependencyLock: inputs.files['package-lock.json'].sha256,
      files: [...Object.keys(output.metafile.inputs), ...resources].sort() }) + '\n');
    if (cache) { await mkdir(dirname(cache), {recursive:true}); await cp(directory, cache, {recursive:true}); }
    records.push(record);
    console.info(JSON.stringify({ event: 'component.build', id, version: sha256, bytes: bytes.length, ms: performance.now() - before,
      inputs: Object.keys(output.metafile.inputs).length }));
  }
  const web = ids.includes('web') ? await buildWebAssets(source,destination,commit) : undefined;
  const metadata = { ...(web ? {web}:{}), protocol: 1, sourceCommit: commit, hostFingerprint, webFingerprint: inputs.fingerprints.web, inputs, components: records };
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, 'release.json'), JSON.stringify(metadata) + '\n');
  console.info(JSON.stringify({ event: 'components.built', ms: performance.now() - started }));
  return metadata;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const source = process.cwd(), destination = resolve(process.argv[2] ?? 'components');
  const commit = process.argv[3] ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await buildComponents(source, destination, commit, process.argv.slice(4).length ? process.argv.slice(4) : undefined);
}
