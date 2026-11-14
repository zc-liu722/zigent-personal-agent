import { VoiceBridge } from './bridge.js';
import { command, start } from './protocol.js';

// Line-delimited control IPC. Secrets arrive on the inherited private pipe,
// never process arguments, an HTTP listener, a log or a persisted config file.
let bridge:VoiceBridge|undefined,pending='';
let stopping=false, queuedBytes=0;
function emit(event:object){
  const bytes=Buffer.byteLength(JSON.stringify(event));
  if(!process.send||!process.connected||queuedBytes+bytes>2*1024*1024){void stop('control_backpressure');return;}
  queuedBytes+=bytes;process.send(event,error=>{queuedBytes-=bytes;if(error)void stop('control_output');});
  if('type' in event&&(event.type==='closed'||event.type==='closing')&&!stopping)void stop('code' in event?String(event.code):'closed');
}
async function stop(code:string){if(stopping)return;stopping=true;process.stdin.destroy();process.exitCode=code==='coordinator_closed'?0:1;setTimeout(()=>process.exit(process.exitCode),2500);await bridge?.close(code);}
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{
  if(stopping)return;pending+=chunk;
  if(Buffer.byteLength(pending)>512*1024){void stop('control_capacity');return;}
  for(let end;(end=pending.indexOf('\n'))>=0;){
    const line=pending.slice(0,end);pending=pending.slice(end+1);if(!line)continue;
    try{const value=JSON.parse(line);
      if(!bridge){bridge=new VoiceBridge(start.parse(value),emit);void bridge.connect().catch(()=>stop('connect_failure'));}
      else bridge.command(command.parse(value));
    }catch{void stop('control_protocol');return;}
  }
});
process.stdin.on('end',()=>void stop('coordinator_closed'));
process.stdin.on('error',()=>void stop('control_input'));
process.on('disconnect',()=>void stop('coordinator_closed'));
process.on('SIGTERM',()=>void stop('coordinator_closed'));
process.on('SIGINT',()=>void stop('coordinator_closed'));
process.on('uncaughtException',()=>void stop('internal'));
process.on('unhandledRejection',()=>void stop('internal'));
const startup=setTimeout(()=>{if(!bridge)void stop('startup_timeout');},5000);startup.unref();
