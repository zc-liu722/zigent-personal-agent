import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { prepareSql } from '../sqlite.js';
import { ordinaryPath, snapshotFile, workspaceName } from '../workspaces/paths.js';
import type { WorkspaceService, ArtifactVersion } from '../workspaces/service.js';
import type { PreviewRequest, DocumentResult, PreviewRuntime, RuntimeDescription } from './document-types.js';
type Preview = { id: string; versionId: string; sourceSha256: string; name: string; state: 'queued'|'generating'|'ready'|'failed';
  cacheKey?: string; pdfSha256?: string; totalPages?: number; warnings?: string[]; error?: string; updatedAt: number };
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export const isDocumentPreview = (name: string) => /\.(pdf|docx?|pptx?|xlsx?|odt|odp|ods)$/i.test(name);

/** Owner-scoped, immutable derivatives. No model calls, project leases or project write locks. */
export class DocumentPreviews {
  private readonly pending = new Map<string, Promise<void>>();
  // Verified immutable snapshots serve range requests without rereading the whole PDF.
  private readonly buffers = new Map<string, {bytes:Buffer;usedAt:number}>();
  private readonly bufferReads = new Map<string, Promise<Buffer>>();
  private description?: { at: number; value: Promise<RuntimeDescription> };
  private generationQueue: Promise<void> = Promise.resolve();
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private closed = false;
  constructor(private readonly db: DatabaseSync, private readonly files: WorkspaceService, private readonly runtime: PreviewRuntime, private readonly directory: string, recoverPending = true) {
    db.exec(`CREATE TABLE IF NOT EXISTS document_preview_records(id TEXT PRIMARY KEY,version_id TEXT NOT NULL,record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS document_preview_cache(key TEXT PRIMARY KEY,sha256 TEXT NOT NULL,pages INTEGER,record TEXT NOT NULL,used_at INTEGER NOT NULL)`);
    db.exec("CREATE INDEX IF NOT EXISTS document_preview_versions ON document_preview_records(version_id)");
    // Interrupted derivatives can always be retried from their immutable input.
    for (const row of (recoverPending ? prepareSql(db, 'SELECT record FROM document_preview_records').all() : []) as Array<{record:string}>) {
      const preview = JSON.parse(row.record) as Preview;
      if (preview.state === 'queued' || preview.state === 'generating') this.save({...preview, state:'failed', error:'预览生成已中断，请重试。'});
    }
  }
  private save(preview: Preview) { prepareSql(this.db, 'INSERT OR REPLACE INTO document_preview_records VALUES (?,?,?)').run(preview.id, preview.versionId, JSON.stringify(preview)); return preview; }
  get(id: string): Preview {
    const row = prepareSql(this.db, 'SELECT record FROM document_preview_records WHERE id=?').get(id) as {record:string}|undefined;
    if (!row) throw new Error('预览不存在。');
    const preview = JSON.parse(row.record) as Preview;
    this.files.artifactVersion(preview.versionId); return preview;
  }
  describe() {
    if (!this.description || Date.now()-this.description.at > 60_000) this.description = {at:Date.now(),value:this.runtime.describe()};
    return this.description.value;
  }
  private remember(sha256:string,bytes:Buffer) {
    if(this.closed || bytes.length>32*1024*1024)return;
    this.buffers.delete(sha256);
    let size=bytes.length;
    for(const [key,value] of this.buffers) {
      if(Date.now()-value.usedAt>60_000)this.buffers.delete(key);
      else size+=value.bytes.length;
    }
    while(this.buffers.size>=4 || size>64*1024*1024) {
      const key=this.buffers.keys().next().value;if(!key)break;
      size-=this.buffers.get(key)!.bytes.length;this.buffers.delete(key);
    }
    this.buffers.set(sha256,{bytes,usedAt:Date.now()});
  }
  private async pdfBytes(sha256:string,load:()=>Promise<Buffer>) {
    const cached=this.buffers.get(sha256);
    if(cached && Date.now()-cached.usedAt<=60_000) {
      this.buffers.delete(sha256);this.buffers.set(sha256,{...cached,usedAt:Date.now()});return cached.bytes;
    }
    this.buffers.delete(sha256);
    const pending=this.bufferReads.get(sha256);if(pending)return pending;
    const task=(async()=>{
      const bytes=await load();
      if(hash(bytes)!==sha256)throw new Error('预览校验失败，请重新生成。');
      this.remember(sha256,bytes);return bytes;
    })();
    this.bufferReads.set(sha256,task);
    try{return await task;}finally{this.bufferReads.delete(sha256);}
  }
  async start(versionId: string, retry = false): Promise<Preview> {
    if (this.closed) throw new Error('预览服务正在关闭。');
    if (retry) this.description = undefined;
    const source = this.files.artifactVersion(versionId);
    if (!isDocumentPreview(source.name)) throw new Error('请选择 Word、演示文稿、表格或 PDF 文件。');
    let description: RuntimeDescription | undefined;
    let key: string | undefined;
    if(!/\.pdf$/i.test(source.name)) {
      description=await this.describe();
      if(!description.available || !description.operations.includes('convert'))throw new Error('文档转换暂不可用，请稍后重试。');
      key=hash(JSON.stringify({source:source.sha256,renderingIdentity:description.renderingIdentity,runtimeIdentity:description.runtimeIdentity,
        version:description.version,packages:description.packages,tools:description.tools,fonts:description.fonts,format:'pdf',parameters:'office-default-v1'}));
    }
    const prior = prepareSql(this.db, "SELECT record FROM document_preview_records WHERE version_id=? AND json_extract(record,'$.cacheKey') IS ? ORDER BY rowid DESC LIMIT 1").get(versionId,key??null) as {record:string}|undefined;
    let preview: Preview = prior ? JSON.parse(prior.record) : {id:randomUUID(),versionId,sourceSha256:source.sha256,name:source.name,state:'queued',cacheKey:key,updatedAt:Date.now()};
    if (this.pending.has(preview.id) || preview.state === 'failed' && !retry) return preview;
    if (!key) return this.save({...preview,state:'ready',pdfSha256:source.sha256});
    if(preview.state==='ready') {
      try {await this.read(preview.id);return preview;}
      catch {preview={...preview,id:randomUUID(),state:'queued',pdfSha256:undefined};}
    }
    if (this.pending.size >= 8) throw new Error('预览队列已满，请稍后重试。');
    preview = this.save({...preview,state:'queued',error:undefined,updatedAt:Date.now()});
    const id = preview.id;
    const task = this.generationQueue.catch(()=>{}).then(()=>this.generate(preview,source,description!)).finally(()=>this.pending.delete(id));
    this.generationQueue=task;
    this.pending.set(id,task); return preview;
  }

