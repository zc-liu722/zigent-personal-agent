import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FileWorkbench } from "../file-workbench/service.js";
import { data, json, type WebRoute } from "./http.js";
import type { WebStore } from "./store.js";
import { isDocumentPreview } from "../file-workbench/previews.js";

const id = z.string().uuid();
const relativePath = z.string().min(1).max(1024);
const integer = (value: string | null, fallback: number, maximum: number) => z.coerce.number().int().min(0).max(maximum).parse(value ?? fallback);
const bytes = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, file: { bytes: Buffer; name: string; mime: string; sha256: string }, preview = false) => {
  const inline = preview && /^(application\/pdf|image\/(png|jpeg|webp|gif)|text\/plain(?:;|$))/.test(file.mime);
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
  res.setHeader("Cache-Control", "private, max-age=0, must-revalidate"); res.setHeader("Vary", "Cookie");
  res.setHeader("ETag", `"${file.sha256}"`); res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; frame-ancestors 'self'");
  res.setHeader("Content-Type", file.mime); res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.headers["if-none-match"] === `"${file.sha256}"`) { res.writeHead(304); res.end(); return; }
  let start = 0, end = file.bytes.length - 1, status = 200;
  if (req.headers.range) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!range || !range[1] && !range[2]) { res.writeHead(416, { "Content-Range": `bytes */${file.bytes.length}` }); res.end(); return; }
    if (!range[1]) start = Math.max(0, file.bytes.length - Number(range[2]));
    else { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= file.bytes.length) { res.writeHead(416, { "Content-Range": `bytes */${file.bytes.length}` }); res.end(); return; }
    status = 206; res.setHeader("Content-Range", `bytes ${start}-${end}/${file.bytes.length}`);
  }
  const output = file.bytes.subarray(start,end+1); res.setHeader("Content-Length",output.length); res.writeHead(status); res.end(req.method === "HEAD" ? undefined : output);
};

