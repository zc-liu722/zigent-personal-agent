import { z } from "zod";
import sharp from "sharp";
import type { BrowserService } from "../browser/service.js";
import { isVisualObservation } from "../browser/observation.js";
import type { FileWorkbench } from "../file-workbench/service.js";
import { discoverPageImages, readPublicMedia } from "../media/public-images.js";
import type { AgentToolRegistration } from "./tool-contracts.js";

const inputSchema = z.object({action:z.enum(["webpage","inspect","present"]),id:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(),
  url:z.string().url().max(4096).optional(),sourceUrl:z.string().url().max(4096).optional(),path:z.string().min(1).max(2048).optional(),
  environment_id:z.string().uuid().optional(),assetId:z.string().uuid().optional(),observation:z.string().uuid().optional(),ref:z.string().regex(/^e\d+$/).optional(),
  after:z.string().trim().min(1).max(500).optional(),alt:z.string().trim().min(1).max(500).optional(),caption:z.string().trim().min(1).max(300).optional()}).strict();
export function createImageAssetsTool(workbench?:FileWorkbench,browser?:BrowserService):AgentToolRegistration {
  const string={type:"string"};
  return {executionMode:"sequential",definition:{type:"function",name:"image_assets",
    description:"Retrieve, inspect and present real images at their corresponding reply paragraphs. webpage(url) discovers img/srcset/lazy/metadata images from a public source page without a browser. Use actual image URLs supplied by web_search results, webpage discovery or browser observations; never invent URLs. inspect loads actual pixels for model review WITHOUT showing the image to the user, returning a temporary assetId for this reply. present requires stable id, alt and after (the exact full visible paragraph/heading that explains THIS image; emit it before the call; prefer a short heading without equations). Supply exactly one source: url (original image; sourceUrl=source page), path (working image, with environment_id for an explicit owner), assetId (candidate from this reply or a delivered snapshot from this conversation), or observation+ref (capture that actual browser img/canvas/svg/figure, including dynamic/authenticated images). Browser capture is a screenshot, not the original. Only selected snapshots persist in the conversation independently of workspace temporary files. Reuse id to update one figure; use independent ids/after for independent figures. No image generation. Do not use Markdown external image links or HTML to display images. For crop/render iterations use exec_command with cache=render, inspect with view_image and present only the selected image. Normal file delivery stays in artifact_files.",
    input_schema:{type:"object",additionalProperties:false,required:["action"],properties:{action:{type:"string",enum:["webpage","inspect","present"]},id:{...string,pattern:"^[a-zA-Z0-9_-]{1,64}$"},url:string,sourceUrl:string,path:string,environment_id:{...string,format:"uuid"},assetId:{...string,format:"uuid"},observation:{...string,format:"uuid"},ref:string,after:{...string,maxLength:500},alt:{...string,maxLength:500},caption:{...string,maxLength:300}}}},
    activity:{started:()=>({title:"整理图片",message:"我正在获取并整理图片。"}),completed:(input)=>({title:"整理图片",message:(input as {action?:string}).action==="webpage"?"我已读取网页中的图片地址。":(input as {action?:string}).action==="inspect"?"我已查看图片内容。":"我已将图片放到对应说明处。"}),failed:()=>({title:"整理图片",message:"这次图片获取或展示未完成。"})},
    async execute(raw,context) {
      const input=inputSchema.parse(raw);
      if(!context.imageAssets || !context.presentOutput || !context.replyId || context.subagent || context.taskRunId || context.backgroundTaskKind)throw new Error("当前对话不支持图片交付。");
      context.signal?.throwIfAborted();
      if(input.action==="webpage") {
        if(!input.url)throw new Error("请提供来源网页地址。");
        return {...await discoverPageImages(input.url,context.signal),trust:"untrusted_reference",next:"Choose relevant original URLs and present each under its own explanatory paragraph. An empty result does not prove the page has no images; dynamic content may require browser observation."};
      }
      if(input.action==="present" && (!input.id || !input.after || !input.alt))throw new Error("展示图片需要 id、alt 和对应正文段落 after；请先写出该段落。");
      const normalize=(text:string)=>text.normalize("NFKC").replace(/^\s{0,3}#{1,6}\s+/gm,"").replace(/\[([^\]]+)\]\([^)]*\)/g,"$1").replace(/[*_`~]/g,"").replace(/\s+/g," ").trim();
      const anchor=normalize(input.after ?? "");
      const matches=(context.visibleReplyText?.() ?? []).flatMap(text=>text.split(/\n\s*\n/)).filter(text=>normalize(text)===anchor);
      if(input.action==="present" && matches.length!==1)throw new Error("图片位置未匹配到唯一的已发送段落。请先写出独立说明段落，再把完整可见文字作为 after；不要统一放到文末。");
      if([input.url,input.path,input.assetId,input.observation||input.ref].filter(Boolean).length!==1)throw new Error("请只选择一种图片来源。");
      let image;
      if(input.assetId)image=context.imageAssets.get(context.replyId,input.assetId);
      else if(input.path) {
        if(!workbench)throw new Error("文件工作区尚未配置。");
        const workspace = await workbench.resolveWorkingDirectory(context, { environmentId: input.environment_id, path: input.path });
        const path=await workbench.execution.workspaceRelativePath(workspace,input.path);
        const bytes=await workbench.execution.readRemoteFile(workspace,path);
        image=await context.imageAssets.saveCandidate(context.replyId,bytes,{sourceKind:"workspace"},context.signal);
      } else if(input.url) {
        const source=input.sourceUrl ?? input.url;
        const resource=await readPublicMedia(input.url,"image",context.signal,source);
        image=await context.imageAssets.saveCandidate(context.replyId,resource.bytes,{sourceKind:"web",sourceUrl:source},context.signal);
      } else {
        if(!browser || !input.observation || !input.ref)throw new Error("请提供最新的网页观察编号和图片元素引用。");
        const result=await browser.execute(context,{action:"capture_image",observation:input.observation,ref:input.ref});
        if(!isVisualObservation(result) || !result.images[0])throw new Error("网页图片尚未获取，请先检查浏览器状态。");
        image=await context.imageAssets.saveCandidate(context.replyId,result.images[0].data,{sourceKind:"screenshot",sourceUrl:(result.metadata as {sourceUrl:string}).sourceUrl},context.signal);
      }
      context.signal?.throwIfAborted();
      if(input.action==="inspect") {
        const data=await sharp(context.imageAssets.read(context.replyId,image.assetId),{limitInputPixels:40_000_000}).resize({width:2400,height:2400,fit:"inside",withoutEnlargement:true}).png().timeout({seconds:10}).toBuffer();
        context.signal?.throwIfAborted();
        return {kind:"visual_observation",id:image.assetId,metadata:{...image,status:"inspected",next:"Use this assetId with present and the corresponding paragraph after to show only the chosen image. Inspection pixels fit within 2400px; present reuses the saved snapshot."},images:[{data,mimeType:"image/png",observationId:image.assetId}]};
      }
      const delivered = await context.presentOutput({id:input.id!,title:input.caption?.slice(0,120) ?? input.alt!.slice(0,120),blocks:[{type:"image",after:input.after!,
        assetId:image.assetId,alt:input.alt!,caption:input.caption,width:image.width,height:image.height,sourceKind:image.sourceKind,sourceUrl:image.sourceUrl}]});
      const block = delivered?.blocks[0];
      if (block?.type !== "image") throw new Error("图片交付尚未完成。");
      return {status:"presented",...image,assetId:block.assetId,after:input.after,next:"Continue with new information. This image is already displayed; do not append it again or repeat delivered prose."};
    }};
}
