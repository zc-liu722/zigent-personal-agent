import { z } from 'zod';
import type { FileWorkbench } from '../file-workbench/service.js';
import type { AgentToolRegistration, ToolExecutionContext } from './tool-contracts.js';
import type { ToolActivityPresenter } from './activity-presentation.js';
import { commandFileActivity, fileActivity, patchFileActivity } from './file-activity.js';
import { patchFileDiff, resultFileDiff, withFileDiff } from '../file-diff.js';

const environment = z.string().uuid().optional();
const budget = z.number().int().min(1).max(16000).optional();
const command = z.object({cmd:z.string().min(1).max(64000),workdir:z.string().max(1024).optional(),shell:z.enum(['pwsh','powershell','cmd','/bin/bash','/bin/sh']).optional(),login:z.boolean().optional(),tty:z.boolean().optional(),timeout_ms:z.number().int().min(1000).max(86400000).optional(),yield_time_ms:z.number().int().min(250).max(30000).optional(),max_output_tokens:budget,environment_id:environment}).strict();
const stdin = z.object({session_id:z.number().int().positive(),chars:z.string().max(64000).optional(),yield_time_ms:z.number().int().min(0).max(300000).optional(),max_output_tokens:budget}).strict();
const patch = z.object({input:z.string().min(1).max(1000000),environment_id:environment}).strict();
const image = z.object({path:z.string().min(1).max(1024),detail:z.enum(['high','original']).optional(),environment_id:environment}).strict();
const number = {type:'integer'}, string = {type:'string'}, boolean = {type:'boolean'};
const env = {type:'string',format:'uuid',description:'Execution environment ID from the conversation context. Omit for the active environment.'};
const maxTokens = {type:'integer',minimum:1,maximum:16000,description:'Maximum returned output tokens; defaults to 10000.'};
const activity=(title:string,subject:string,showCommand=false):ToolActivityPresenter=>{
  const heading=(input:unknown,result?:unknown)=>{
    if(title==='修改文件')return {...patchFileActivity(input),...(resultFileDiff(result)?{diff:resultFileDiff(result)}:{})};
    if(title==='查看图片')return fileActivity('read',[(input as {path?:string})?.path??''],'查看');
    const cmd=showCommand&&input&&typeof input==='object'&&'cmd' in input?input.cmd:undefined;
    return typeof cmd==='string'&&cmd.trim()
      ?{title:cmd.split(/\r?\n/).find(line=>line.trim())!.trim(),command:cmd,...commandFileActivity(cmd)}:{title};
  };
  const subjectFor=(presentation:ReturnType<typeof heading>)=>'fileOperation' in presentation&&presentation.fileOperation==='read'?'阅读文件':'fileOperation' in presentation&&presentation.fileOperation==='edit'?'编辑文件':subject;
  return {
    started:(input)=>{const presentation=heading(input);return {...presentation,message:`我正在${subjectFor(presentation)}。`};},
    completed:(input,result)=>{const presentation=heading(input,result),value=result as {session_id?:number;exit_code?:number;execution_state?:string;error?:string;interrupt_requested?:boolean};return {...presentation,message:value.interrupt_requested?(value.session_id?'已发送中断，程序仍在运行。':'已发送中断，程序已结束，已保留可确认的结果。'):value.session_id?"程序仍在运行，已保留继续读取和输入的入口。":(value.execution_state==="interrupted"||value.execution_state==="cancelled")?"程序已中断，已保留能够确认的执行结果。":value.error||value.exit_code!==undefined&&value.exit_code!==0?"程序已结束，返回了需要处理的错误。":`我已完成${subjectFor(presentation)}。`};},
    failed:(input)=>{const presentation=heading(input);return {...presentation,message:`这次${subjectFor(presentation)}未完成。`};}
  };
};
export function createCommandTools(service?:FileWorkbench):AgentToolRegistration[] {
  function register<T>(name:string,description:string,schema:z.ZodType<T>,properties:Record<string,unknown>,required:string[],presenter:ToolActivityPresenter,
    run:(input:T,context:ToolExecutionContext,api:FileWorkbench)=>Promise<unknown>):AgentToolRegistration {
    return {available:Boolean(service),executionMode:name==='apply_patch'?'sequential':'parallel',definition:{type:'function',name,description,input_schema:{type:'object',additionalProperties:false,properties,required}},activity:presenter,
      async execute(input,context){if(!service)throw new Error('文件工作区尚未配置。');service.assertAccess(context);return run(schema.parse(input),context,service);}};
  }
  return [
    register('exec_command','Runs a shell command using the bundled Zigent execution module, returning output or a session_id for ongoing interaction. Use the platform, shell and workspace path provided by the execution context. Windows defaults to pwsh without profiles; cmd/powershell are explicit alternatives. cmd currently accepts ASCII command text only; use pwsh for Unicode. Programs should emit UTF-8 output. Bash and Linux paths are accepted only by a reported Linux backend. Windows pipe Ctrl-C terminates its Job; PTY Ctrl-C sends a terminal interrupt; the program may handle it and on Windows PowerShell can return exit code 0 even after interruption. Inspect output and execution state; do not infer normal success from that code alone. Sessions share persistent environment files. Use ordinary commands to read/search files and run document libraries or skill scripts; use apply_patch to edit source. tty=true allocates a real PTY for interactive input. Poll running sessions with write_stdin; a yield does not terminate the process. No account login or model delegation is involved.',command,
      {cmd:{...string,maxLength:64000},workdir:string,shell:{type:'string',enum:['pwsh','powershell','cmd','/bin/bash','/bin/sh']},login:boolean,tty:boolean,timeout_ms:{...number,minimum:1000,maximum:86400000,description:'Command lifetime limit in milliseconds, separate from the response wait; defaults to one day.'},yield_time_ms:{...number,minimum:250,maximum:30000},max_output_tokens:maxTokens,environment_id:env},['cmd'],activity('运行程序','运行程序',true),
      async(input,context,api)=>api.execution.execCommand(input.environment_id??await api.activeWorkspace(context.sessionId),input,{sessionId:context.sessionId,turnId:context.turnId,signal:context.signal})),
    register('write_stdin','Writes characters to an existing command session and returns only new output. Empty chars polls without writing. Use the session_id returned by exec_command. Send Ctrl-C (\\u0003) to request interruption. interrupt_requested confirms the input request, not guaranteed termination; poll until the command ends. On Windows, PowerShell may return exit code 0 after Ctrl-C; inspect the output. The session belongs to this conversation and survives frontend disconnections; never repeat a command whose outcome is unknown.',stdin,
      {session_id:{...number,minimum:1},chars:string,yield_time_ms:{...number,minimum:0,maximum:300000},max_output_tokens:maxTokens},['session_id'],activity('继续程序','读取程序输出'),
      async(input,context,api)=>api.execution.terminalInput(input.session_id,input.chars??'',context.sessionId,input.max_output_tokens,input.yield_time_ms,context.signal)),
    register('apply_patch','Edit text files using the bundled standalone patch implementation extracted from OpenAI Codex. Supply the patch text in input: *** Begin Patch, *** Add File / *** Update File / *** Delete File, optional *** Move to, hunks with context and +/- lines, *** End Patch. Paths refer to the active execution environment. On Windows, same-file or case-only moves are refused safely; use an intermediate filename. This transport uses a JSON string; patch syntax is unchanged. Read relevant source first. Binary Word/PDF files must be changed through document libraries and scripts.',patch,
      {input:{...string,maxLength:1000000},environment_id:env},['input'],activity('修改文件','修改文件'),
      async(input,context,api)=>{
        const workspace=input.environment_id??await api.activeWorkspace(context.sessionId),originals=new Map<string,string>();
        // Delete-file payloads omit their old contents; read only those named files.
        await Promise.allSettled([...input.input.matchAll(/^\*\*\* Delete File: (.+)\r?$/gm)].map(async match=>{
          const path=match[1]!.trim(),relative=await api.execution.workspaceRelativePath(workspace,path);
          const bytes=await api.execution.readRemoteFile(workspace,relative);
          if(bytes.length<=2*1024*1024)originals.set(path,new TextDecoder('utf-8',{fatal:true}).decode(bytes));
        }));
        const result=await api.execution.applyPatch(workspace,input.input,{sessionId:context.sessionId,turnId:context.turnId,signal:context.signal});
        return withFileDiff(result,patchFileDiff(input.input,originals));
      }),
    register('view_image','View a PNG/JPEG/WebP/GIF image from the execution environment, including document page renders. Provides actual image pixels to the model. Successful rendering alone is not visual review. Read the matching document skill and inspect relevant pages before delivery.',image,
      {path:string,detail:{type:'string',enum:['high','original']},environment_id:env},['path'],activity('查看图片','查看图片'),
      async(input,context,api)=>api.viewImage(input.environment_id??await api.activeWorkspace(context.sessionId),await api.execution.workspaceRelativePath(input.environment_id??await api.activeWorkspace(context.sessionId),input.path),true,input.detail==='original'))
  ];
}
