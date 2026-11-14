import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type BridgeStart = { type:'start';meetingId:string;connection:number;initialGeneration?:number;livekitUrl:string;token:string;participant:string;
  apiKey:string;instructions:string;providerSessionId?:string;pendingCalls?:string[] };
const events=new Set(['ready','output_created','track_published','generation_complete','source_drained','output_invalidated',
  'cancel_ack','user_started','transcript','consultation','usage','command_ack','client_playback','output_incomplete','closing','closed','track_attached','audio_diagnostics','playback_progress']);

/** Dormant transport for the new media adapter. Existing meetings do not instantiate it. */
export class MeetingBridgeProcess {
  private child:ChildProcess;
  private closing=false;
  private killTimer?:NodeJS.Timeout;
  private callbacks:{event:(event:Record<string,unknown>)=>void;failed:(code:string)=>void};
  constructor(start:BridgeStart,callbacks:MeetingBridgeProcess['callbacks']){
    this.callbacks=callbacks;
    const release=new URL('../../release.json',import.meta.url),component=new URL('../../ops/meeting-media/release.json',import.meta.url);
    if(existsSync(release)){
      const root=JSON.parse(readFileSync(release,'utf8').replace(/^\uFEFF/,'')),media=JSON.parse(readFileSync(component,'utf8').replace(/^\uFEFF/,''));
      if(!/^[a-f0-9]{40}$/.test(root.commit)||root.commit!==media.commit)throw new Error('Media release version mismatch');
    }
    // Only OS runtime variables, never the business process's provider secrets,
    // NODE_OPTIONS, tool environment or model credentials, cross this boundary.
    const env:NodeJS.ProcessEnv={NODE_ENV:'production'};
    for(const key of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'])if(process.env[key])env[key]=process.env[key];
    this.child=fork(fileURLToPath(new URL('../../ops/meeting-media/dist/main.js',import.meta.url)),[],{
      execArgv:[],env,stdio:['pipe','ignore','ignore','ipc'],serialization:'json'
    });
    this.child.on('error',()=>this.fail('bridge_process'));
    this.child.on('exit',()=>{clearTimeout(this.killTimer);if(!this.closing)this.fail('bridge_exit');});
    this.child.stdin?.on('error',()=>this.fail('bridge_pipe'));
    this.child.on('message',(value:unknown)=>{
      if(!value||typeof value!=='object'||Array.isArray(value))return;
      const e=value as Record<string,unknown>,version=e.version as Record<string,unknown>|undefined;
      if(this.closing&&!['closing','closed'].includes(String(e.type)))return;
      if(typeof e.type!=='string'||!events.has(e.type)||e.meetingId!==start.meetingId||version?.connection!==start.connection
        ||!Number.isSafeInteger(version?.utterance)||Number(version?.utterance)<0||!Number.isSafeInteger(version?.output)||Number(version?.output)<0
        ||Buffer.byteLength(JSON.stringify(e))>512*1024){this.fail('bridge_protocol');return;}
      try{callbacks.event(e);if(e.type==='closed')this.closing=true;}catch{this.fail('bridge_event');}
    });
    this.send(start);
  }
  send(value:object){
    if(this.closing)return;
    const line=JSON.stringify(value)+'\n',input=this.child.stdin;
    if(!input||input.destroyed||Buffer.byteLength(line)>512*1024||input.writableLength+Buffer.byteLength(line)>512*1024){this.fail('bridge_backpressure');return;}
    input.write(line);
  }
  private fail(code:string){if(this.closing)return;this.close();this.callbacks.failed(code);}
  close(){
    if(this.closing)return;this.closing=true;
    // EOF gives the bridge a bounded supplier close handshake; forced process
    // termination cannot keep an orphan media room alive indefinitely.
    this.child.stdin?.end();
    this.killTimer=setTimeout(()=>this.child.kill('SIGKILL'),4000);this.killTimer.unref();
  }
}
