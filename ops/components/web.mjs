import { cp, mkdir, readFile, writeFile, readdir, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, extname, dirname } from 'node:path';
import { build } from 'esbuild';
import {fingerprint,trackedFiles} from './catalogue.mjs';
import { buildWeb } from '../build-web.mjs';
export const mimeTypes={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.wasm':'application/wasm','.webmanifest':'application/manifest+json'};
export async function buildWebAssets(source,destination,commit) {
  const started=performance.now(), temporary=join(destination,'.web-'+randomUUID()), publicRoot=join(temporary,'public');
  await mkdir(temporary,{recursive:true});
  try {
    await cp(join(source,'web'),publicRoot,{recursive:true,filter:path=>!path.endsWith('.map')&&!path.endsWith('.DS_Store')});
    await buildWeb(join(source,'web'),publicRoot);
    for(const directory of ['legacy/build','legacy/web','build','web','cmaps','standard_fonts','wasm']) {
      const from=join(source,'node_modules/pdfjs-dist',directory), target=join(publicRoot,'vendor/pdfjs',directory);
      await mkdir(target,{recursive:true});
      for(const file of await readdir(from,{withFileTypes:true})) {
        if(file.isDirectory()&&directory==='web'&&file.name==='images') { await cp(join(from,file.name),join(target,file.name),{recursive:true}); continue; }
        if(!file.isFile()||file.name.endsWith('.map'))continue;
        if(directory.endsWith('build')&&!['pdf.mjs','pdf.worker.mjs'].includes(file.name))continue;
        if(directory.endsWith('web')&&!['pdf_viewer.mjs','pdf_viewer.css'].includes(file.name))continue;
        await cp(join(from,file.name),join(target,file.name));
      }
    }
    // Preserve the maintained legacy URLs, including ES module forwarding adapters.
    for(const entry of await readdir(join(publicRoot,'components'),{withFileTypes:true})) {
      if(!entry.isFile())continue;
      const bytes=await readFile(join(publicRoot,'components',entry.name));
      await writeFile(join(publicRoot,entry.name),entry.name.endsWith('.js')&&/\bexport\s/.test(bytes.toString('utf8'))?`export * from './components/${entry.name}';\n`:bytes);
    }
    const paths=[];
    async function walk(directory,prefix='') { for(const entry of await readdir(directory,{withFileTypes:true})) { const path=prefix+entry.name;if(entry.isDirectory())await walk(join(directory,entry.name),path+'/');else if(entry.isFile())paths.push(path); } }
    await walk(publicRoot);paths.sort();
    const hash=createHash('sha256').update(commit),files=[];
    for(const path of paths) { const bytes=await readFile(join(publicRoot,path));hash.update(path).update('\0').update(bytes).update('\0');files.push({path,mime:mimeTypes[extname(path)]??'application/octet-stream',sha256:createHash('sha256').update(bytes).digest('hex')}); }
    const compiled=await build({entryPoints:[join(source,'src/web/static-assets.ts')],bundle:true,write:false,platform:'node',format:'esm',target:'node24'});
    const {prepareStaticAssets,writePreparedAssets}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].contents).toString('base64'));
    const types=Object.fromEntries(files.map(file=>[file.path==='index.html'?'':file.path,[file.path,file.mime]]));
    const raw=new Map(await Promise.all(files.map(async file=>[file.path==='index.html'?'':file.path,await readFile(join(publicRoot,file.path))])));
    const serving = prepareStaticAssets(raw,types);
    const versionManifest = raw.get('asset-versions.json');
    if (versionManifest) {
      await writeFile(join(publicRoot,'asset-versions.json'), versionManifest);
      hash.update('asset-versions.json').update('\0').update(versionManifest).update('\0');
      files.push({ path: 'asset-versions.json', mime: 'application/json; charset=utf-8', sha256: createHash('sha256').update(versionManifest).digest('hex') });
    }
    const versions=Object.fromEntries(serving.versions);
    const prepared=await writePreparedAssets(join(temporary,'prepared'),serving);
    const inputFingerprint=await fingerprint(source,trackedFiles(source).filter(file=>file.startsWith('web/')));
    const record={id:'web',inputFingerprint,versions,version:hash.digest('hex'),sourceCommit:commit,webApi:1,files,prepared};
    await writeFile(join(temporary,'component.json'),JSON.stringify(record)+'\n');
    const target=join(destination,'web',record.version);await mkdir(dirname(target),{recursive:true});
    try {
      const existing=JSON.parse(await readFile(join(target,'component.json'),'utf8'));
      if(JSON.stringify(existing)!==JSON.stringify(record))throw Error('WEB_BUILD_IMMUTABLE_CONFLICT');
      for(const variants of Object.values(record.prepared.files))for(const variant of variants)if(createHash('sha256').update(await readFile(join(target,'prepared',variant.sha256))).digest('hex')!==variant.sha256)throw Error('WEB_BUILD_CACHE_CORRUPT');
      for(const file of record.files)if(createHash('sha256').update(await readFile(join(target,'public',file.path))).digest('hex')!==file.sha256)throw Error('WEB_BUILD_CACHE_CORRUPT');
    } catch(error) { if(error.code!=='ENOENT')throw error; await rename(temporary,target); }
    console.info(JSON.stringify({event:'web.built',version:record.version,files:files.length,ms:performance.now()-started}));return record;
  } finally { await rm(temporary,{recursive:true,force:true}); }
}
