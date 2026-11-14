import { el, updateText } from '../dom.js';
import { assetUrl, loadScript, versionsReady } from '../lazy-assets.js';
function attachOrb(host, options) {
  let ended = false, inCall = false, real;
  const visual = {
    setEnded(value) { ended = Boolean(value); real?.setEnded(ended); },
    setCall(value) { inCall = Boolean(value); host.dataset.mode = inCall ? 'call' : 'invitation'; real?.setCall(inCall); }
  };
  // The built module lives next to the other components. assetUrl stamps the version from this page's map.
  void versionsReady.then(() => import(assetUrl('./components/meeting-orb.js'))).then(({ createMeetingOrb }) => {
    if (!host.isConnected) return;
    real = createMeetingOrb(host, options);
    real.setEnded(ended); real.setCall(inCall);
  }).catch(error => { console.error(error); });
  return visual;
}
let active;
let diagnosticsEnabled=false;try{diagnosticsEnabled=localStorage.getItem('zigent-meeting-diagnostics')==='1';}catch{}
class MeetingAudio {
  constructor(id, status, changed) { this.id=id; this.status=status; this.changed=changed; this.playbackEpoch=0; this.audioStats={maxCaptureDelayMs:0,maxBufferedBytes:0}; }
  async start(conversationId, preflight) {
    if(active) throw new Error('请先结束当前会议。');
    if(!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.AudioContext || !window.AudioWorkletNode) throw new Error('当前浏览器不支持实时语音，请使用新版 Safari 或 Chrome。');
    active=this;
    try {
      // Select duplex routing before Safari opens the AudioContext. Otherwise
      // enabling the microphone can switch the already-running output session.
      if(!this.preparedContext&&navigator.audioSession){try{this.previousAudioSession=navigator.audioSession.type;navigator.audioSession.type='play-and-record';}catch{}}
      this.context=this.preparedContext||new AudioContext({latencyHint:'interactive'}); await Promise.race([this.context.resume(),new Promise(resolve=>setTimeout(resolve,1000))]);
      if(this.closed)return;
      await loadScript('./speech.js');
      if(this.closed)return;
      this.stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      if(this.closed){this.stream.getTracks().forEach(t=>t.stop());return;}
      const settings=this.stream.getAudioTracks()[0]?.getSettings();
      Object.assign(this.audioStats,{contextSampleRate:this.context.sampleRate,trackSampleRate:settings?.sampleRate||0,
        baseLatencyMs:Math.round((this.context.baseLatency||0)*1000),outputLatencyMs:Math.round((this.context.outputLatency||0)*1000)});
      await window.ZigentSpeechInput.loadWorklet(this.context);
      if(this.closed)return;
      this.playback=new AudioWorkletNode(this.context,'zigent-playback',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[1]});
      this.playback.port.onmessage=({data})=>{
        if(this.closed||data.epoch!==this.playbackEpoch)return;
        if(data.type==='started')this.send({type:'speaking',generation:this.outputGeneration});
        if(data.type==='underrun')this.send({type:'underrun',generation:this.outputGeneration});
        if(data.type==='progress'||data.type==='drained'){
          this.audioStats.maxPlaybackQueueMs=Math.max(this.audioStats.maxPlaybackQueueMs||0,data.maxQueueMs);
          this.audioStats.playbackQueueMs=data.queueMs;
          this.audioStats.playbackTargetMs=data.targetMs;this.audioStats.playbackJitterMs=data.jitterMs;
          if(data.type==='drained'||this.diagnostics&&performance.now()-(this.lastDiagnosticAt||0)>=2000){this.lastDiagnosticAt=performance.now();this.send({type:'audio_stats',...this.audioStats});}
          this.send({type:'playback',generation:this.outputGeneration,consumedSamples:data.consumedSamples,drained:data.type==='drained'});
        }
        if(data.type==='recover')this.recoverPlayback(data.cause);
      };
      this.outputLevel=this.context.createAnalyser();this.outputLevel.fftSize=256;this.outputLevel.connect(this.context.destination);
      this.playback.connect(this.outputLevel);
      if(this.closed)return;
      await preflight();
      if(this.closed)return;
      const root=new URL('./api/meeting/stream',location.href);root.protocol=location.protocol==='https:'?'wss:':'ws:';
      this.socket=new WebSocket(root,'zigent-meeting-v1');
      this.socket.onopen=()=>{this.send({type:'join',id:this.id,conversationId,audioProtocol:3});this.setDiagnostics(Boolean(this.diagnostics));};
      this.socket.onmessage=e=>{
        if(this.closed)return;
        const data=JSON.parse(e.data);
        if(data.type==='error'){this.status(data.message||'会议未能连接，请重新加入。');this.close();return;}
        if(data.type==='ready'){
          if(data.audioProtocol!==3){this.disconnect('语音服务正在更新，请稍后刷新重试。');return;}
          this.ready=true;this.syncAudio(true);this.status('');this.changed?.();
        }
        if((data.type==='clear'||data.type==='audio_start')&&Number.isSafeInteger(data.generation)&&data.generation>=(this.outputGeneration??0)){
          this.outputGeneration=data.generation;this.clear();this.acceptAudio=data.type==='audio_start';
        }
        if(data.type==='audio'&&this.acceptAudio&&data.generation===this.outputGeneration&&typeof data.audio==='string')this.play(data.audio,data.offset);
        if(data.type==='ended')this.close();
        if(data.type==='paused'){this.status(data.message||'通话已暂停，可重新连接。');this.close();}
        if(data.type==='audio_done'&&this.acceptAudio&&data.generation===this.outputGeneration)this.playback.port.postMessage({type:'end',epoch:this.playbackEpoch});
      };
      this.socket.onclose=()=>{if(!this.closed)this.status('通话已断开，点击光球重试。');this.close();};this.socket.onerror=()=>{if(this.closed)return;this.status('连接已断开，请点重新连接。');this.close();};
      this.input=this.context.createMediaStreamSource(this.stream);this.worklet=new AudioWorkletNode(this.context,'zigent-pcm',{processorOptions:{frameSamples:320}});
      // The audio thread supplies 20 ms frames. The supplier worker relays this
      // live stream without imposing a second, drifting media clock.
      this.worklet.port.onmessage=e=>{
        if(this.closed||!e.data.pcm||!this.ready||this.muted||this.audioPaused||this.socket?.readyState!==1)return;
        if(e.data.audioTime<this.captureAfter)return;
        const delay=Math.max(0,(this.context.currentTime-e.data.audioTime)*1000),buffered=this.socket.bufferedAmount,now=performance.now();
        this.audioStats.maxCaptureDelayMs=Math.max(this.audioStats.maxCaptureDelayMs,Math.round(delay));
        this.audioStats.maxBufferedBytes=Math.max(this.audioStats.maxBufferedBytes,buffered);
        if(delay>1200){this.disconnect('音频采集已中断，请重新连接。','capture_stall');return;}
        if(buffered>12800)this.blockedAt??=now;else this.blockedAt=undefined;
        if(buffered>38400||this.blockedAt!==undefined&&now-this.blockedAt>1000){this.disconnect('网络发送拥堵，请重新连接。','browser_backpressure');return;}
        this.audioStats.captureFrames=(this.audioStats.captureFrames||0)+1;
        if(this.captureClockStart===undefined){this.captureClockStart=e.data.audioTime;this.captureWallStart=now;}
        const wall=now-this.captureWallStart;
        if(wall>=1000)this.audioStats.captureClockRatio=Math.round((e.data.audioTime-this.captureClockStart)*1e6/wall)/1000;
        this.socket.send(e.data.pcm);
      };
      this.inputLevel=this.context.createAnalyser();this.inputLevel.fftSize=256;
      this.input.connect(this.inputLevel);this.inputLevel.connect(this.worklet);this.worklet.connect(this.context.destination);
      this.context.onstatechange=()=>this.audioState();
      for(const track of this.stream.getAudioTracks()){track.onmute=track.onunmute=()=>this.audioState();track.onended=()=>this.disconnect('麦克风已断开，请重新连接。');}
      this.visible=()=>{if(!document.hidden)void this.resume();};document.addEventListener('visibilitychange',this.visible);
      this.audioState();
      this.heartbeat=setInterval(()=>{this.send({type:'heartbeat'});this.send({type:'audio_stats',...this.audioStats});},5000);
      this.timer=setTimeout(()=>{if(!this.ready){this.disconnect('会议连接超时，请重新连接。');}},25000);
    }catch(error){this.close();throw error;}
  }
  send(value){if(this.socket?.readyState===1)this.socket.send(JSON.stringify(value));}
  setDiagnostics(enabled){this.diagnostics=enabled;this.send({type:'audio_diagnostics',enabled});}
  syncAudio(force=false){
    if(this.closed)return;
    const paused=this.context?.state!=='running'||Boolean(this.stream?.getAudioTracks().some(t=>t.muted));
    this.needsResume=paused;
    const muted=Boolean(this.muted||paused);
    if(force||this.audioPaused!==muted){this.audioPaused=muted;this.captureAfter=this.context.currentTime;this.captureClockStart=undefined;this.blockedAt=undefined;if(paused){this.acceptAudio=false;this.clear();this.send({type:'audio-pause'});}this.send({type:'mute',muted});}
    this.changed?.();
  }
  audioState(){if(this.closed)return;this.syncAudio();if(this.needsResume){this.status('音频已暂停，可点继续通话。');void this.resume();}}
  async resume(){
    if(this.closed||this.resuming)return;this.resuming=true;
    try{await Promise.race([this.context.resume(),new Promise(resolve=>setTimeout(resolve,1000))]);if(this.closed)return;this.syncAudio();if(!this.needsResume)this.status('');}
    catch{if(!this.closed)this.status('音频已暂停，可点继续通话。');}
    finally{this.resuming=false;}
  }
  mute(){this.muted=!this.muted;for(const t of this.stream?.getAudioTracks()||[])t.enabled=!this.muted;this.syncAudio();return this.muted;}

  play(base64,offset){
    if(this.closed)return;
    if(this.context.state!=='running'){this.audioState();return;}
    const incoming=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
    // The server joins partial supplier samples and sends sequenced 40 ms
    // frames. Validate before handing ownership to the render thread.
    if(offset!==this.receivedSamples||incoming.length%2||incoming.length>1920){this.recoverPlayback('playback_sequence');return;}
    const data=new DataView(incoming.buffer),samples=new Float32Array(incoming.length/2);
    for(let i=0;i<samples.length;i++)samples[i]=data.getInt16(i*2,true)/32768;
    this.receivedSamples+=samples.length;
    if(samples.length)this.playback.port.postMessage({type:'pcm',epoch:this.playbackEpoch,offset,samples:samples.buffer},[samples.buffer]);
  }
  recoverPlayback(cause){
    if(!this.acceptAudio)return;
    this.audioStats.playbackRecoveries=(this.audioStats.playbackRecoveries||0)+1;
    this.send({type:'audio_stats',...this.audioStats});
    this.send({type:'playback_recover',generation:this.outputGeneration,cause});
    this.acceptAudio=false;this.clear();
  }
  energy(){
    if(this.closed||this.context?.state!=='running')return {input:0,output:0,level:0,speaker:'waiting'};
    const rms=analyser=>{if(!analyser)return 0;const values=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(values);return Math.sqrt(values.reduce((sum,v)=>sum+v*v,0)/values.length);};
    const output=rms(this.outputLevel),input=this.muted||this.audioPaused?0:rms(this.inputLevel);
    return {input,output,speaker:output>.008?'assistant':input>.015?'user':'waiting',level:Math.min(1,Math.max(output*5,input*3))};
  }
  clear(){this.receivedSamples=0;this.playbackEpoch++;this.playback?.port.postMessage({type:'clear',epoch:this.playbackEpoch});}
  disconnect(message,cause){this.status(message);this.send({type:'audio_stats',...this.audioStats});this.send({type:'pause',cause});this.close();}
  close(){if(this.closed)return;this.closed=true;clearInterval(this.heartbeat);clearTimeout(this.timer);this.clear();if(this.visible)document.removeEventListener('visibilitychange',this.visible);
    if(this.context)this.context.onstatechange=null;
    for(const track of this.stream?.getTracks()||[]){track.onended=track.onmute=track.onunmute=null;track.stop();}
    if(this.previousAudioSession!==undefined&&navigator.audioSession?.type==='play-and-record'){try{navigator.audioSession.type=this.previousAudioSession;}catch{}}
    this.socket?.close();this.inputLevel?.disconnect();this.outputLevel?.disconnect();this.playback?.disconnect();this.worklet?.disconnect();this.input?.disconnect();void this.context?.close().catch(()=>{});if(active===this)active=undefined;this.changed?.(true);}
}
window.addEventListener('pagehide',()=>active?.disconnect('通话已暂停，可重新连接。'));

