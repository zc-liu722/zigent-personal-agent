import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute, extname } from 'node:path';
import type { ExecutionService } from '../execution/service.js';
import type { PreviewRequest, DocumentResult, RuntimeDescription, PreviewRuntime } from './document-types.js';

/** Internal preview renderer; authoring is performed by command tools and skills. */
export class ExecutionPreviewRuntime implements PreviewRuntime {
  constructor(private readonly execution:ExecutionService) {}
  close() {}
  async describe():Promise<RuntimeDescription> {
    const health=await this.execution.describe(true),cap='capabilities' in health?health.capabilities:undefined;
    return {version:'zigent-documents-v1',available:Boolean(health.available && cap?.commandRuntime?.engine==='zigent-native' && cap.helpers?.render_docx),
      python:cap?.python?.command??'',packages:cap?.packages??{},tools:cap?.tools??{},operations:['convert'],fonts:cap?.fonts??{cjk:false,names:[]},
      ...('runtimeIdentity' in health?{runtimeIdentity:health.runtimeIdentity,renderingIdentity:health.runtimeIdentity}:{}),helpers:cap?.helpers};
  }
  async execute(request:PreviewRequest):Promise<DocumentResult> {
    const input=relative(request.workspaceRoot,request.inputPath);
    if(input.startsWith('..') || isAbsolute(input) || request.operation!=='convert' || request.format!=='pdf')throw new Error('PREVIEW_CONVERSION_ONLY');
    const bytes=await readFile(request.inputPath),sha256=createHash('sha256').update(bytes).digest('hex');
    const extension=extname(request.inputPath).toLowerCase();
    if(!/^\.(docx?|pptx?|xlsx?|odt|odp|ods)$/.test(extension))throw new Error('PREVIEW_FORMAT_UNSUPPORTED');
    const result=await this.execution.derivePreview(bytes,'source'+extension,sha256);
    const pdf=Buffer.from(result.pdf,'base64');
    if(createHash('sha256').update(pdf).digest('hex')!==result.sha256 || !pdf.subarray(0,5).equals(Buffer.from('%PDF-')))throw new Error('PREVIEW_CONTENT_MISMATCH');
    await mkdir(request.outputDirectory,{recursive:true});const path=join(request.outputDirectory,'preview.pdf');await writeFile(path,pdf,{flag:'wx'});
    return {operation:'convert',operationId:randomUUID(),inputSha256:sha256,processedPages:[],totalPages:result.totalPages,
      files:[{path,name:'preview.pdf',mime:'application/pdf',size:pdf.length,sha256:result.sha256}],warnings:result.warnings,checks:{runtimeIdentity:result.runtimeIdentity}};
  }
}
