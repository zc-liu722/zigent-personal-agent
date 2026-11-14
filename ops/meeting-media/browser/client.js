import { Room, RoomEvent, Track, LocalAudioTrack, ConnectionErrorReason, setLogLevel } from 'livekit-client';
setLogLevel('silent');
const rms=node=>{if(!node)return 0;const values=new Float32Array(node.fftSize);node.getFloatTimeDomainData(values);return Math.sqrt(values.reduce((n,v)=>n+v*v,0)/values.length);};
class RtcMeetingAudio {
  constructor(id,status,changed){Object.assign(this,{id,status,changed,tracks:new Map(),bindings:new Map(),minimumGeneration:0});}
  async start(conversationId,preflight){
    if(!isSecureContext||!navigator.mediaDevices?.getUserMedia||!window.AudioContext)throw new Error('当前浏览器不支持实时语音。');
    try{
      if(!this.preparedContext&&navigator.audioSession){this.previousAudioSession=navigator.audioSession.type;navigator.audioSession.type='play-and-record';}
      this.context=this.preparedContext||new AudioContext({latencyHint:'interactive'});await Promise.race([this.context.resume(),new Promise(resolve=>setTimeout(resolve,1000))]);this.needsResume=this.context.state!=='running';
      this.stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      if(this.closed){this.stream.getTracks().forEach(t=>t.stop());return;}
      this.input=this.context.createMediaStreamSource(this.stream);this.inputLevel=this.context.createAnalyser();this.inputLevel.fftSize=256;this.input.connect(this.inputLevel);
      this.inputSilent=this.context.createGain();this.inputSilent.gain.value=0;this.inputLevel.connect(this.inputSilent);this.inputSilent.connect(this.context.destination);
      await preflight();if(this.closed)return;
      const url=new URL('./api/meeting/stream',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';
      this.socket=new WebSocket(url,'zigent-meeting-v1');
      this.socket.onopen=()=>{this.send({type:'join',id:this.id,conversationId,audioProtocol:6});this.setDiagnostics(Boolean(this.diagnostics));};
      this.socket.onmessage=event=>{if(this.closed)return;try{this.control(JSON.parse(event.data));}catch{this.disconnect('媒体连接异常，请重新连接。');}};
      this.socket.onclose=this.socket.onerror=()=>{if(!this.closed)this.disconnect('通话已断开，点击光球重试。');};
      this.heartbeat=setInterval(()=>this.send({type:'heartbeat'}),5000);
      this.observer=setInterval(()=>{void this.observe();this.reportState();},100);
      this.timeout=setTimeout(()=>{if(!this.ready)this.disconnect('会议连接超时，请重新连接。','startup_timeout');},25000);
      this.context.onstatechange=()=>{if(this.closed)return;this.needsResume=this.context.state!=='running';if(this.needsResume){this.stream?.getAudioTracks().forEach(t=>t.enabled=false);this.send({type:'mute',muted:true});this.invalidate(Infinity);this.send({type:'audio-pause'});this.status('音频已暂停，点击光球继续。');}this.changed?.();};
      this.stream.getAudioTracks().forEach(track=>{track.onended=()=>this.disconnect('麦克风已断开，请重新连接。');});
      this.visible=()=>{if(!document.hidden)void this.resume();};document.addEventListener('visibilitychange',this.visible);
      this.deviceChanged=()=>this.changed?.();navigator.mediaDevices.addEventListener?.('devicechange',this.deviceChanged);
      await new Promise((resolve,reject)=>{this.connectionReady=resolve;this.connectionFailed=reject;});
    }catch(error){this.close();throw error;}
  }
  send(e){if(this.socket?.readyState===WebSocket.OPEN&&this.socket.bufferedAmount<64*1024)this.socket.send(JSON.stringify(e));}
  setDiagnostics(enabled){this.diagnostics=enabled;this.send({type:'audio_diagnostics',enabled});}
  control(e){
    if(e.type==='rtc_join'){this.connection=e.connection;this.bridgeIdentity=e.bridgeIdentity;void this.join(e).catch(error=>this.disconnect('媒体连接失败，请重新连接。','rtc_join',error));}
    else if(e.type==='rtc_recovering'){this.providerReady=false;this.ready=false;this.status('正在恢复语音…');this.changed?.();}
    else if(e.type==='ready'){if(e.audioProtocol!==6){this.disconnect('语音组件已更新，请刷新页面后重试。');return;}this.providerReady=true;this.syncReady();}
    else if(e.type==='rtc_track'){
      if(e.connection!==this.connection||e.generation<this.minimumGeneration)return;
      // A post-clear new SID is the only way old browser receive buffers can re-enter playback.
      this.bindings.set(e.trackSid,{generation:e.generation});
      const existing=this.tracks.get(e.trackSid);if(existing){void this.beginSegment(existing,e.generation);return;}const track=this.room?.remoteParticipants.get(this.bridgeIdentity)?.trackPublications.get(e.trackSid)?.track;
      if(track)this.attach(track,e.trackSid);this.pendingAttach?.();
    }else if(e.type==='rtc_clear')this.invalidate(e.generation);
    else if(e.type==='rtc_source_drained'){
      const o=this.tracks.get(e.trackSid);if(o&&o.generation===e.generation){o.samples=e.samples;o.sampleRate=e.sampleRate;o.drainedAt=performance.now();}
      else {const b=this.bindings.get(e.trackSid);if(b)Object.assign(b,{samples:e.samples,sampleRate:e.sampleRate,drainedAt:performance.now()});}
    }else if(e.type==='ended')this.close();
    else if(e.type==='error'||e.type==='paused')this.disconnect(e.message||'通话已暂停，可重新连接。');
  }
  async join(e){
    const room=this.room=new Room({adaptiveStream:false,dynacast:false});
    room.on(RoomEvent.TrackSubscribed,(track,publication,participant)=>{if(participant.identity===this.bridgeIdentity&&track.kind===Track.Kind.Audio)this.attach(track,publication.trackSid);});
    room.on(RoomEvent.TrackUnsubscribed,(_track,publication)=>this.detach(publication.trackSid));
    room.on(RoomEvent.Reconnecting,()=>{this.reconnecting=true;this.ready=false;this.stream?.getAudioTracks().forEach(t=>t.enabled=false);this.send({type:'mute',muted:true});this.invalidate(Infinity);this.send({type:'audio-pause'});this.status('正在恢复连接…');this.changed?.();});
    room.on(RoomEvent.Reconnected,()=>{this.reconnecting=false;this.minimumGeneration=0;this.syncReady();});
    // During join, its rejected promise retains the SDK authentication/status
    // code. Do not let the generic disconnect event replace that diagnosis.
    room.on(RoomEvent.Disconnected,()=>{if(!this.closed&&this.rtcReady)this.disconnect('媒体连接已断开，点击光球重试。','rtc_disconnected');});
    this.connectionStage='signaling';
    await room.connect(e.url,e.token,{autoSubscribe:true});if(this.closed){await room.disconnect();return;}
    this.connectionStage='publish';
    this.localTrack=new LocalAudioTrack(this.stream.getAudioTracks()[0]);
    await room.localParticipant.publishTrack(this.localTrack,{source:Track.Source.Microphone});
    this.rtcReady=true;this.send({type:'rtc_connected'});this.syncReady();
  }
  syncReady(){if(this.closed)return;this.ready=Boolean(this.providerReady&&this.rtcReady&&!this.reconnecting&&this.context?.state==='running');if(this.ready){this.everReady=true;this.connectionStage='active';this.connectionReady?.();this.stream?.getAudioTracks().forEach(t=>t.enabled=!this.muted);clearTimeout(this.timeout);this.send({type:'mute',muted:Boolean(this.muted)});this.status('');}this.changed?.();}
  attach(track,sid){
    if(this.closed||this.tracks.has(sid)||this.reconnecting)return;
    const binding=this.bindings.get(sid);if(!binding||binding.generation<this.minimumGeneration)return;
    this.playoutTargetMs??=160;this.configurePlayout(track);
    const source=this.context.createMediaStreamSource(new MediaStream([track.mediaStreamTrack])),gain=this.context.createGain(),analyser=this.context.createAnalyser();analyser.fftSize=256;
    source.connect(gain);gain.connect(analyser);analyser.connect(this.context.destination);
    const output={sid,track,source,gain,analyser,metrics:{}};this.tracks.set(sid,output);
    void this.beginSegment(output,binding.generation);
  }
  async readStats(track){
    let timer;try{return await Promise.race([track.getRTCStatsReport().catch(()=>undefined),new Promise(resolve=>{timer=setTimeout(()=>resolve(undefined),1000);})]);}finally{clearTimeout(timer);}
  }
  async beginSegment(o,generation){
    const token=o.token=(o.token||0)+1;
    Object.assign(o,{generation,started:false,ended:false,binding:true,metrics:{},created:performance.now(),lastLoud:performance.now(),samples:undefined,drainedAt:undefined,startedAt:undefined,lastProgressAt:0});
    const report=await this.readStats(o.track);
    if(this.closed||this.tracks.get(o.sid)!==o||o.token!==token||generation<this.minimumGeneration)return;
    o.baseline=report?{}:undefined;report?.forEach(row=>{if(row.type==='inbound-rtp'&&(row.kind==='audio'||row.mediaType==='audio'))for(const key of ['concealedSamples','concealmentEvents','packetsReceived','packetsLost','bytesReceived','totalSamplesReceived','jitterBufferEmittedCount','jitterBufferDelay','silentConcealedSamples','packetsDiscarded','insertedSamplesForDeceleration','removedSamplesForAcceleration'])if(Number.isFinite(row[key]))o.baseline[key]=row[key];});
    o.binding=false;o.created=performance.now();o.lastLoud=o.created;
    if(this.context.state==='running')this.send({type:'rtc_attached',connection:this.connection,generation,trackSid:o.sid});
  }
  configurePlayout(track){
    const receiver=track.receiver;let supported=0;
    try{if(receiver&&'jitterBufferTarget' in receiver){receiver.jitterBufferTarget=this.playoutTargetMs;supported=1;}else if(receiver&&'playoutDelayHint' in receiver){track.setPlayoutDelay(this.playoutTargetMs/1000);supported=1;}}catch{}
    this.playoutControlSupported=supported;
  }
  detach(sid){const o=this.tracks.get(sid);if(!o)return;const now=this.context.currentTime;o.gain.gain.cancelScheduledValues(now);o.gain.gain.setValueAtTime(o.gain.gain.value,now);o.gain.gain.linearRampToValueAtTime(0,now+.005);setTimeout(()=>{o.source.disconnect();o.gain.disconnect();o.analyser.disconnect();},10);this.tracks.delete(sid);this.bindings.delete(sid);}
  invalidate(generation){
    // Infinity is a local suspension; server's next clear supplies a finite boundary.
    this.minimumGeneration=generation;
    for(const [sid,o] of this.tracks){this.receipt(o,'interrupted','render_observed');this.detach(sid);}
    this.bindings.clear();
  }
  receipt(o,state,evidence){this.send({type:'rtc_playback',connection:this.connection,generation:o.generation,trackSid:o.sid,state,evidence,playedSamples:o.started?Math.floor(Math.max(0,performance.now()-o.startedAt)*24):0,stats:o.metrics});}
  reportState(){
    const now=performance.now();if(!this.diagnostics||this.closed||now-(this.lastStateAt||0)<2000||this.tracks.size&&this.context?.state==='running')return;this.lastStateAt=now;
    this.send({type:'rtc_stats',stats:{contextRunning:Number(this.context?.state==='running'),contextSampleRate:this.context?.sampleRate||0,attachedTracks:this.tracks.size,pendingTracks:this.bindings.size,muted:Number(Boolean(this.muted)),inputLevel:rms(this.inputLevel)}});
  }
  async observe(){
    if(this.closed||this.observing||this.context?.state!=='running')return;this.observing=true;
    try{for(const o of [...this.tracks.values()]){
      if(o.binding||o.ended)continue;const generation=o.generation;
      const now=performance.now(),level=rms(o.analyser);
      if(level>.0005){o.lastLoud=now;if(!o.started){o.started=true;o.startedAt=now;this.receipt(o,'started','render_observed');}}
      const report=await this.readStats(o.track);if(this.closed||this.tracks.get(o.sid)!==o||o.generation!==generation)continue;
      let emitted;const previousConcealed=o.metrics.concealed;
      const delta=(row,key)=>Math.max(0,row[key]-(o.baseline?.[key]||0));
      report?.forEach(row=>{if(row.type==='inbound-rtp'&&(row.kind==='audio'||row.mediaType==='audio')){
        if(!o.baseline){o.baseline={};for(const [key,value] of Object.entries(row))if(typeof value==='number'&&Number.isFinite(value))o.baseline[key]=value;}
        emitted=Number.isFinite(row.jitterBufferEmittedCount)?delta(row,'jitterBufferEmittedCount'):undefined;
        for(const key of ['silentConcealedSamples','packetsDiscarded','insertedSamplesForDeceleration','removedSamplesForAcceleration'])if(Number.isFinite(row[key]))o.metrics[key]=delta(row,key);
        if(Number.isFinite(row.concealedSamples))o.metrics.concealed=delta(row,'concealedSamples');
        if(Number.isFinite(row.jitter))o.metrics.maxJitterMs=Math.max(o.metrics.maxJitterMs||0,row.jitter*1000);
        if(Number.isFinite(row.concealmentEvents))o.metrics.underruns=delta(row,'concealmentEvents');
        for(const key of ['packetsReceived','packetsLost','bytesReceived','totalSamplesReceived'])if(Number.isFinite(row[key]))o.metrics[key]=delta(row,key);
        if(Number.isFinite(emitted))o.metrics.emittedSamples=emitted;
        if(emitted>0&&Number.isFinite(row.jitterBufferDelay))o.metrics.jitterBufferMs=delta(row,'jitterBufferDelay')*1000/emitted;
      }});
      // Native WebRTC owns fast adaptation. Only adjust the requested floor on
      // sustained evidence, and recover toward the baseline after stability.
      if(previousConcealed!==undefined&&o.metrics.concealed>previousConcealed){
        this.lastConcealmentAt=now;
        if(now-(this.lastTargetChange||0)>3000){this.playoutTargetMs=Math.min(400,(this.playoutTargetMs||160)+40);this.lastTargetChange=now;for(const output of this.tracks.values())this.configurePlayout(output.track);}
      }else if((this.playoutTargetMs||160)>160&&now-(this.lastConcealmentAt||now)>15000&&now-(this.lastTargetChange||0)>5000){
        this.playoutTargetMs=Math.max(160,this.playoutTargetMs-20);this.lastTargetChange=now;for(const output of this.tracks.values())this.configurePlayout(output.track);
      }
      Object.assign(o.metrics,{playoutTargetMs:this.playoutTargetMs,playoutControlSupported:this.playoutControlSupported});
      if(this.diagnostics&&now-(o.lastDiagnosticAt||0)>=2000){o.lastDiagnosticAt=now;this.send({type:'rtc_stats',stats:{generation:o.generation,...o.metrics,inputLevel:rms(this.inputLevel),outputLevel:level,contextRunning:Number(this.context.state==='running'),contextSampleRate:this.context.sampleRate,outputLatencyMs:(this.context.outputLatency||0)*1000,muted:Number(Boolean(this.muted))}});}
      if(o.started&&now-(o.lastProgressAt||0)>1000){o.lastProgressAt=now;this.receipt(o,'progress','estimated');}
      if(!o.drainedAt||o.ended||now-o.lastLoud<400)continue;
      const duration=o.samples/o.sampleRate,elapsed=(now-(o.startedAt||o.created))/1000;
      // RTP counters include silence/concealment and are not a segment render
      // cursor on a shared track. Completion is explicitly an estimate.
      if((o.started&&elapsed>=duration+.5||o.samples===0)&&now-o.drainedAt>Math.max(800,(this.playoutTargetMs||160)+400)){
        o.ended=true;this.receipt(o,'ended','estimated');
        // Keep the graph and RTC subscription warm for the next segment.
      }
    }}finally{this.observing=false;}
  }
  energy(){if(this.closed||this.context?.state!=='running')return {input:0,output:0,level:0,speaker:'waiting'};let output=0;for(const o of this.tracks.values())output=Math.max(output,rms(o.analyser));const input=this.muted?0:rms(this.inputLevel);return {input,output,speaker:output>.008?'assistant':input>.015?'user':'waiting',level:Math.min(1,Math.max(output*5,input*3))};}
  mute(){this.muted=!this.muted;for(const track of this.stream?.getAudioTracks()||[])track.enabled=!this.muted;this.send({type:'mute',muted:this.muted});return this.muted;}
  async resume(){if(this.closed)return;try{await this.context.resume();this.needsResume=this.context.state!=='running';if(!this.needsResume){this.stream?.getAudioTracks().forEach(t=>t.enabled=!this.muted);this.minimumGeneration=0;this.send({type:'mute',muted:Boolean(this.muted)});this.status('');this.syncReady();}}catch{this.needsResume=true;}this.changed?.();}
  async devices(){return navigator.mediaDevices.enumerateDevices();}
  async setInputDevice(deviceId){if(this.closed)return;await this.localTrack.setDeviceId(deviceId);this.stream=new MediaStream([this.localTrack.mediaStreamTrack]);this.input.disconnect();this.input=this.context.createMediaStreamSource(this.stream);this.input.connect(this.inputLevel);this.localTrack.mediaStreamTrack.enabled=!this.muted;}
  async setOutputDevice(deviceId){if(typeof this.context.setSinkId==='function')await this.context.setSinkId(deviceId);}
  disconnect(message,cause='rtc_transport',error){
    if(this.closed)return;
    const diagnostics={cause,stage:this.connectionStage||'control'};
    for(const key of ['code','reason','status'])if(Number.isSafeInteger(error?.[key])&&error[key]>=0&&error[key]<=9999)diagnostics[key]=error[key];
    this.send({type:'pause',rtc:diagnostics});
    // Only startup connection failures can change transports. A running call,
    // user cancellation, suspended microphone or authentication rejection cannot.
    if(!this.everReady&&Number.isSafeInteger(this.connection)&&this.context?.state==='running'&&this.stream?.getAudioTracks().some(t=>t.readyState==='live')
      &&['rtc_transport','rtc_join','rtc_disconnected','startup_timeout'].includes(cause)&&error?.reason!==ConnectionErrorReason.NotAllowed&&error?.status!==401&&error?.status!==403){
      const socket=this.socket;
      const closed=new Promise(resolve=>{if(!socket||socket.readyState===WebSocket.CLOSED){resolve();return;}const timer=setTimeout(resolve,3000);socket.addEventListener('close',()=>{clearTimeout(timer);resolve();},{once:true});});
      this.fallbackAudio={context:this.context,previous:this.previousAudioSession,closed};
    }
    this.status(message);this.close();
  }
  close(){
    if(this.closed)return;this.closed=true;clearInterval(this.heartbeat);clearInterval(this.observer);clearTimeout(this.timeout);
    this.invalidate(Infinity);this.socket?.close();void this.room?.disconnect();this.localTrack?.stop();this.stream?.getTracks().forEach(t=>t.stop());
    if(this.context)this.context.onstatechange=null;this.input?.disconnect();this.inputLevel?.disconnect();this.inputSilent?.disconnect();
    if(!this.fallbackAudio)void this.context?.close().catch(()=>{});
    document.removeEventListener('visibilitychange',this.visible);navigator.mediaDevices?.removeEventListener?.('devicechange',this.deviceChanged);
    if(!this.fallbackAudio&&this.previousAudioSession!==undefined&&navigator.audioSession?.type==='play-and-record')navigator.audioSession.type=this.previousAudioSession;
    this.connectionFailed?.(new Error('RTC connection closed'));
    this.changed?.(true);
  }
}
window.ZigentRtcMeetingAudio=RtcMeetingAudio;