/** Invoked only after the channel's cookie + same-origin mutation checks. */
export function createFileWorkbenchRoutes(service: FileWorkbench | undefined, store: WebStore) {
  const streams = new Set<import("node:http").ServerResponse>();
  const handle: WebRoute = async ({ route, req, res, url, credential }) => {
    if (!route.startsWith("api/workbench")) return false;
    if (!service) { json(res,503,{error:"文件工作区尚未启用。"}); return true; }
    try {
      const suffix = route.slice("api/workbench".length);
      if (!suffix && req.method === "GET") {
        const defaultWorkspaceId=await service.defaultWorkspace();
        const shares = service.files.listShares().map(share => {
          let name: string | undefined;
          try { if (share.kind === "version") name = service.files.artifactVersion(share.resourceId).name; } catch { /* Revocation can race a list. */ }
          return {...share,direction:share.targetAgentId === service.config.id ? "incoming":"outgoing",name};
        });
        json(res,200,{agentId:service.config.id,currentAgentId:service.config.id,workspaces:service.files.listWorkspaces(),artifacts:service.files.listArtifacts(undefined,"artifact",0,20),originals:service.originals(),
          jobs:service.execution.list(),shares,peers:await service.peers(),defaultWorkspaceId,storage:await service.storage()}); return true;
      }
      if (suffix === "/artifacts" && req.method === "GET") {
        const workspaceId=url.searchParams.has("workspaceId")?id.parse(url.searchParams.get("workspaceId")):undefined;
        const kind=z.enum(["artifact","original","all"]).parse(url.searchParams.get("kind")??"artifact");
        json(res,200,service.files.listArtifactPage(workspaceId,kind,integer(url.searchParams.get("offset"),0,Number.MAX_SAFE_INTEGER),
          z.coerce.number().int().min(1).max(500).parse(url.searchParams.get("limit")??100)));return true;
      }
      if (suffix === "/runtime" && req.method === "GET") { json(res,200,await service.describe()); return true; }
      if (suffix === "/workspaces" && req.method === "POST") {
        const input=z.object({name:z.string().trim().min(1).max(160)}).strict().parse(await data(req,2048));
        json(res,201,await service.files.createWorkspace(input)); return true;
      }
      const workspaceRoute=/^\/workspaces\/([^/]+)\/(files|file|download|select)$/.exec(suffix);
      if (workspaceRoute) {
        const workspaceId=id.parse(workspaceRoute[1]), action=workspaceRoute[2];
        service.files.workspace(workspaceId);
        if (action === "files" && req.method === "GET") { json(res,200,await service.execution.listWorkingFiles(workspaceId,url.searchParams.get("path")??".",integer(url.searchParams.get("offset"),0,1_000_000),100)); return true; }
        if (action === "file" && req.method === "GET") { json(res,200,await service.workingText(workspaceId,relativePath.parse(url.searchParams.get("path")),integer(url.searchParams.get("offset"),0,100_000_000),integer(url.searchParams.get("limit"),64000,64000))); return true; }
        if (action === "download" && ["GET","HEAD"].includes(req.method??"")) { bytes(req,res,await service.workingFile(workspaceId,relativePath.parse(url.searchParams.get("path")))); return true; }
        if (action === "file" && req.method === "PUT") {
          const input=z.object({path:relativePath,text:z.string().max(1_000_000),expectedHash:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict().parse(await data(req,4_100_000));
          service.assertIdle(workspaceId); json(res,200,await service.files.writeFile(workspaceId,input.path,Buffer.from(input.text),input.expectedHash)); return true;
        }
        if (action === "select" && req.method === "POST") {
          const input=z.object({conversationId:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(await data(req,1024));
          const conversation=store.resolveConversation(input.conversationId), info=conversation?store.conversationInfo(conversation):undefined;
          if (!info?.sessionId) throw new Error("请先在对话中发送消息后选择项目。");
          json(res,200,service.selectWorkspace(info.sessionId,workspaceId)); return true;
        }
      }
      if (suffix==="/previews" && req.method==="POST") {
        const input=z.object({versionId:id.optional(),workspaceId:id.optional(),path:relativePath.optional(),uploadId:id.optional(),retry:z.boolean().optional()}).strict()
          .refine(value=>Number(Boolean(value.versionId))+Number(Boolean(value.workspaceId&&value.path))+Number(Boolean(value.uploadId))===1).parse(await data(req,4096));
        let versionId=input.versionId;
        if(input.workspaceId&&input.path) versionId=(await service.snapshotWorkingFile(input.workspaceId,input.path)).versionId;
        if(input.uploadId) {
          const metadata=store.documentMetadata([input.uploadId])[input.uploadId];
          if(!metadata)throw new Error("附件不存在。");
          const retained=await service.retainedUpload(input.uploadId,metadata.sha256);
          if(retained)versionId=retained.versionId;
          else {
            const asset=store.asset(input.uploadId);if(!asset)throw new Error("附件不存在。");
            versionId=(await service.retainUpload({...metadata,id:input.uploadId,bytes:Buffer.from(asset.bytes)})).versionId;
          }
        }
        json(res,202,await service.previews.start(versionId!,input.retry)); return true;
      }
      const previewRoute=/^\/previews\/([^/]+)(?:\/(pdf|download))?$/.exec(suffix);
      if(previewRoute && ["GET","HEAD"].includes(req.method??"")) {
        const previewId=id.parse(previewRoute[1]);
        if(previewRoute[2]==="pdf") bytes(req,res,await service.previews.read(previewId),true);
        else if(previewRoute[2]==="download") bytes(req,res,await service.files.readArtifactVersion(service.previews.get(previewId).versionId));
        else json(res,200,service.previews.get(previewId)); return true;
      }
      const versionRoute=/^\/versions\/([^/]+)\/(download|preview)$/.exec(suffix);
      if(versionRoute && ["GET","HEAD"].includes(req.method??"")){
        const versionId=id.parse(versionRoute[1]),metadata=service.files.artifactVersion(versionId);
        if(versionRoute[2]==="preview" && isDocumentPreview(metadata.name)) bytes(req,res,(await service.previews.pdf(versionId)).file,true);
        else bytes(req,res,await service.files.readArtifactVersion(versionId),versionRoute[2]==="preview");return true;
      }
      const versions=/^\/files\/([^/]+)\/versions$/.exec(suffix);
      if(versions && req.method==="GET"){json(res,200,{versions:service.files.listVersions(id.parse(versions[1]))});return true;}
      if(suffix==="/shares" && req.method==="POST"){
        const input=z.object({versionId:id.optional(),workspaceId:id.optional(),targetAgent:z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)}).strict()
          .refine(value=>Boolean(value.versionId)!==Boolean(value.workspaceId)).parse(await data(req,2048));
        json(res,201,await service.share(input.versionId??input.workspaceId!,input.targetAgent,randomUUID(),Boolean(input.workspaceId)));return true;
      }
      const sharing=/^\/shares\/([^/]+)(?:\/(files|copy))?$/.exec(suffix);
      if(sharing){
        const grantId=id.parse(sharing[1]);
        if(!sharing[2] && req.method==="DELETE"){service.files.revokeShare(grantId,store.owner);json(res,200,{ok:true});return true;}
        if(sharing[2]==="files" && req.method==="GET"){json(res,200,await service.files.sharedWorkspaceFiles(grantId,url.searchParams.get("path")??".",integer(url.searchParams.get("offset"),0,1_000_000),100));return true;}
        if(sharing[2]==="copy" && req.method==="POST"){
          const input=z.object({workspaceId:id,path:relativePath.optional()}).strict().parse(await data(req,4096));service.assertIdle(input.workspaceId);
          json(res,201,input.path?await service.files.copySharedWorkspaceFile(grantId,input.path,input.workspaceId):await service.files.copySharedVersion(grantId,input.workspaceId));return true;
        }
      }
      const jobRoute=/^\/jobs\/([^/]+)(?:\/(cancel|stdin|recover))?$/.exec(suffix);
      if(jobRoute){
        const jobId=id.parse(jobRoute[1]);
        if(!jobRoute[2]&&req.method==="GET"){json(res,200,await service.execution.read(jobId,integer(url.searchParams.get("offset"),0,Number.MAX_SAFE_INTEGER),16000));return true;}
        if(jobRoute[2]==="cancel"&&req.method==="POST"){json(res,200,await service.execution.cancel(jobId));return true;}
        if(jobRoute[2]==="recover"&&req.method==="POST"){json(res,200,await service.execution.recover(jobId));return true;}
        if(jobRoute[2]==="stdin"&&req.method==="POST"){const input=z.object({text:z.string().max(64000)}).strict().parse(await data(req,260000));json(res,200,await service.execution.writeStdin(jobId,input.text));return true;}
      }
      if(suffix==="/events"&&req.method==="GET"){
        if(streams.size>=8){json(res,429,{error:"打开的文件面板过多。"});return true;}
        const cursor=String(req.headers["last-event-id"]??url.searchParams.get("after")??"0:0");
        if(!/^\d{1,15}:\d{1,15}$/.test(cursor))throw new Error("事件游标无效。");
        let [fileCursor,jobCursor]=cursor.split(":").map(Number),busy=false;
        res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-store, no-transform","X-Accel-Buffering":"no"});streams.add(res);
        const update=()=>{
          if(busy||res.destroyed||res.writableEnded)return;
          if(!store.authenticate(credential)){res.end();return;}
          busy=true;
          try{
            const files=service.files.events(fileCursor),jobs=service.execution.events(jobCursor);
            fileCursor=files.at(-1)?.sequence??fileCursor;jobCursor=jobs.at(-1)?.sequence??jobCursor;
            if(files.length||jobs.length){if(!res.write(`id: ${fileCursor}:${jobCursor}\nevent: workbench\ndata: ${JSON.stringify({files,jobs})}\n\n`))res.end();}
          }finally{busy=false;}
        };
        res.write("event: ready\ndata: {}\n\n");update();
        const interval=setInterval(update,1000),heartbeat=setInterval(()=>{if(!store.authenticate(credential))res.end();else if(!res.write(": heartbeat\n\n"))res.end();},15000);
        interval.unref();heartbeat.unref();res.on("close",()=>{clearInterval(interval);clearInterval(heartbeat);streams.delete(res);});return true;
      }
      json(res,404,{error:"文件操作不存在。"});return true;
    }catch(error){json(res,error instanceof z.ZodError?400:409,{error:error instanceof z.ZodError?"文件操作参数无效。":String(error instanceof Error?error.message:error).slice(0,500)});return true;}
  };
  return {handle,close:()=>{for(const stream of streams)stream.end();streams.clear();}};
}
