import { MeetingAudioTrace, audioMetrics } from './audio-diagnostics.js';
import { randomUUID } from 'node:crypto';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import WebSocket from 'ws';
import { MeetingBridgeProcess } from './bridge-process.js';
import { sameMediaVersion, type MeetingMedia, type MeetingMediaOptions, type MeetingMediaCommand, type MeetingConsultation } from './media.js';

export type RtcConfiguration={enabled:boolean;url:string;serverUrl:string;apiKey:string;secret:string};
type Output={sid?:string;done:boolean;drained:boolean;heard:boolean;samples:number;ended:boolean;playedSamples:number;sentSamples:number};
/** Text-only authenticated control socket. No PCM is received by Zigent. */
export class RtcMeetingMedia implements MeetingMedia {
  generation=0;userVersion=0;
  private outputs=new Map<number,Output>();
  private bridge?:MeetingBridgeProcess;
  private room?:string;
  private service:RoomServiceClient;
  private closed=false;
  private started=false;
  private providerReady=false;
  private clientJoined=false;
  private providerSessionId?:string;
  private restarts=0;
  private bridgeAttempt=0;
  private restartTimer?:NodeJS.Timeout;
  private human?:string;
  private bridgeIdentity?:string;
  private instructions='';
  private muted=false;
  private pendingCalls=new Set<string>();
  private pendingResults=new Map<string,object>();
  private lastSeen=Date.now();
  private watchdog:NodeJS.Timeout;
  private afterCancel?:()=>void;
  private cancelId?:string;
  private bridgeStats:Record<string,number>={};
  private trace:MeetingAudioTrace;
  private readonly connectedAt=Date.now();
  private stage='room';
  private failure?:string;
  private clientDiagnostics:Record<string,string|number>={};
  private readonly stats={generated:0,sourceDrained:0,clientStarted:0,clientEnded:0,estimatedEnded:0};
  constructor(private client:WebSocket,private options:MeetingMediaOptions,private config:RtcConfiguration,authenticate:()=>boolean){
    this.trace=new MeetingAudioTrace(options.agent,options.connection,'rtc');
    this.service=new RoomServiceClient(config.serverUrl,config.apiKey,config.secret,{requestTimeout:8});
    this.generation=options.initialGeneration;
    this.watchdog=setInterval(()=>{if(!this.current())return;if(!authenticate())options.finish('登录已失效',false);else if(Date.now()-this.lastSeen>20000)options.pause('会议连接已断开，可重新连接');},5000);
    client.on('message',(raw,binary)=>{
      if(!this.current())return;if(!authenticate()){options.finish('登录已失效',false);return;}
      this.lastSeen=Date.now();if(binary){options.pause('媒体协议异常，请重新连接。');return;}
      try{const e=JSON.parse(raw.toString());
        if(e.type==='rtc_connected'){this.clientJoined=true;this.maybeReady();}
        else if(e.type==='end')options.finish('用户结束会议');
        else if(e.type==='pause'){
          const d=e.rtc;
          if(d&&['rtc_transport','rtc_join','rtc_disconnected','startup_timeout'].includes(d.cause))this.clientDiagnostics.cause=d.cause;
          if(d&&['control','signaling','publish','active'].includes(d.stage))this.clientDiagnostics.stage=d.stage;
          for(const key of ['code','reason','status'])if(Number.isSafeInteger(d?.[key])&&d[key]>=0&&d[key]<=9999)this.clientDiagnostics[key]=d[key];
          options.pause('通话已暂停，可重新连接');
        }
        else if(e.type==='mute'&&typeof e.muted==='boolean')this.mute(e.muted||!options.active());
        else if(e.type==='audio-pause')options.audioPaused();
        else if(e.type==='rtc_playback')this.receipt(e);
        else if(e.type==='audio_diagnostics'&&typeof e.enabled==='boolean'){this.trace.set(e.enabled);this.command({type:'diagnostics',enabled:e.enabled});}
        else if(e.type==='rtc_stats'&&this.trace.enabled)this.trace.record('browser',e.stats);
        else if(e.type==='rtc_attached'&&e.connection===this.options.connection&&Number.isSafeInteger(e.generation)){const o=this.outputs.get(e.generation);if(o&&o.sid===e.trackSid&&typeof o.sid==='string')this.command({type:'attached',generation:e.generation,trackSid:o.sid});}
      }catch{options.pause('媒体协议异常，请重新连接。');}
    });
    client.on('close',()=>{if(this.current())options.pause('通话已断开，可重新连接');});
    client.on('error',()=>{if(this.current())options.pause('会议连接已断开，可重新连接');});
    void this.initialize().catch(()=>{if(this.current()){this.failure=`${this.stage}_setup`;options.pause('媒体服务暂不可用，请重新连接。');}});
  }
  private current(){return !this.closed&&this.options.current();}
  private sendClient(event:object){if(!this.current())return;if(this.client.readyState!==WebSocket.OPEN||this.client.bufferedAmount>256*1024){this.options.pause('控制连接拥堵，请重新连接。');return;}this.client.send(JSON.stringify(event));}
  private async initialize(){
    const room=this.room=`zm-${randomUUID()}`,human=`p-${randomUUID()}`,bridgeIdentity=`b-${randomUUID()}`;
    await this.service.createRoom({name:room,maxParticipants:2,emptyTimeout:60,departureTimeout:20});
    if(!this.current()){await this.service.deleteRoom(room).catch(()=>{});return;}
    this.stage='token';
    const token=async(identity:string,publishSources:TrackSource[])=>{const t=new AccessToken(this.config.apiKey,this.config.secret,{identity,ttl:300});t.addGrant({room,roomJoin:true,canPublish:true,canSubscribe:true,canPublishData:false,canUpdateOwnMetadata:false,canPublishSources:publishSources});return t.toJwt();};
    const [clientToken,bridgeToken]=await Promise.all([token(human,[TrackSource.MICROPHONE]),token(bridgeIdentity,[TrackSource.MICROPHONE])]);
    if(!this.current()){await this.service.deleteRoom(room).catch(()=>{});return;}
    this.human=human;this.bridgeIdentity=bridgeIdentity;this.instructions=this.options.instructions;
    this.stage='bridge';this.launchBridge(bridgeToken);
    this.stage='client';
    this.sendClient({type:'rtc_join',url:this.config.url,token:clientToken,bridgeIdentity,connection:this.options.connection});
  }
  private launchBridge(token:string){
    const attempt=++this.bridgeAttempt;
    this.bridge=new MeetingBridgeProcess({type:'start',meetingId:this.room!,connection:this.options.connection,initialGeneration:this.generation,
      livekitUrl:this.config.serverUrl.replace(/^http/,'ws'),token,participant:this.human!,apiKey:this.options.apiKey,
      instructions:this.instructions,providerSessionId:this.providerSessionId??this.options.providerSessionId,pendingCalls:[...this.pendingCalls]},{
      event:e=>{if(attempt===this.bridgeAttempt)this.event(e);},failed:code=>{if(attempt===this.bridgeAttempt)this.restart(code);}});
  }
  private restart(code:string){
    if(!this.current())return;
    const known=['provider_socket','provider_closed','provider_error','provider_protocol','provider_write','provider_control_backpressure','bridge_exit','bridge_process','bridge_pipe','bridge_protocol','bridge_event','bridge_backpressure','rtc_disconnected','connect_timeout','connect_failure','control_protocol','internal','input_backlog','input_format','input_capacity','input_age','input_backpressure','input_native','cancel_timeout','output_capacity','output_storage_capacity','output_storage_backpressure','output_storage_io','output_format','output_native','client_playback_stall','client_attach_timeout','coordinator_closed','control_backpressure','control_output','control_capacity','control_input','startup_timeout','command_capacity','tool_capacity'];
    this.failure=known.includes(code)?code:this.failure??'bridge_failure';
    this.report('recovery');
    if(!code.startsWith('provider_')&&!code.startsWith('bridge_')||this.restarts>=2){this.options.pause('语音媒体连接已中断，可重新连接');return;}
    this.restarts++;this.bridgeAttempt++;this.bridge?.close();this.providerReady=false;
    for(const [generation,o] of this.outputs)this.options.evidence?.({kind:'interrupted',generation,trackSid:o.sid,evidence:'estimated',metrics:{playedSamples:o.playedSamples,sentSamples:o.sentSamples}});
    this.outputs.clear();this.generation++;this.cancelId=undefined;this.afterCancel=undefined;
    this.sendClient({type:'rtc_clear',generation:this.generation});this.sendClient({type:'rtc_recovering'});
    this.restartTimer=setTimeout(()=>{void (async()=>{
      const t=new AccessToken(this.config.apiKey,this.config.secret,{identity:this.bridgeIdentity!,ttl:300});
      t.addGrant({room:this.room!,roomJoin:true,canPublish:true,canSubscribe:true,canPublishData:false,canPublishSources:[TrackSource.MICROPHONE]});
      const token=await t.toJwt();if(this.current())this.launchBridge(token);
    })().catch(()=>{if(this.current())this.options.pause('语音桥恢复失败，请重新连接。');});},1000);
  }
  private maybeReady(){if(this.current()&&this.providerReady&&this.clientJoined&&!this.started){this.stage='active';this.report('ready');this.options.event({type:'session.created',session:{id:this.providerSessionId}});}}
  private command(action:object,id:string=randomUUID(),expected={connection:this.options.connection,utterance:this.userVersion,output:this.generation}){
    if(this.current())this.bridge?.send({id,expected,action});return id;
  }
  get outputDone(){return this.outputs.get(this.generation)?.done===true;}
  ready(opening:string){this.started=true;this.sendClient({type:'ready',audioProtocol:6});this.command({type:'opening',text:opening});}
  update(instructions:string,command?:MeetingMediaCommand){if(command&&!sameMediaVersion(command,this.options.version()))return;this.instructions=instructions;this.command({type:'guide',instructions},command?.id);}
  toolResults(requests:MeetingConsultation[],result:object){for(const r of requests)if(this.pendingCalls.has(r.call_id))this.pendingResults.set(r.call_id,result);this.flushResults();}
  private flushResults(){if(!this.providerReady||!this.pendingResults.size)return;const entries=[...this.pendingResults];for(let i=0;i<entries.length;i+=32)this.command({type:'tool_results',items:entries.slice(i,i+32).map(([call_id,result])=>({call_id,result}))});for(const [id] of entries){this.pendingCalls.delete(id);this.pendingResults.delete(id);}}
  mute(muted:boolean){this.muted=muted;this.command({type:'mute',muted});}
  clear(){/* Native bridge has already isolated the provider's natural interruption. */}
  interrupt(then:()=>void,command?:MeetingMediaCommand){
    if(command&&!sameMediaVersion(command,this.options.version()))return;
    this.afterCancel=then;if(this.cancelId)return;
    this.trace.record('cancel',{generation:this.generation});
    this.cancelId=this.command({type:'cancel'},command?.id);
  }
  speak(text:string){this.command({type:'speak',text});}
  private event(e:Record<string,unknown>){
    if(['closing','closed','audio_diagnostics'].includes(String(e.type))){this.bridgeStats=audioMetrics(e.stats);this.trace.record('bridge',this.bridgeStats);if(e.type==='closed')this.report('bridge_closed');}
    if(!this.current())return;const version=e.version as {utterance:number;output:number};
    this.userVersion=version.utterance;this.generation=version.output;
    const generation=Number(e.generation);
    const stage={output_created:'created',track_published:'published',track_attached:'attached',generation_complete:'generated',source_drained:'sent',output_invalidated:'clear',user_started:'user_started',output_incomplete:'recovery'} as const;
    const traceEvent=stage[e.type as keyof typeof stage];if(traceEvent)this.trace.record(traceEvent,{generation,...audioMetrics(e)});
    if(e.type==='ready'){this.command({type:'diagnostics',enabled:this.trace.enabled});this.providerReady=true;this.providerSessionId=typeof e.providerSessionId==='string'?e.providerSessionId:undefined;this.flushResults();if(this.started){this.command({type:'mute',muted:this.muted});this.sendClient({type:'ready',audioProtocol:6});this.command({type:'opening',text:'连接恢复了，我们继续。'});}else this.maybeReady();}
    else if(e.type==='output_created'){this.options.evidence?.({kind:'created',generation,itemId:e.itemId as string|undefined,responseId:e.responseId as string|undefined});this.outputs.set(generation,{done:false,drained:false,heard:false,samples:0,ended:false,playedSamples:0,sentSamples:0});this.stats.generated++;}
    else if(e.type==='playback_progress'){const o=this.outputs.get(generation);if(o){o.playedSamples=Math.max(o.playedSamples,Number(e.playedSamples)||0);o.sentSamples=Number(e.sentSamples)||0;this.trace.record('progress',{generation,playedSamples:o.playedSamples,sentSamples:o.sentSamples});}}
    else if(e.type==='track_published'){const o=this.outputs.get(generation);if(o){o.sid=String(e.trackSid);this.sendClient({type:'rtc_track',generation,trackSid:o.sid,connection:this.options.connection});}}
    else if(e.type==='generation_complete'){this.options.evidence?.({kind:'generated',generation});const o=this.outputs.get(generation);if(o)o.done=true;this.sendClient({type:'rtc_generated',generation});}
    else if(e.type==='source_drained'){const o=this.outputs.get(generation);if(o){o.drained=true;o.samples=Number(e.samples);this.options.evidence?.({kind:'sent',generation,trackSid:o.sid,samples:o.samples});this.stats.sourceDrained++;this.sendClient({type:'rtc_source_drained',generation,trackSid:o.sid,samples:o.samples,sampleRate:24000});}}
    else if(e.type==='output_invalidated'){for(const [generation,o] of this.outputs)this.options.evidence?.({kind:'interrupted',generation,trackSid:o.sid,evidence:'estimated',metrics:{playedSamples:o.playedSamples,sentSamples:o.sentSamples}});this.outputs.clear();this.sendClient({type:'rtc_clear',generation:this.generation});}
    else if(e.type==='cancel_ack'&&e.id===this.cancelId){this.cancelId=undefined;const then=this.afterCancel;this.afterCancel=undefined;if(!e.stale)then?.();}
    else if(e.type==='user_started')this.options.event({type:'conversation.item.input_audio_transcription.started',item_id:e.itemId});
    else if(e.type==='transcript')this.options.event(e.event);
    else if(e.type==='consultation'){this.pendingCalls.add(String(e.call_id));this.options.event({type:'response.function_call_arguments.done',items:[{call_id:e.call_id,name:e.name,arguments:e.arguments}]});}
    else if(e.type==='usage')this.options.event({type:'response.done',response_id:e.responseId,usage:e.usage});
    else if(e.type==='output_incomplete'){this.bridgeStats=audioMetrics(e.stats);if(['output_capacity','output_storage_capacity','output_storage_backpressure','output_storage_io','output_format','output_native','client_attach_timeout','client_playback_stall'].includes(String(e.code)))this.failure=String(e.code);this.report('output_recovery');this.cancelId=String(e.id);this.options.recover(String(e.code));}
    else if(e.type==='closing')this.restart(String(e.code));
    else if(e.type==='command_ack'&&e.id===this.cancelId&&e.status!=='accepted'){this.cancelId=undefined;this.afterCancel=undefined;}
  }
  private receipt(e:any){
    if(e.connection!==this.options.connection||!Number.isSafeInteger(e.generation))return;
    const o=this.outputs.get(e.generation);if(!o||o.sid!==e.trackSid||!['render_observed','estimated'].includes(e.evidence))return;
    if(e.state==='progress'&&e.evidence==='estimated'&&Number.isSafeInteger(e.playedSamples)&&e.playedSamples>=0&&e.playedSamples<=1e9){this.command({type:'playback',generation:e.generation,trackSid:e.trackSid,state:'progress',evidence:'estimated',playedSamples:e.playedSamples});}
    else if(e.state==='started'&&!o.heard&&e.evidence==='render_observed'&&this.options.active()){
      this.trace.record('started',{generation:e.generation,...audioMetrics(e.stats)});o.heard=true;this.options.evidence?.({kind:'started',generation:e.generation,trackSid:e.trackSid,evidence:e.evidence});this.stats.clientStarted++;this.options.heard();
    }else if(e.state==='ended'&&o.done&&o.drained&&!o.ended){
      const metrics=audioMetrics(e.stats);this.trace.record('ended',{generation:e.generation,estimated:Number(e.evidence==='estimated'),...metrics});
      this.options.evidence?.({kind:'ended',generation:e.generation,trackSid:e.trackSid,evidence:e.evidence,metrics});
      o.ended=true;this.stats.clientEnded++;if(e.evidence==='estimated')this.stats.estimatedEnded++;
      this.command({type:'playback',generation:e.generation,trackSid:e.trackSid,state:'ended',evidence:e.evidence});
      // Estimated completion releases this segment; the shared track stays live. It never establishes delivery.
      if(o.heard&&e.evidence==='render_observed')this.options.drained(e.generation);
      this.outputs.delete(e.generation);
    }
  }
  report(phase:string){console.info('MEETING_RTC_DIAGNOSTICS '+JSON.stringify({agent:this.options.agent,epoch:this.options.connection,phase,at:new Date().toISOString(),elapsedMs:Date.now()-this.connectedAt,stage:this.stage,providerReady:this.providerReady,clientJoined:this.clientJoined,restarts:this.restarts,failure:this.failure,client:this.clientDiagnostics,...this.stats,bridge:this.bridgeStats,trace:this.trace.snapshot()}));}
  close(state:'paused'|'ended',message?:string){
    if(this.closed)return;
    if(this.client.readyState===WebSocket.OPEN&&this.client.bufferedAmount<256*1024)this.client.send(JSON.stringify({type:state,message}));
    this.closed=true;clearTimeout(this.restartTimer);clearInterval(this.watchdog);this.bridge?.close();this.client.close();
    if(this.room)void this.service.deleteRoom(this.room).catch(()=>{});
  }
}
