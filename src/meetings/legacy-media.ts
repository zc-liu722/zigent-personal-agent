import { MeetingAudioTrace } from './audio-diagnostics.js';
import type { IncomingMessage, Server } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { RtcMeetingMedia, type RtcConfiguration } from './rtc-media.js';
import { MeetingTransport } from './transport.js';
import { MeetingAudioOutput } from './audio-output.js';
import { sameMediaVersion, type MeetingMedia, type MeetingMediaCommand, type MeetingMediaFactory,
  type MeetingMediaOptions, type MeetingConsultation } from './media.js';

const tools = [
  {type:'function',name:'consult_main',description:'缺少信息、需要判断或用户改变任务时，请求主模型指导。等待结果后再答。',parameters:{type:'object',properties:{question:{type:'string'}},required:['question']}},
  {type:'function',name:'request_finish',description:'已完成问题或用户希望结束时，请求结束会议。',parameters:{type:'object',properties:{reason:{type:'string'}},required:['reason']}}
];
type Output = { generation: number; responseId?: string; itemId?: string; done: boolean };

/** Migration baseline only: owns all legacy PCM, socket and cancellation state. */
class LegacyMeetingMedia implements MeetingMedia {
  generation: number;
  private output?: Output;
  private outputs = new Map<number, Output>();
  private awaitingAudio = true;
  private cancelling = false;
  private closed = false;
  private afterCancel?: () => void;
  private cancelTimer?: NodeJS.Timeout;
  private watchdog: NodeJS.Timeout;
  private upstream: MeetingTransport;
  private playback: MeetingAudioOutput;
  private trace: MeetingAudioTrace;
  private lastSeen = Date.now();
  private stats = { chunks:0, maxGapMs:0, lastChunkAt:undefined as number|undefined, underruns:0, clears:0,
    playbackRecoveries:0, playbackFailure:undefined as string|undefined, maxCaptureDelayMs:0,
    maxClientBufferedBytes:0, clientFailure:undefined as string|undefined, browser:{} as Record<string,number> };

