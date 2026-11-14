import { randomUUID } from 'node:crypto';

// Fixed numeric fields only. Never pass speech, identifiers, arbitrary client
// objects or SDK errors to diagnostics. The trace ID is unrelated to user data.
const keys = ['storageBytes','storageQuotaBytes','pendingWriteBytes','trackPublications','trackReuses','maxNativeCaptureMs','maxSpoolReadMs','tailPaddingSamples','playedSamples','generation','samples','generatedSamples','sentSamples','queuedMs','nativeQueuedMs','waitingForAttach',
  'pendingLimitMs','playoutTargetMs','playoutControlSupported','silentConcealedSamples','packetsDiscarded','insertedSamplesForDeceleration','removedSamplesForAcceleration','maxBufferedMs','recoveries','sourceStarvations','maxPacketGapMs','maxAttachMs','clearedSamples','inputFrames',
  'maxFrameMs','p95FrameMs','attachMs','concealed','underruns','maxJitterMs','packetsReceived','packetsLost',
  'bytesReceived','emittedSamples','totalSamplesReceived','jitterBufferMs','inputLevel','outputLevel',
  'receivedSamples','renderedSamples','maxInFlightMs','creditWaits','completed','playbackQueueMs','maxPlaybackQueueMs','playbackTargetMs','playbackJitterMs','playbackRecoveries','captureFrames','captureClockRatio','trackSampleRate','baseLatencyMs','attachedTracks','pendingTracks','contextRunning','contextSampleRate','outputLatencyMs','muted','enabled','estimated','elapsedMs'] as const;
export function audioMetrics(value:unknown):Record<string,number>{
  const result:Record<string,number>={};if(!value||typeof value!=='object')return result;
  for(const key of keys){const n=(value as Record<string,unknown>)[key];if(typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<1e12)result[key]=Math.round(n*1000)/1000;}
  return result;
}
type Event='mode'|'created'|'published'|'attached'|'generated'|'sent'|'started'|'ended'|'clear'|'user_started'|'cancel'|'recovery'|'browser'|'bridge'|'progress';
export class MeetingAudioTrace {
  readonly id=randomUUID();
  enabled=false;
  private count=0;
  private started=performance.now();
  private lastSample=new Map<Event,number>();
  private recent:Array<{event:Event;elapsedMs:number;metrics:Record<string,number>}>=[];
  constructor(private agent:string,private epoch:number,private transport:'rtc'|'pcm'){}
  set(enabled:boolean){if(this.enabled===enabled)return;this.enabled=enabled;this.record('mode',{enabled:Number(enabled)},true);}
  record(event:Event,value:unknown={},force=false){
    const now=performance.now();
    if(event==='browser'||event==='bridge'||event==='progress'){if(now-(this.lastSample.get(event)??-Infinity)<2000)return;this.lastSample.set(event,now);}
    const entry={event,elapsedMs:Math.round(now-this.started),metrics:audioMetrics(value)};
    this.recent.push(entry);if(this.recent.length>48)this.recent.shift();
    if((this.enabled||force)&&this.count<1200){this.count++;console.info('MEETING_AUDIO_TRACE '+JSON.stringify({agent:this.agent,epoch:this.epoch,trace:this.id,transport:this.transport,at:new Date().toISOString(),...entry}));}
  }
  snapshot(){return {id:this.id,enabled:this.enabled,emitted:this.count,limited:this.count>=1200,recent:this.recent};}
}