const controlPaths={
  mute:'<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M6 11v1a6 6 0 0 0 12 0v-1M12 18v3m-3 0h6"/><path class="meeting-mic-slash" d="m3 3 18 18"/>',
  end:'<path d="M5 16.5 3.5 14a2 2 0 0 1 .3-2.5 12 12 0 0 1 16.4 0 2 2 0 0 1 .3 2.5L19 16.5a1 1 0 0 1-1.3.4l-3-1.5a1 1 0 0 1-.6-.9v-2a9 9 0 0 0-4.2 0v2a1 1 0 0 1-.6.9l-3 1.5a1 1 0 0 1-1.3-.4Z"/>'
};
function voiceControl(button,name,label){
  const symbol=el('span','meeting-control-symbol'),caption=el('span','meeting-control-label',label);
  // Only application-owned paths enter this markup.
  symbol.innerHTML=`<svg viewBox="0 0 24 24" aria-hidden="true">${controlPaths[name]}</svg>`;
  button.replaceChildren(symbol,caption);button.setAttribute('aria-label',label);button.title=label;return caption;
}
const reducedMotion=()=>window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function animateOrb(v,before,drop=false){
  v.orbAnimation?.cancel();
  const after=v.orb.getBoundingClientRect();
  if(reducedMotion()||!before.width||!after.width)return;
  const x=before.x+before.width/2-after.x-after.width/2,y=before.y+before.height/2-after.y-after.height/2,scale=before.width/after.width;
  const transform=(x,y,sx,sy=sx)=>`translate(${x}px,${y}px) scale(${sx},${sy})`;
  const frames=drop?[
    {offset:0,transform:transform(x,y,scale),easing:'cubic-bezier(.45,0,.8,.5)'},
    {offset:.43,transform:transform(x*.05,-18,1.01,1.09),easing:'ease-in'},
    {offset:.55,transform:transform(0,10,1.075,.91),easing:'cubic-bezier(.2,.7,.4,1)'},
    {offset:.74,transform:transform(0,-10,.98,1.035),easing:'ease-in-out'},
    {offset:.89,transform:transform(0,3,1.015,.99),easing:'ease-out'},
    {offset:1,transform:transform(0,0,1)}
  ]:[{transform:transform(x,y,scale)},{transform:transform(0,0,1)}];
  v.orbAnimation=v.orb.animate(frames,{duration:drop?740:520,easing:drop?'linear':'cubic-bezier(.22,1,.36,1)'});
}
function setTranscript(v,show){
  if(!v.open||v.showTranscript===show)return;
  const before=v.orb.getBoundingClientRect();v.showTranscript=show;v.update?.();
  animateOrb(v,before,show);
  if(show){
    if(!reducedMotion())v.lines.animate([{opacity:0,transform:'translateY(-8px)'},{opacity:1,transform:'translateY(0)'}],{duration:300,easing:'ease-out'});
    v.follow=true;requestAnimationFrame(()=>{if(v.follow)v.lines.scrollTop=v.lines.scrollHeight;});
  }
}
function setOpen(v,open){
  if(v.open===open)return;
  const before=v.orb.getBoundingClientRect(),focused=document.activeElement===v.orb||document.activeElement===v.titleButton;
  v.open=open;if(!open)v.showTranscript=false;
  v.node.classList.toggle('is-open',open);v.entry.hidden=open;v.body.hidden=!open;
  (open?v.orbDock:v.entry).append(v.orb);v.titleButton.setAttribute('aria-expanded',String(open));v.update?.();
  animateOrb(v,before);
  if(focused)v.orb.focus({preventScroll:true});
}
function dateLabel(timestamp){
  const date=new Date(timestamp),today=new Date(),tomorrow=new Date();tomorrow.setDate(today.getDate()+1);
  const day=date.toDateString()===today.toDateString()?'今天':date.toDateString()===tomorrow.toDateString()?'明天':new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric'}).format(date);
  return `${day} ${new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}).format(date)}`;
}
function invitationCopy(item,m,future,expired){
  const topic=String(item.description||'接下来要做的事').trim().replace(/[。！？!?，,；;：:\s]+$/u,'');
  const opener=String(m.invitationText||`想和你聊聊${topic}`).trim().replace(/[。！？!?，,；;：:\s]+$/u,'');
  const minutes=Math.ceil((m.targetSeconds||180)/60);
  const question=expired?m.reason||'这次邀请已结束':m.phase==='idle'||m.phase==='paused'?'要不要接着聊？':future?`${dateLabel(m.scheduledAt)}，聊 ${minutes} 分钟？`:`要不要聊 ${minutes} 分钟？`;
  return {opener:`${opener}，`,question};
}
export function renderMeeting(item,message,view,{api,conversation,refresh}){
  if(!view?.meetingView){
    const node=el('section','zigent-meeting'),entry=el('div','meeting-entry'),titleButton=el('button','meeting-entry-label'),title=el('span','meeting-title'),meta=el('span','meeting-meta'),badge=el('span','meeting-badge'),
      orb=el('button','meeting-orb'),sphere=el('span','meeting-sphere'),acceptArea=el('div','meeting-accept-area'),accept=el('button','meeting-accept','接受邀请'),
      body=el('div','meeting-body'),header=el('div','meeting-call-header'),elapsed=el('time','meeting-session-time','00:00'),controls=el('div','meeting-controls'),
      stage=el('div','meeting-stage'),lines=el('div','meeting-lines'),orbDock=el('div','meeting-orb-dock'),statusLine=el('div','meeting-status'),stateLabel=el('span'),
      devices=el('details','meeting-devices'),deviceTitle=el('summary','','设备'),inputDevice=el('select'),outputDevice=el('select'),diagnostics=el('button','meeting-diagnostics','测试模式'),mute=el('button','meeting-mute'),end=el('button','meeting-end'),feedback=el('p','interaction-feedback');
    for(const button of [titleButton,orb,accept,diagnostics,mute,end])button.type='button';
    sphere.setAttribute('aria-hidden','true');orb.append(sphere);titleButton.append(title,meta,badge);entry.append(titleButton,orb);acceptArea.append(accept);
    lines.id=`meeting-lines-${item.id}`;lines.tabIndex=0;lines.setAttribute('role','region');lines.setAttribute('aria-label','实时字幕');orb.setAttribute('aria-controls',lines.id);
    elapsed.setAttribute('aria-label','通话时长');elapsed.setAttribute('aria-live','off');
    stateLabel.setAttribute('role','status');statusLine.append(stateLabel);feedback.setAttribute('role','status');
    const muteLabel=voiceControl(mute,'mute','静音');voiceControl(end,'end','挂断');
    inputDevice.setAttribute('aria-label','麦克风');outputDevice.setAttribute('aria-label','扬声器');devices.append(deviceTitle,inputDevice,outputDevice);devices.hidden=true;controls.append(diagnostics,devices,mute,end);header.append(elapsed,controls);orbDock.append(statusLine);stage.append(lines,orbDock);body.append(header,stage);
    node.append(entry,acceptArea,body,feedback);body.hidden=true;acceptArea.hidden=true;
    view={node,entry,titleButton,title,meta,badge,orb,orbDock,acceptArea,accept,body,header,stage,statusLine,stateLabel,elapsed,lines,controls,devices,inputDevice,outputDevice,diagnostics,mute,muteLabel,end,feedback,meetingView:true,lineNodes:new Map(),follow:true};
    const v=view;lines.onscroll=()=>{v.follow=lines.scrollHeight-lines.scrollTop-lines.clientHeight<40;};
    v.orbVisual=attachOrb(sphere,{
      sample:()=>{const audio=active?.id===v.item?.id?active:undefined;return audio?.ready&&!audio.closed?audio.energy():{input:0,output:0};},
      detached:()=>{if(active?.id===v.item?.id)active.disconnect('通话已暂停，可重新连接。');}
    });
  }
  const v=view,m=item.meeting||{},conversationId=conversation.current;v.item=item;v.message=message;v.meeting=m;
  const local=()=>active?.id===item.id?active:undefined;
  const request=actionId=>api('interactions','POST',{conversationId,messageId:message.id,interactionId:item.id,actionId});
  const status=text=>{v.audioStatus=text;updateText(v.feedback,text);v.feedback.hidden=!text;};
  const future=()=>m.phase==='invited'&&m.scheduled&&Date.now()<m.scheduledAt;
  const terminal=()=>m.phase==='ended'||(m.phase==='invited'&&m.expiresAt&&Date.now()>=m.expiresAt);
  const update=()=>{
    const audio=local(),live=['connecting','active','ending'].includes(m.phase),expired=terminal();
    const open=Boolean(v.open),waiting=future(),syncing=m.calendarStatus==='syncing';
    v.node.dataset.phase=expired?'ended':m.phase||'invited';v.node.classList.toggle('has-transcript',Boolean(open&&v.showTranscript));
    const copy=invitationCopy(item,m,waiting,expired);updateText(v.title,copy.opener);updateText(v.meta,copy.question);v.titleButton.title=`${copy.opener}${copy.question}`;
    updateText(v.badge,waiting&&m.acceptedAt?'已接受':'');v.badge.hidden=!v.badge.textContent;
    v.titleButton.disabled=Boolean(expired);v.orb.disabled=Boolean(expired||syncing||!open&&v.joining&&!audio);
    const orbLabel=expired?'邀请已失效':open?v.showTranscript?'收起字幕':'展开字幕':waiting?m.acceptedAt?'已接受邀请':'展开接受邀请':'开始语音对话';
    v.orb.setAttribute('aria-label',orbLabel);v.orb.setAttribute('aria-expanded',String(Boolean(open&&v.showTranscript)));v.orb.title=orbLabel;v.titleButton.setAttribute('aria-label',`${copy.opener}${copy.question}，${orbLabel}`);
    v.acceptArea.hidden=!(waiting&&v.acceptExpanded&&!m.acceptedAt);v.accept.disabled=syncing;updateText(v.accept,syncing?'接受中…':'接受邀请');
    v.lines.hidden=!(open&&v.showTranscript);
    v.diagnostics.setAttribute('aria-pressed',String(diagnosticsEnabled));v.diagnostics.title='记录音频诊断数据';
    v.devices.hidden=!audio?.ready||!audio?.devices;
    v.mute.hidden=!audio?.ready;v.mute.disabled=!audio?.ready;v.mute.setAttribute('aria-pressed',String(Boolean(audio?.muted)));
    const muteText=audio?.muted?'取消静音':'静音';updateText(v.muteLabel,muteText);v.mute.setAttribute('aria-label',muteText);v.mute.title=muteText;
    v.end.hidden=!open;v.end.disabled=Boolean(v.ending);
    if(open){
      const seconds=m.startedAt&&!m.endedAt?Math.max(0,Math.floor((Date.now()-m.startedAt)/1000)):0;
      const state=expired?'邀请已失效':audio?.needsResume?'点击光球继续':v.joining||m.phase==='connecting'?'正在连接':audio?.ready?audio.muted?'已静音':'':m.phase==='paused'?'点击光球重新连接':live?'正在另一窗口通话':m.phase==='idle'?'点击光球继续':'';
      updateText(v.stateLabel,state);v.statusLine.hidden=!state;v.elapsed.dateTime=`PT${seconds}S`;updateText(v.elapsed,`${Math.floor(seconds/60).toString().padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`);
    }
    v.node.classList.toggle('is-connecting',Boolean(v.joining||m.phase==='connecting'));
    const feedback=m.calendarError||v.audioStatus||'';updateText(v.feedback,feedback);v.feedback.hidden=!feedback;
    v.orbVisual.setEnded(Boolean(expired));
    v.orbVisual.setCall(Boolean(open&&!expired));
  };v.update=update;
  if(local()&&['connecting','active','ending'].includes(m.phase))local().serverSeen=true;
  if((terminal()||m.phase==='idle'&&local()?.serverSeen)&&local())local().close();
  // Keep streaming rows stable so selection, scroll position and focus survive SSE updates.
  for(const l of m.transcript||[]){
    const key=`${l.role}:${l.id}`;let row=v.lineNodes.get(key);
    if(!row){row=el('p','meeting-line');row.append(el('strong','',l.role==='user'?'你':'Zigent'),el('span'));v.lineNodes.set(key,row);v.lines.append(row);}
    updateText(row.lastChild,`${l.text}${l.interrupted?'（已打断）':''}`);
  }
  if(v.showTranscript&&v.follow)requestAnimationFrame(()=>{if(v.follow)v.lines.scrollTop=v.lines.scrollHeight;});
  const enter=async()=>{
    if(terminal()||v.joining)return;
    if(future()){v.acceptExpanded=!v.acceptExpanded;update();return;}
    if(local()){
      setOpen(v,true);await local().resume();if(local()?.needsResume)local().disconnect('音频需要重新连接，点击光球重试。');update();return;
    }
    if(['connecting','active','ending'].includes(m.phase)){setOpen(v,true);return;}
    v.joining=true;v.audioStatus='';v.disconnected=false;setOpen(v,true);update();
    const target=conversation.current;
    // Unlock iOS output in the original click, before HTTP or SDK loading.
    let prepared;
    try{
      const previous=navigator.audioSession?.type;if(navigator.audioSession)navigator.audioSession.type='play-and-record';
      const context=new AudioContext({latencyHint:'interactive'});void context.resume().catch(()=>{});
      let disposed=false;prepared={context,previous,close:()=>{if(disposed)return;disposed=true;void context.close().catch(()=>{});if(previous!==undefined&&navigator.audioSession?.type==='play-and-record')navigator.audioSession.type=previous;}};v.preflightAudio=prepared;
    }catch{v.joining=false;status('当前浏览器不支持实时语音。');setOpen(v,false);update();return;}
    const attempt=v.joinAttempt=(v.joinAttempt||0)+1;
    let transport;
    try{transport=await request('join');if(transport.mediaTransport==='rtc')try{await loadScript('./meeting-rtc.js');}catch{transport.mediaTransport='legacy';}}
    catch(error){prepared.close();v.preflightAudio=undefined;v.joining=false;status(error.message||'会议连接未完成，请重试。');setOpen(v,false);update();return;}
    if(v.joinAttempt!==attempt||!v.joining){prepared.close();return;}
    if(active){prepared.close();v.preflightAudio=undefined;v.joining=false;status('请先结束当前会议。');setOpen(v,false);update();return;}
    const AudioClass=transport.mediaTransport==='rtc'?window.ZigentRtcMeetingAudio:MeetingAudio;
    const audio=new AudioClass(item.id,status,closed=>{
      if(closed&&audio.fallbackAudio){if(active===audio)active=undefined;return;}
      if(closed){if(active===audio)active=undefined;v.joining=false;v.disconnected=true;setOpen(v,false);void refresh().catch(()=>{});}
      v.update();
    });
    audio.diagnostics=diagnosticsEnabled;
    audio.preparedContext=prepared.context;audio.previousAudioSession=prepared.previous;v.preflightAudio=undefined;
    v.startingAudio=audio;
    try{if(transport.mediaTransport==='rtc')active=audio;await audio.start(target,async()=>{});}
    catch(error){
      if(audio.fallbackAudio){
        const fallback=audio.fallbackAudio;audio.fallbackAudio=undefined;
        const legacy=new MeetingAudio(item.id,status,closed=>{if(closed){v.joining=false;v.disconnected=true;setOpen(v,false);void refresh().catch(()=>{});}v.update();});
        legacy.context=legacy.preparedContext=fallback.context;legacy.previousAudioSession=fallback.previous;
        legacy.muted=audio.muted;legacy.diagnostics=diagnosticsEnabled;
        v.startingAudio=legacy;
        try{
          await fallback.closed;
          if(v.joinAttempt!==attempt||legacy.closed||document.hidden){legacy.close();return;}
          await request('join');
          if(v.joinAttempt!==attempt||legacy.closed){legacy.close();return;}
          status('正在重新连接…');setOpen(v,true);await legacy.start(target,async()=>{});
        }catch(failure){legacy.close();status(failure.message||'连接未完成，点击光球重试。');}
        finally{if(v.startingAudio===legacy){v.joining=false;v.startingAudio=undefined;}v.update();}
      }else if(v.startingAudio===audio){status(error?.name==='NotAllowedError'?'请允许使用麦克风后重试。':error.message||'连接未完成，点击光球重试。');setOpen(v,false);}
    }
    finally{if(v.startingAudio===audio){v.joining=false;v.startingAudio=undefined;}v.update();}
  };
  v.orb.onclick=()=>{if(v.open){if(local()?.needsResume)void local().resume();setTranscript(v,!v.showTranscript);}else void enter();};v.titleButton.onclick=()=>void enter();
  v.accept.onclick=async()=>{try{await request('accept');await refresh();}catch(error){status(error.message||'接受未完成，请重试。');}};
  v.devices.ontoggle=()=>{const audio=local();if(!v.devices.open||!audio?.devices)return;void audio.devices().then(list=>{
    for(const [select,kind] of [[v.inputDevice,'audioinput'],[v.outputDevice,'audiooutput']]){
      const value=select.value;select.replaceChildren();for(const d of list.filter(d=>d.kind===kind)){const option=el('option','',d.label||(kind==='audioinput'?'麦克风':'扬声器'));option.value=d.deviceId;select.append(option);}if([...select.options].some(o=>o.value===value))select.value=value;
    }
    v.outputDevice.hidden=typeof audio.context?.setSinkId!=='function';
  }).catch(()=>status('设备读取失败，请重试。'));};
  v.inputDevice.onchange=()=>void local()?.setInputDevice(v.inputDevice.value).catch(()=>status('麦克风切换失败，请重试。'));
  v.outputDevice.onchange=()=>void local()?.setOutputDevice(v.outputDevice.value).catch(()=>status('扬声器切换失败，请重试。'));
  v.diagnostics.onclick=()=>{diagnosticsEnabled=!diagnosticsEnabled;try{localStorage.setItem('zigent-meeting-diagnostics',diagnosticsEnabled?'1':'0');}catch{}(local()||v.startingAudio)?.setDiagnostics?.(diagnosticsEnabled);v.update();};
  v.mute.onclick=()=>{local()?.mute();v.update();};
  v.end.onclick=async()=>{
    if(v.ending)return;v.ending=true;update();
    try{
      // A cancelled microphone prompt must never connect after the user leaves.
      if(v.joining&&!local()?.ready){v.joinAttempt=(v.joinAttempt||0)+1;v.preflightAudio?.close();v.preflightAudio=undefined;v.startingAudio?.close();v.startingAudio=undefined;v.joining=false;setOpen(v,false);await refresh();}
      else {await request('end');local()?.close();setOpen(v,false);await refresh();}
      status('');
    }catch(error){status(error.message||'结束未完成，请重试。');await refresh().catch(()=>{});}
    finally{v.ending=false;v.update();}
  };
  clearTimeout(v.startTimer);
  const tick=()=>{
    if(!v.node.isConnected)return;v.update();
    const live=Boolean(v.open);
    if(live||m.phase==='invited')v.startTimer=setTimeout(tick,live?1000:Math.max(250,Math.min(60000,(future()?m.scheduledAt:m.expiresAt||Date.now()+60000)-Date.now())));
  };v.startTimer=setTimeout(tick,1000);
  update();return v;
}