  constructor(private client: WebSocket, private options: MeetingMediaOptions, authenticate: () => boolean) {
    this.trace=new MeetingAudioTrace(options.agent,options.connection,'pcm');
    this.generation = options.initialGeneration;
    this.playback = new MeetingAudioOutput({
      send: event => { const e=event as {type:string;generation:number};if(e.type==='audio_start')this.trace.record('published',{generation:e.generation});this.sendClient(event); }, failed: reason => this.recover(reason),
      drained: generation => { if (!this.current()) return; this.outputs.delete(generation); this.trace.record('ended',{generation,...this.playback.stats});options.drained(generation); }
    });
    this.upstream = new MeetingTransport(options.apiKey, {
      open: () => { if (this.current()) this.send({type:'session.create',session:{
        ...(options.providerSessionId?{id:options.providerSessionId}:{}),model:'1.2.6.1',instructions:options.instructions,tools,
        audio:{input:{format:{type:'pcm',sample_rate:16000}},output:{format:{type:'pcm_s16le',sample_rate:24000},voice:'zh_female_xiaohe_jupiter_bigtts',speed:20}}
      }}); },
      event: event => { if (this.current()) this.event(event); },
      fail: reason => { if (this.current()) options.pause(['queue_limit','queue_age','upstream_backpressure','input_handoff'].includes(reason)?'语音上传持续拥堵，请重新连接。':'语音连接中断，可重新连接'); },
      report: stats => console.info('MEETING_TRANSPORT_DIAGNOSTICS '+JSON.stringify({agent:options.agent,epoch:options.connection,at:new Date().toISOString(),...stats}))
    });
    let alive = true;
    this.watchdog = setInterval(() => {
      if (!this.current()) return;
      if (!authenticate()) { options.finish('登录已失效',false); return; }
      if (!alive || Date.now()-this.lastSeen>20000) { options.pause('会议连接已断开，可重新连接'); return; }
      alive=false; client.ping();
    },10000);
    client.on('pong',()=>alive=true);
    client.on('message',(raw,binary)=>{
      if (!this.current()) return;
      if (!authenticate()) { options.finish('登录已失效',false); return; }
      this.lastSeen=Date.now();
      if (binary) {
        if (options.active()) {
          if (!(raw instanceof Buffer)||raw.length!==640) { options.pause('语音输入格式异常，请重新连接。'); return; }
          this.upstream.enqueue(raw);
        }
        return;
      }
      try { this.clientEvent(JSON.parse(raw.toString())); } catch { client.close(1008); }
    });
    client.on('error',()=>{if(this.current())options.pause('会议连接已断开，可重新连接');});
    client.on('close',()=>{if(this.current())options.pause('通话已断开，可重新连接');});
  }
  private current() { return !this.closed && this.options.current(); }
  private send(event: object) { if (this.current()) this.upstream.send(event); }
  private sendClient(event: object) {
    if (!this.current() || this.client.readyState!==WebSocket.OPEN) return;
    if (this.client.bufferedAmount>512*1024) { this.options.pause('音频连接拥堵，可重新连接'); return; }
    this.client.send(JSON.stringify(event));
  }
  get outputDone() { return this.output?.done===true; }
  ready(opening: string) { this.sendClient({type:'ready',audioProtocol:3}); this.send({type:'speech_text_buffer.commit',text:opening}); }
  update(instructions: string, command?: MeetingMediaCommand) {
    if(command&&!sameMediaVersion(command,this.options.version()))return;
    this.send({type:'session.update',session:{instructions}});
  }
  toolResults(requests: MeetingConsultation[],result: object) {
    this.send({type:'conversation.item.create',items:requests.map(r=>({call_id:r.call_id,role:'tool',content:[{type:'input_text',text:JSON.stringify(result)}]}))});
  }
  mute(muted: boolean) { if (this.current()) this.upstream.mute(muted); }
  clear() {
    this.trace.record('clear',{generation:this.generation,...this.playback.stats});
    this.playback.clear(); this.outputs.clear(); this.output=undefined; this.awaitingAudio=true;
    this.generation++; this.stats.clears++; this.stats.lastChunkAt=undefined;
    this.sendClient({type:'clear',generation:this.generation});
  }
  interrupt(then: () => void, command?: MeetingMediaCommand) {
    if (!this.current() || command && !sameMediaVersion(command,this.options.version())) return;
    const pending=this.cancelling;
    if(!pending){this.cancelling=true;this.clear();}
    // Our own clear advances output; any subsequent clear, user speech or
    // reconnect invalidates this replacement before the supplier ACK arrives.
    const expected=this.options.version();
    this.afterCancel=()=>{if(this.current()&&sameMediaVersion(expected,this.options.version()))then();};
    if(pending)return;
    this.cancelTimer=setTimeout(()=>{this.afterCancel=undefined;this.options.pause('语音打断未确认，请重新连接。');},5000);
    this.send({type:'response.cancel'});
  }
  speak(text: string) { this.send({type:'speech_text_buffer.replacement.append',text});this.send({type:'speech_text_buffer.replacement.commit'}); }
  private recover(reason: string) {
    if (!this.current() || this.cancelling) return;
    this.stats.playbackRecoveries++; this.stats.playbackFailure=reason; this.options.recover(reason);
  }
  private startOutput(e:any) {
    if (this.cancelling) return;
    const responseId=typeof e.response_id==='string'?e.response_id:undefined,itemId=typeof e.item_id==='string'?e.item_id:undefined;
    const key=itemId?`item:${itemId}`:responseId?`response:${responseId}`:undefined;
    if(key&&[...this.outputs.values()].some(output=>!output.done&&(itemId?output.itemId===itemId:output.responseId===responseId)))return;
    this.generation++;this.trace.record('created',{generation:this.generation}); this.awaitingAudio=false; this.stats.lastChunkAt=undefined;
    this.output={generation:this.generation,responseId,itemId,done:false};
    this.outputs.set(this.generation,this.output); this.playback.start(this.generation);
  }
  private matchingOutput(e:any) {
    if(this.cancelling||this.awaitingAudio)return;
    return [...this.outputs.values()].reverse().find(output=>!output.done
      &&!(typeof e.response_id==='string'&&output.responseId&&e.response_id!==output.responseId)
      &&!(typeof e.item_id==='string'&&output.itemId&&e.item_id!==output.itemId));
  }
  private event(e:any) {
    if(e.type==='response.output_audio.started')this.startOutput(e);
    else if(e.type==='response.output_audio.delta') {
      const output=this.matchingOutput(e);if(!output||output.done)return;
      const now=performance.now();if(this.stats.lastChunkAt!==undefined)this.stats.maxGapMs=Math.max(this.stats.maxGapMs,Math.round(now-this.stats.lastChunkAt));
      this.stats.lastChunkAt=now;this.stats.chunks++;this.playback.append(output.generation,e.delta??e.audio);
    } else if(e.type==='response.output_audio.done') {
      const output=this.matchingOutput(e);if(!output)return;output.done=true;this.trace.record('generated',{generation:output.generation,...this.playback.stats});this.playback.end(output.generation);
    } else if(e.type==='response.canceled') {
      if(!this.cancelling)return;
      clearTimeout(this.cancelTimer);this.cancelling=false;const next=this.afterCancel;this.afterCancel=undefined;next?.();
    } else this.options.event(e);
  }
  private clientEvent(e:any) {
    const o=this.options;
    if(e.type==='end')o.finish('用户结束会议');
    else if(e.type==='audio_diagnostics'&&typeof e.enabled==='boolean')this.trace.set(e.enabled);
    else if(e.type==='pause') {
      if(['capture_stall','browser_backpressure'].includes(e.cause))this.stats.clientFailure=e.cause;
      o.pause('通话已暂停，可重新连接');
    } else if(e.type==='audio_stats') {
      if(Number.isFinite(e.maxCaptureDelayMs)&&e.maxCaptureDelayMs>=0&&e.maxCaptureDelayMs<=3_600_000)this.stats.maxCaptureDelayMs=e.maxCaptureDelayMs;
      if(Number.isSafeInteger(e.maxBufferedBytes)&&e.maxBufferedBytes>=0&&e.maxBufferedBytes<=16*1024*1024)this.stats.maxClientBufferedBytes=e.maxBufferedBytes;
      for(const key of ['contextSampleRate','trackSampleRate','baseLatencyMs','outputLatencyMs','captureFrames','captureClockRatio','playbackQueueMs','maxPlaybackQueueMs','playbackTargetMs','playbackJitterMs','playbackRecoveries'])
        if(Number.isFinite(e[key])&&e[key]>=0&&e[key]<=10_000_000)this.stats.browser[key]=e[key];
      if(this.trace.enabled)this.trace.record('browser',{...this.stats.browser,...this.playback.stats,generation:this.generation});
    } else if(e.type==='speaking'&&!this.cancelling&&o.active()&&this.playback.heard(e.generation)){this.trace.record('started',{generation:e.generation});o.heard();}
    else if(e.type==='underrun'&&this.playback.owns(e.generation))this.stats.underruns++;
    else if(e.type==='playback')this.playback.acknowledge(e.generation,e.consumedSamples,e.drained===true);
    else if(e.type==='playback_recover'&&this.playback.owns(e.generation)&&['playback_capacity','playback_sequence'].includes(e.cause))this.recover(e.cause);
    else if(e.type==='audio-pause'&&o.active())o.audioPaused();
    else if(e.type==='mute')this.mute(!o.active()||Boolean(e.muted));
  }
  report(phase: string) {
    console.info('MEETING_AUDIO_DIAGNOSTICS '+JSON.stringify({agent:this.options.agent,epoch:this.options.connection,phase,at:new Date().toISOString(),
      ...this.stats,lastChunkAt:undefined,output:this.playback.stats,transport:this.upstream.stats,trace:this.trace.snapshot()}));
  }
  close(state:'paused'|'ended',message?:string) {
    if(this.closed)return;
    // The coordinator invalidates the connection first; terminal notice bypasses current().
    if(this.client.readyState===WebSocket.OPEN&&this.client.bufferedAmount<=512*1024)this.client.send(JSON.stringify({type:state,...(message?{message}:{})}));
    this.closed=true;clearTimeout(this.cancelTimer);clearInterval(this.watchdog);this.afterCancel=undefined;
    this.playback.clear();this.upstream.close();this.client.close();
  }
}

