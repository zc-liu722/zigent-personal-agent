import { request as httpRequest, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { Duplex } from 'node:stream';

/** Fixed, loopback-only LiveKit signaling. Room JWTs stay under LiveKit validation. */
export function meetingSignalProxy(server:Server,options:{prefix:string;origin:string;enabled:boolean;authenticate:(r:IncomingMessage)=>boolean}){
  const path=(req:IncomingMessage)=>{const url=new URL(req.url??'/','http://localhost');if(!url.pathname.startsWith(options.prefix+'/'))return;return url.pathname.slice(options.prefix.length)+url.search;};
  const headers=(req:IncomingMessage)=>{const h={...req.headers};delete h.cookie;delete h['proxy-authorization'];h.host='127.0.0.1:7880';return h;};
  const upgrade=(req:IncomingMessage,socket:Duplex,head:Buffer)=>{
    const target=path(req);if(!target)return;
    if(!options.enabled||req.method!=='GET'||req.headers.origin!==options.origin||!options.authenticate(req)){socket.end('HTTP/1.1 403 Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return;}
    const request=httpRequest({hostname:'127.0.0.1',port:7880,path:target,headers:headers(req)});
    request.on('upgrade',(reply,upstream,pending)=>{upstream.setTimeout(0);if(socket.destroyed){upstream.destroy();return;}socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(reply.headers).map(([k,v])=>`${k}: ${v}\r\n`).join('')}\r\n`);if(head.length)upstream.write(head);if(pending.length)socket.write(pending);socket.pipe(upstream);upstream.pipe(socket);socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());socket.on('close',()=>upstream.destroy());upstream.on('close',()=>socket.destroy());});
    request.on('response',reply=>{reply.resume();socket.end(`HTTP/1.1 ${reply.statusCode??502} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);});
    request.on('error',()=>socket.destroy());request.setTimeout(15000,()=>request.destroy());socket.on('close',()=>request.destroy());request.end();
  };
  server.on('upgrade',upgrade);
  return {
    handle(req:IncomingMessage,res:ServerResponse){const target=path(req);if(!target)return false;
      if(!options.enabled||!options.authenticate(req)){res.writeHead(403);res.end();return true;}
      const h=headers(req);delete h.connection;
      const upstream=httpRequest({hostname:'127.0.0.1',port:7880,path:target,method:req.method,headers:h},reply=>{res.writeHead(reply.statusCode??502,reply.headers);reply.pipe(res);reply.on('error',()=>res.destroy());});
      upstream.setTimeout(15000,()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream);return true;
    },close(){server.off('upgrade',upgrade);}
  };
}