  private async generate(preview: Preview, source: ArtifactVersion, description: RuntimeDescription) {
    try {
      if (!description.available || !description.operations.includes('convert')) throw new Error('文档转换暂不可用，请稍后重试。');
      const recipe = {source:source.sha256,renderingIdentity:description.renderingIdentity,runtimeIdentity:description.runtimeIdentity,
        version:description.version,packages:description.packages,tools:description.tools,fonts:description.fonts,format:'pdf',parameters:'office-default-v1'};
      const key = preview.cacheKey!;
      await mkdir(this.directory,{recursive:true,mode:0o700});
      const cached = prepareSql(this.db,'SELECT sha256,pages,record FROM document_preview_cache WHERE key=?').get(key) as {sha256:string;pages:number;record:string}|undefined;
      if (cached) {
        try {
          await this.pdfBytes(cached.sha256,async()=>(await snapshotFile(this.directory,cached.sha256+'.pdf',256*1024*1024)).bytes);
          prepareSql(this.db,'UPDATE document_preview_cache SET used_at=? WHERE key=?').run(Date.now(),key);
          this.save({...preview,state:'ready',cacheKey:key,pdfSha256:cached.sha256,totalPages:cached.pages,warnings:JSON.parse(cached.record).warnings,updatedAt:Date.now()}); return;
        } catch { /* Missing derivatives are rebuilt from the saved input. */ }
      }
      this.save({...preview,state:'generating',cacheKey:key,updatedAt:Date.now()});
      const result = await this.run(await this.files.readArtifactVersion(source.versionId), {operation:'convert',format:'pdf',outputName:'preview.pdf'});
      if(result.checks.runtimeIdentity && result.checks.runtimeIdentity!==description.runtimeIdentity)throw new Error('Rendering runtime changed during conversion');
      const pdf = result.files.find(file=>file.mime==='application/pdf');
      if (!pdf) throw new Error('未能生成文档预览。');
      const path = await ordinaryPath(this.directory,pdf.sha256+'.pdf',true);
      try {await writeFile(path,pdf.bytes,{mode:0o600,flag:'wx'});}
      catch(error) {if((error as NodeJS.ErrnoException).code!=='EEXIST' || hash((await snapshotFile(this.directory,pdf.sha256+'.pdf',256*1024*1024)).bytes)!==pdf.sha256)throw error;}
      prepareSql(this.db,'INSERT OR REPLACE INTO document_preview_cache VALUES (?,?,?,?,?)').run(key,pdf.sha256,result.totalPages,JSON.stringify({recipe,warnings:result.warnings}),Date.now());
      this.remember(pdf.sha256,pdf.bytes);
      this.save({...preview,state:'ready',cacheKey:key,pdfSha256:pdf.sha256,totalPages:result.totalPages??undefined,warnings:result.warnings,updatedAt:Date.now()});
    } catch (error) {
      if (!this.closed) this.save({...preview,state:'failed',error: error instanceof Error && /PASSWORD/.test(error.message) ? '文件已加密，请提供可读取的副本。' : error instanceof Error && /FONT/.test(error.message) ? '文档字体不可用，请重试或下载原件。' : '预览生成失败，请重试或下载原件。',updatedAt:Date.now()});
    }
  }
  async acceptRendered(versionId:string,pdf:Buffer,totalPages:number,runtimeIdentity:string,rendererHash:string) {
    const source=this.files.artifactVersion(versionId),description=await this.describe();
    const helper=description.helpers?.render_docx as {sha256?:string}|undefined;
    if(description.runtimeIdentity!==runtimeIdentity || helper?.sha256!==rendererHash || !Number.isInteger(totalPages) || totalPages<1 || totalPages>10000 || !pdf.subarray(0,5).equals(Buffer.from('%PDF-')))throw new Error('渲染来源不匹配。');
    const recipe={source:source.sha256,renderingIdentity:description.renderingIdentity,runtimeIdentity:description.runtimeIdentity,version:description.version,packages:description.packages,tools:description.tools,fonts:description.fonts,format:'pdf',parameters:'office-default-v1'};
    const key=hash(JSON.stringify(recipe)),sha256=hash(pdf);await mkdir(this.directory,{recursive:true,mode:0o700});
    try {await writeFile(join(this.directory,sha256+'.pdf'),pdf,{flag:'wx',mode:0o600});}
    catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    prepareSql(this.db,'INSERT OR REPLACE INTO document_preview_cache VALUES (?,?,?,?,?)').run(key,sha256,totalPages,JSON.stringify({recipe,warnings:[]}),Date.now());
    this.remember(sha256,pdf);
    return this.save({id:randomUUID(),versionId,sourceSha256:source.sha256,name:source.name,state:'ready',cacheKey:key,pdfSha256:sha256,totalPages,warnings:[],updatedAt:Date.now()});
  }
  async read(id: string) {
    const preview = this.get(id);
    if (preview.state !== 'ready') throw new Error('预览尚未就绪。');
    const sha256=preview.pdfSha256;if(!sha256)throw new Error('预览校验信息缺失，请重新生成。');
    const bytes = await this.pdfBytes(sha256,async()=>!preview.cacheKey
      ? (await this.files.readArtifactVersion(preview.versionId)).bytes
      : (await snapshotFile(this.directory,sha256+'.pdf',256*1024*1024)).bytes);
    if(preview.cacheKey)prepareSql(this.db,'UPDATE document_preview_cache SET used_at=? WHERE sha256=?').run(Date.now(),sha256);
    return {bytes,name:preview.name.replace(/\.[^.]+$/,'.pdf'),mime:'application/pdf',sha256};
  }
  async pdf(versionId: string, signal?: AbortSignal) {
    const preview = await this.start(versionId,true);
    await this.pending.get(preview.id); signal?.throwIfAborted();
    return {preview:this.get(preview.id),file:await this.read(preview.id)};
  }
  /** Render detached source bytes in the execution environment for preview only. */
  private async run(source: {name:string;bytes:Buffer;sha256:string}, options: Omit<PreviewRequest,'workspaceRoot'|'inputPath'|'outputDirectory'>, signal?: AbortSignal) {
    if (this.closed) throw new Error('文档服务正在关闭。');
    if (this.active >= 2) {
      if (this.waiting.length >= 8) throw new Error('文档队列已满。');
      await new Promise<void>(resolve=>this.waiting.push(resolve));
    } else this.active++;
    const root = join(await this.files.derivativeRoot(),randomUUID());
    try {
      signal?.throwIfAborted();
      await mkdir(join(root,'inputs'),{recursive:true});
      await writeFile(join(root,'inputs',workspaceName(source.name)),source.bytes,{flag:'wx'});
      const result = await this.runtime.execute({...options,workspaceRoot:root,inputPath:join(root,'inputs',source.name),outputDirectory:join(root,'outputs',randomUUID())});
      if (result.inputSha256!==source.sha256) throw new Error('文档处理结果与快照不一致。');
      const output: Array<DocumentResult['files'][number]&{bytes:Buffer}> = [];
      for (const file of result.files) {
        const path = file.path.startsWith(root) ? file.path.slice(root.length+1).replaceAll('\\','/') : '';
        if (!path) throw new Error('文档结果路径无效。');
        const {bytes}=await snapshotFile(root,path,256*1024*1024);
        if (hash(bytes)!==file.sha256) throw new Error('文档结果校验失败。');
        output.push({...file,bytes});
      }
      return {...result,files:output};
    } finally {
      await rm(root,{recursive:true,force:true}).catch(()=>{});
      const next=this.waiting.shift(); if(next)next(); else this.active--;
    }
  }
  async cleanup() {
    if (this.pending.size) return;
    const rows=prepareSql(this.db,'SELECT key,sha256 FROM document_preview_cache WHERE used_at<? LIMIT 50').all(Date.now()-7*86400000) as Array<{key:string;sha256:string}>;
    for(const {key,sha256} of rows) {
      if (!/^[a-f0-9]{64}$/.test(key)) continue;
      prepareSql(this.db,'DELETE FROM document_preview_cache WHERE key=?').run(key);
      if(!prepareSql(this.db,'SELECT 1 FROM document_preview_cache WHERE sha256=?').get(sha256))
        await rm(await ordinaryPath(this.directory,sha256+'.pdf',true),{force:true});
    }
  }
  async close() { this.closed=true; this.buffers.clear(); await Promise.allSettled([...this.pending.values(),...this.bufferReads.values()]); }
}