export type MeetingGatewayOptions = { path:string; origin:string; authenticate:(r:IncomingMessage)=>boolean; rtc?:RtcConfiguration };
export function attachLegacyMeetingGateway(server:Server,options:MeetingGatewayOptions,coordinator:{
  canJoin:(id:string,conversationId:unknown)=>boolean;
  connect:(id:string,factory:MeetingMediaFactory)=>void;
  shutdown:()=>void;
}) {
  const gateway=new WebSocketServer({noServer:true,maxPayload:8192,perMessageDeflate:false});
  const speechPath=options.path.replace(/api\/meeting\/stream$/, 'api/speech');
  const upgrade=(req:IncomingMessage,socket:import('node:stream').Duplex,head:Buffer)=>{
    const url=new URL(req.url??'/','http://localhost');
    const protocol=req.headers['sec-websocket-protocol']?.split(',').some(value=>value.trim()==='zigent-meeting-v1');
    if(url.pathname!==options.path&&!(url.pathname===speechPath&&protocol))return;
    if(req.method!=='GET'||req.headers.origin!==options.origin||!options.authenticate(req)||!protocol||gateway.clients.size>=8){socket.end('HTTP/1.1 403 Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return;}
    gateway.handleUpgrade(req,socket,head,client=>{
      const startup=setTimeout(()=>client.close(1008,'会议连接超时'),5000);
      client.once('close',()=>clearTimeout(startup));client.on('error',()=>{});
      client.once('message',(raw,binary)=>{
        clearTimeout(startup);
        try {
          if(binary||!options.authenticate(req))throw new Error();
          const input=JSON.parse(raw.toString());
          if(input.type!=='join'||!coordinator.canJoin(input.id,input.conversationId))throw new Error();
          if(input.audioProtocol!==3&&!(input.audioProtocol===6&&options.rtc?.enabled)){client.send(JSON.stringify({type:'error',message:'语音组件已更新，请刷新页面后重试。'}));client.close(1008);return;}
          coordinator.connect(input.id,mediaOptions=>input.audioProtocol===6&&options.rtc?new RtcMeetingMedia(client,mediaOptions,options.rtc,()=>options.authenticate(req)):new LegacyMeetingMedia(client,mediaOptions,()=>options.authenticate(req)));
        } catch { client.send(JSON.stringify({type:'error',message:'会议已失效或不属于当前对话，请重新发起。'}));client.close(1008); }
      });
    });
  };
  server.on('upgrade',upgrade);
  return {close:()=>{server.off('upgrade',upgrade);coordinator.shutdown();gateway.close();}};
}
