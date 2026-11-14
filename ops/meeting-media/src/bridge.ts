import { AudioStream, Room, RoomEvent, TrackKind, type RemoteTrack } from '@livekit/rtc-node';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { cleanAbandonedSpools } from './pcm-spool.js';
import { BridgeOutput } from './output.js';
import type { Command, Start, Version } from './protocol.js';

const tools=[
  {type:'function',name:'consult_main',description:'需要判断或缺少信息时请求主模型指导，等待结果后再答。',parameters:{type:'object',properties:{question:{type:'string'}},required:['question']}},
  {type:'function',name:'request_finish',description:'会议完成或用户希望结束时请求结束会议。',parameters:{type:'object',properties:{reason:{type:'string'}},required:['reason']}}
];
/** One meeting per process; no database, HTTP listener, model gateway or tool executor. */
export class VoiceBridge {
  private room=new Room();
  private socket?:WebSocket;
  private output:BridgeOutput;
  private ready=false;
  private muted=false;
  private closed=false;
  private utterance=0;
  private seen=new Set<string>();
  private calls=new Set<string>();
  private answered=new Set<string>();
  private inputSid?:string;
  private reader?:ReadableStreamDefaultReader<any>;
  private inputEpoch=0;
  private cancellation?:{id:string;version:Version;replacement?:string;timer:NodeJS.Timeout};
  private connectTimer?:NodeJS.Timeout;
  private inputTimer?:NodeJS.Timeout;
  private inputMuted=true;
  private inputQueue:Array<{pcm:Buffer;at:number}>=[];
  private inputWait?:NodeJS.Timeout;
  private inputBlockedAt?:number;
  private inputDraining=false;
  private frameTimes:number[]=[];
  private diagnosticsTimer?:NodeJS.Timeout;
  private readonly stats:{inputFrames:number;maxFrameMs:number;p95FrameMs?:number}={inputFrames:0,maxFrameMs:0};
  constructor(private config:Start,private sink:(event:object)=>void){
    this.output=new BridgeOutput(this.room,e=>this.emit(e),code=>this.recover(code));this.output.generation=config.initialGeneration;this.calls=new Set(config.pendingCalls);
  }
  private emit(event:object){this.sink({...event,meetingId:this.config.meetingId,version:this.version});}
  get version():Version{return {connection:this.config.connection,utterance:this.utterance,output:this.output.generation};}
  private current(v:Version){const now=this.version;return v.connection===now.connection&&v.utterance===now.utterance&&v.output===now.output;}
  async connect(){
    void cleanAbandonedSpools().catch(()=>{});
    this.room.on(RoomEvent.TrackSubscribed,(track,_publication,participant)=>{
      if(participant.identity===this.config.participant&&track.kind===TrackKind.KIND_AUDIO)void this.read(track);
    });
    this.room.on(RoomEvent.TrackUnsubscribed,track=>{if(track.sid===this.inputSid)void this.stopInput();});
    this.room.on(RoomEvent.Disconnected,()=>{if(!this.closed)void this.close('rtc_disconnected');});
    this.connectTimer=setTimeout(()=>void this.close('connect_timeout'),25000);
    await this.room.connect(this.config.livekitUrl,this.config.token,{autoSubscribe:true,dynacast:false});
    if(this.closed){await this.room.disconnect();return;}
    const ws=this.socket=new WebSocket('wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue',{
      headers:{'X-Api-Key':this.config.apiKey},maxPayload:2*1024*1024,handshakeTimeout:15000,perMessageDeflate:false});
    ws.on('open',()=>this.send({type:'session.create',session:{...(this.config.providerSessionId?{id:this.config.providerSessionId}:{}),model:'1.2.6.1',instructions:this.config.instructions,tools,
      audio:{input:{format:{type:'pcm',sample_rate:16000}},output:{format:{type:'pcm_s16le',sample_rate:24000},voice:'zh_female_xiaohe_jupiter_bigtts',speed:20}}}}));
    ws.on('message',raw=>{if(this.closed)return;try{this.event(JSON.parse(raw.toString()));}catch{void this.close('provider_protocol');}});
    ws.on('error',()=>void this.close('provider_socket'));
    ws.on('close',()=>{if(!this.closed)void this.close('provider_closed');});
  }
  private send(event:object){if(this.closed||this.socket?.readyState!==WebSocket.OPEN)return;
    if(this.socket.bufferedAmount>512*1024){void this.close('provider_control_backpressure');return;}
    this.socket.send(JSON.stringify({...event,event_id:randomUUID()}),error=>{if(error)void this.close('provider_write');else this.drainInput();});
  }
  private async stopInput(){this.inputEpoch++;const reader=this.reader;this.reader=undefined;await reader?.cancel().catch(()=>{});}
  private async read(track:RemoteTrack){
    const epoch=++this.inputEpoch,previous=this.reader;this.reader=undefined;this.inputSid=track.sid;
    await previous?.cancel().catch(()=>{});if(this.closed||epoch!==this.inputEpoch)return;
    let burstAt=performance.now(),burstFrames=0;
    // Native RTC owns resampling, packet jitter and the single 20 ms input clock.
    const reader=new AudioStream(track,{sampleRate:16000,numChannels:1,frameSizeMs:20}).getReader();this.reader=reader;
    try{while(!this.closed&&epoch===this.inputEpoch){
      const {done,value:frame}=await reader.read();if(done)break;
      if(!this.ready||this.muted)continue;
      const start=performance.now();if(start-burstAt>=100){burstAt=start;burstFrames=0;}
      if(++burstFrames>60){void this.close('input_backlog');break;}
      if(frame.sampleRate!==16000||frame.channels!==1||frame.samplesPerChannel!==320){void this.close('input_format');break;}
      // No replay queue across reconnects or mute. Backpressure ends this media connection.
      const pcm=Buffer.allocUnsafe(640);for(let i=0;i<320;i++)pcm.writeInt16LE(frame.data[i]!,i*2);
      if(this.inputQueue.length>=60){void this.close('input_capacity');break;}
      this.inputQueue.push({pcm,at:start});this.drainInput();
      const frameMs=performance.now()-start;this.stats.maxFrameMs=Math.max(this.stats.maxFrameMs,frameMs);this.frameTimes.push(frameMs);if(this.frameTimes.length>512)this.frameTimes.shift();
      clearTimeout(this.inputTimer);this.inputTimer=setTimeout(()=>this.silence(),500);
    }}catch{if(!this.closed&&epoch===this.inputEpoch)void this.close('input_native');}
    finally{await reader.cancel().catch(()=>{});if(this.reader===reader){this.reader=undefined;this.silence();}}
  }
  private drainInput(){
    if(this.closed||this.inputDraining||!this.ready||this.muted)return;
    this.inputDraining=true;
    try{while(this.inputQueue.length){
      const now=performance.now(),frame=this.inputQueue[0]!;
      if(now-frame.at>1200){void this.close('input_age');return;}
      if((this.socket?.bufferedAmount??Infinity)>16*1024){
        this.inputBlockedAt??=now;if(now-this.inputBlockedAt>=1000){void this.close('input_backpressure');return;}
        clearTimeout(this.inputWait);this.inputWait=setTimeout(()=>this.drainInput(),20);return;
      }
      this.inputBlockedAt=undefined;clearTimeout(this.inputWait);this.inputQueue.shift();
      if(this.inputMuted){this.inputMuted=false;this.send({type:'input_audio_unmute.commit'});}
      this.send({type:'input_audio_buffer.append',audio:frame.pcm.toString('base64')});this.stats.inputFrames++;
    }}finally{this.inputDraining=false;}
  }
  private silence(){clearTimeout(this.inputTimer);if(!this.inputMuted){this.inputMuted=true;this.send({type:'input_audio_mute.commit'});}}
  private event(e:any){
    if(e.type==='session.created'){this.ready=true;clearTimeout(this.connectTimer);this.send({type:'input_audio_mute.commit'});this.emit({type:'ready',providerSessionId:e.session?.id});}
    else if(e.type==='response.output_audio.started'){if(!this.cancellation)this.output.start(e.response_id,e.item_id);}
    else if(e.type==='response.output_audio.delta'){if(!this.cancellation)this.output.append(e);}
    else if(e.type==='response.output_audio.done'){if(!this.cancellation)this.output.end(e);}
    else if(e.type==='response.canceled'){
      const pending=this.cancellation;if(!pending)return;clearTimeout(pending.timer);this.cancellation=undefined;
      const valid=this.current(pending.version);this.emit({type:'cancel_ack',id:pending.id,stale:!valid});
      if(valid&&pending.replacement)this.speak(pending.replacement);
    }else if(e.type==='conversation.item.input_audio_transcription.started'){
      this.utterance++;this.output.userStarted();this.emit({type:'user_started',itemId:e.item_id});
    }else if(['conversation.item.input_audio_transcription.delta','conversation.item.input_audio_transcription.completed','conversation.item.input_audio_transcription.failed','response.output_text.delta','response.output_text.done'].includes(e.type)){
      // Any user revision invalidates a pending decision, even within an utterance.
      if(e.type.startsWith('conversation.item.input_audio_transcription.'))this.utterance++;
      this.emit({type:'transcript',event:{type:e.type,item_id:e.item_id,response_id:e.response_id,text:e.text??e.delta??e.transcript??e.content??''}});
    }else if(e.type==='response.function_call_arguments.done'){
      const items=Array.isArray(e.items)?e.items:e.items?[e.items]:[];
      for(const item of items){if(typeof item.call_id!=='string'||(this.calls.has(item.call_id)||this.answered.has(item.call_id)))continue;
        if(this.calls.size+this.answered.size>=256){void this.close('tool_capacity');return;}
        this.calls.add(item.call_id);const name=item.name??item.function?.name;
        if(['consult_main','request_finish'].includes(name))this.emit({type:'consultation',call_id:item.call_id,name,arguments:String(item.arguments??item.function?.arguments??'').slice(0,8000)});
        else this.send({type:'conversation.item.create',items:[{call_id:item.call_id,role:'tool',content:[{type:'input_text',text:'{"error":"工具不可用"}'}]}]});
      }
    }else if(e.type==='response.done')this.emit({type:'usage',model:'doubao-seeduplex3.0-official',apiModel:'1.2.6.1',responseId:e.response_id,usage:e.usage??e.response?.usage});
    else if(e.type==='session.closed'||e.type==='error')void this.close(e.type==='error'?'provider_error':'provider_closed');
  }
  command(c:Command){
    if(this.closed)return;
    if(this.seen.has(c.id)){this.emit({type:'command_ack',id:c.id,status:'duplicate'});return;}
    if(this.seen.size>=4096){void this.close('command_capacity');return;}
    this.seen.add(c.id);
    if(c.action.type==='close'&&c.expected.connection===this.config.connection){void this.close('coordinator_closed');return;}
    const independent=['tool_results','playback','mute','attached','diagnostics'].includes(c.action.type)&&c.expected.connection===this.config.connection;
    if(!independent&&!this.current(c.expected)){this.emit({type:'command_ack',id:c.id,status:'stale'});return;}
    const a=c.action;
    if(a.type==='close'){void this.close('coordinator_closed');return;}
    if(a.type==='diagnostics'){clearInterval(this.diagnosticsTimer);if(a.enabled)this.diagnosticsTimer=setInterval(()=>this.emit({type:'audio_diagnostics',stats:{...this.stats,...this.output.snapshot()}}),2000);return;}
    if(!this.ready){this.emit({type:'command_ack',id:c.id,status:'not_ready'});return;}
    if(a.type==='cancel'){if(this.cancellation){this.emit({type:'command_ack',id:c.id,status:'busy'});return;}this.cancel(c.id,a.replacement);}
    else if(a.type==='playback'){
      this.emit({type:'client_playback',generation:a.generation,trackSid:a.trackSid,state:a.state,evidence:a.evidence});
      if(a.state==='progress')this.output.clientProgress(a.generation,a.trackSid,a.playedSamples??0);
      if(a.state==='ended')void this.output.clientEnded(a.generation,a.trackSid).catch(()=>this.recover('output_storage_io'));
    }
    else if(a.type==='attached')this.output.clientAttached(a.generation,a.trackSid);
    else if(a.type==='guide')this.send({type:'session.update',session:{instructions:a.instructions}});
    else if(a.type==='opening')this.send({type:'speech_text_buffer.commit',text:a.text});
    else if(a.type==='speak'){if(this.cancellation){this.emit({type:'command_ack',id:c.id,status:'busy'});return;}this.speak(a.text);}
    else if(a.type==='mute'){this.muted=a.muted;if(a.muted){this.inputQueue=[];clearTimeout(this.inputWait);this.inputBlockedAt=undefined;this.silence();}}
    else if(a.type==='tool_results'){
      if(a.items.some(i=>!this.calls.has(i.call_id))){this.emit({type:'command_ack',id:c.id,status:'unknown_call'});return;}
      for(const item of a.items){this.calls.delete(item.call_id);this.answered.add(item.call_id);}
      this.send({type:'conversation.item.create',items:a.items.map(i=>({call_id:i.call_id,role:'tool',content:[{type:'input_text',text:JSON.stringify(this.current(c.expected)?i.result:{stale:true,guidance:'用户发言或播报已经变化，旧求助结果已过期，请根据最新发言继续。'})}]}))});
    }
    this.emit({type:'command_ack',id:c.id,status:'accepted'});
  }
  private speak(text:string){this.send({type:'speech_text_buffer.replacement.append',text});this.send({type:'speech_text_buffer.replacement.commit'});}
  private cancel(id:string,replacement?:string){this.output.clear();this.cancellation={id,version:this.version,replacement,timer:setTimeout(()=>void this.close('cancel_timeout'),5000)};this.send({type:'response.cancel'});}
  private recover(code:string){if(this.closed||this.cancellation)return;const id=randomUUID(),stats=this.output.snapshot();this.cancel(id);this.emit({type:'output_incomplete',code,id,stats});}
  async close(code:string){
    if(this.closed)return;this.closed=true;clearInterval(this.diagnosticsTimer);if(this.frameTimes.length){const sorted=[...this.frameTimes].sort((a,b)=>a-b);this.stats.p95FrameMs=sorted[Math.ceil(sorted.length*.95)-1];}this.emit({type:'closing',code,stats:{...this.stats,...this.output.stats}});clearTimeout(this.connectTimer);clearTimeout(this.inputTimer);clearTimeout(this.cancellation?.timer);
    clearTimeout(this.inputWait);this.inputQueue=[];this.output.clear();await this.stopInput();
    const ws=this.socket;if(ws?.readyState===WebSocket.OPEN){ws.send(JSON.stringify({type:'session.close',event_id:randomUUID()}));const timer=setTimeout(()=>ws.terminate(),2000);ws.once('close',()=>clearTimeout(timer));ws.on('message',raw=>{try{if(JSON.parse(raw.toString()).type==='session.closed')ws.close();}catch{}});}else ws?.terminate();
    await this.room.disconnect().catch(()=>{});this.emit({type:'closed',code,stats:{...this.stats,...this.output.stats}});
  }
}
