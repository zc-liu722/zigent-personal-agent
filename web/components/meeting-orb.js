// One shared GPU surface serves every visible invitation. Each message keeps a
// lightweight 2D canvas, rather than retaining a WebGL context per history row.
const vertex=`
attribute vec2 position;
varying vec2 uv;
void main(){uv=position;gl_Position=vec4(position,0.0,1.0);}`;
const fragment=`
precision highp float;
varying vec2 uv;
uniform float time;
uniform float energy;
uniform float pulse;
uniform float call;
uniform float pixel;
uniform vec3 inkColor;
uniform vec3 paperColor;
uniform vec3 accentColor;
float hash(vec3 p){p=fract(p*.3183099+vec3(.17,.31,.53));p*=17.0;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float noise(vec3 p){
  vec3 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
  return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
    mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
float square(float x){return x*x;}
void main(){
  float t=time*.48;
  vec2 p=uv-vec2(sin(t*.63)*.012,cos(t*.71)*.018);
  float turn=t*.24;
  p=mat2(cos(turn),-sin(turn),sin(turn),cos(turn))*p;
  float a=atan(p.y,p.x);
  float ripple=sin(a*3.0+t*1.7)*.55+sin(a*5.0-t*2.1)*.3+sin(a*7.0+t)*.15;
  // Two persistent baselines: a rounded invitation breath and a flowing call.
  // Measured input/output volume adds movement without selecting a speaker state.
  float radius=.66+sin(t*1.4)*mix(.012,.006,call)+energy*.045+(mix(.003,.018,call)+energy*.045+pulse*.018)*ripple;
  float d=length(p)-radius;
  float mask=1.0-smoothstep(-pixel,pixel,d);
  vec2 q=p/radius;
  float z=sqrt(max(0.0,1.0-dot(q,q)));
  vec3 n=normalize(vec3(q,z));
  float fresnel=pow(1.0-z,2.2);
  // A quiet liquid surface. Motion carries voice activity; the palette stays
  // in the page's neutral ink/paper range with a trace of its existing accent.
  float flow=noise(vec3(q*2.0,z)+vec3(t*.32,-t*.26,t*.18));
  vec2 lens=q/(.68+z*.45);
  float wave=lens.y*.85+lens.x*.5+sin(lens.x*3.1+t)*mix(.1,.24,call)+(flow-.5)*mix(.2,.5,call);
  float ribbon=exp(-square((wave-sin(t*.6)*.18)*8.0));
  float ribbon2=exp(-square((wave+.48+sin(t*.8+q.y*3.0)*.14)*12.0));
  float lightTheme=step(dot(inkColor,vec3(.299,.587,.114)),dot(paperColor,vec3(.299,.587,.114)));
  vec3 pearl=mix(inkColor,paperColor,lightTheme);
  vec3 charcoal=mix(paperColor,inkColor,lightTheme);
  float contour=pow(.5+.5*sin(wave*19.0+t*.38),14.0);
  vec3 color=mix(charcoal,pearl,.22+z*.22+flow*.12);
  color=mix(color,accentColor,.035+energy*.035);
  color=mix(color,pearl,ribbon*(.24+energy*.14)+ribbon2*.12+contour*(.055+energy*.08));
  float rim=exp(-abs(d)*120.0);
  float edgeLight=.5+.5*sin(a*2.0-t*.8);
  float highlight=pow(max(0.0,dot(n,normalize(vec3(-.48,.62,.62)))),65.0);
  float softbox=pow(max(0.0,dot(n,normalize(vec3(-.38,.72,.47)))),14.0);
  float glint=pow(max(0.0,dot(n,normalize(vec3(.66,-.55,.4)))),38.0);
  color=mix(color,pearl,clamp(highlight*.9+softbox*.4+glint*.25+fresnel*.35,0.0,.95));
  float bodyAlpha=mask*(.91+fresnel*.06);
  float halo=exp(-max(d,0.0)*30.0)*(.015+energy*.035+pulse*.025)*(1.0-mask);
  float edge=rim*(.16+edgeLight*.2);
  float alpha=bodyAlpha+edge*(1.0-bodyAlpha);
  vec3 glass=mix(color,pearl,edge*.55);
  gl_FragColor=vec4((glass*alpha+pearl*halo*(1.0-alpha))/max(alpha+halo*(1.0-alpha),.001),alpha+halo*(1.0-alpha));
}`;

let palette;
function pagePalette(){
  if(palette)return palette;
  const style=getComputedStyle(document.documentElement);
  const color=(name,fallback)=>{
    const value=style.getPropertyValue(name).trim();
    const hex=/^#([\da-f]{6}|[\da-f]{3})$/i.exec(value)?.[1];
    if(hex){const full=hex.length===3?[...hex].map(c=>c+c).join(''):hex;return [0,2,4].map(i=>parseInt(full.slice(i,i+2),16)/255);}
    const rgb=/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(value);
    return rgb?rgb.slice(1,4).map(c=>Math.min(1,Number(c)/255)):fallback;
  };
  return palette=[color('--ink',[.08,.08,.075]),color('--paper',[.98,.976,.96]),color('--accent',[.85,.467,.341])];
}

let renderer;
function gpuRenderer(){
  if(renderer!==undefined)return renderer;
  const canvas=document.createElement('canvas');
  const gl=canvas.getContext('webgl',{alpha:true,antialias:false,depth:false,stencil:false,premultipliedAlpha:false,preserveDrawingBuffer:true,powerPreference:'low-power'});
  if(!gl)return renderer=null;
  const shaders=[];
  const compile=(type,source)=>{
    const shader=gl.createShader(type);if(!shader)throw new Error('shader');shaders.push(shader);gl.shaderSource(shader,source);gl.compileShader(shader);
    if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error('shader');return shader;
  };
  let program,buffer;
  try{
    program=gl.createProgram();if(!program)throw new Error('program');
    gl.attachShader(program,compile(gl.VERTEX_SHADER,vertex));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error('program');
    gl.useProgram(program);buffer=gl.createBuffer();if(!buffer)throw new Error('buffer');gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
    const position=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
    const uniforms=Object.fromEntries(['time','energy','pulse','call','pixel','inkColor','paperColor','accentColor'].map(name=>[name,gl.getUniformLocation(program,name)]));
    let previousDraw;
    renderer={draw(size,time,energy,pulse,call){
      if(gl.isContextLost())return null;
      const colors=pagePalette(),key=[size,time,energy,pulse,call,...colors.flat()].join(':');
      if(previousDraw===key)return canvas;previousDraw=key;
      if(canvas.width!==size){canvas.width=canvas.height=size;gl.viewport(0,0,size,size);}
      gl.uniform3fv(uniforms.inkColor,colors[0]);gl.uniform3fv(uniforms.paperColor,colors[1]);gl.uniform3fv(uniforms.accentColor,colors[2]);
      gl.uniform1f(uniforms.time,time);gl.uniform1f(uniforms.energy,energy);gl.uniform1f(uniforms.pulse,pulse);gl.uniform1f(uniforms.call,call);gl.uniform1f(uniforms.pixel,2.0/size);gl.drawArrays(gl.TRIANGLES,0,6);return canvas;
    }};
  }catch{if(buffer)gl.deleteBuffer(buffer);if(program)gl.deleteProgram(program);renderer=null;}
  finally{for(const shader of shaders)gl.deleteShader(shader);}
  return renderer;
}

const targets=new Set();
const motion=window.matchMedia('(prefers-reduced-motion: reduce)');
let frame,last=0,previous=0,cleanup;
function schedule(){if(!frame&&!document.hidden&&[...targets].some(target=>target.visible&&(target.dirty||!target.ended&&!motion.matches)))frame=requestAnimationFrame(paint);}
function dispose(target){
  targets.delete(target);visibility.unobserve(target.canvas);sizes.unobserve(target.canvas);target.detached?.();
  if(!targets.size){cleanup?.disconnect();cleanup=undefined;}
}
const visibility=new IntersectionObserver(entries=>{
  for(const change of entries){const target=[...targets].find(target=>target.canvas===change.target);if(target){target.visible=change.isIntersecting;if(target.visible)target.dirty=true;}}
  schedule();
},{rootMargin:'32px'});
const sizes=new ResizeObserver(entries=>{
  for(const change of entries){const target=[...targets].find(target=>target.canvas===change.target);if(target){target.size=Math.max(48,Math.min(448,Math.round(change.contentRect.width*Math.min(window.devicePixelRatio||1,2))));target.dirty=true;}}
  schedule();
});
function paint(now){
  frame=undefined;
  if(document.hidden){previous=0;return;}
  if(now-last<1000/30){schedule();return;}last=now;
  const dt=previous?Math.min((now-previous)/1000,.1):1/30;previous=now;
  let moving=false;
  for(const target of targets){
    if(!target.canvas.isConnected){dispose(target);continue;}
    if(!target.visible)continue;
    const sample=target.inCall&&!target.ended?target.sample?.()||{}:{};
    // Compress real RMS into a visible speech envelope; reject the quiet noise floor.
    const loudness=value=>Math.min(1,Math.sqrt(Math.max(0,(value||0)-.003)*9));
    const input=loudness(sample.input),output=loudness(sample.output);
    const desired=motion.matches||target.ended||!target.inCall?0:Math.max(input,output);
    target.pulse=Math.max(target.pulse*Math.exp(-dt/.16),Math.max(0,desired-target.energy));
    target.energy+=(desired-target.energy)*(1-Math.exp(-dt/(desired>target.energy ? .045 : .22)));
    target.call+=(Number(target.inCall)-target.call)*(motion.matches||target.ended?1:1-Math.exp(-dt/.25));
    if(motion.matches||target.ended){target.energy=0;target.pulse=0;}
    if(!motion.matches&&!target.ended)target.time+=dt*(.4+target.call*.6+target.energy*1.8);
    target.host.style.setProperty('--meeting-energy',target.energy.toFixed(3));
    target.host.style.setProperty('--meeting-pulse',target.pulse.toFixed(3));
    if(!motion.matches&&!target.ended||target.dirty){
      const size=target.size||64;
      if(target.canvas.width!==size)target.canvas.width=target.canvas.height=size;
      const surface=gpuRenderer()?.draw(size,motion.matches||target.ended?9:target.time,target.energy,target.pulse,target.call);
      if(surface){target.context.clearRect(0,0,size,size);target.context.drawImage(surface,0,0);target.host.classList.add('is-rendered');}
      else target.host.classList.remove('is-rendered');
      target.dirty=false;
    }
    if(!target.ended&&!motion.matches)moving=true;
  }
  // Reduced motion draws only on state/size changes.
  if(moving)schedule();
}
document.addEventListener('visibilitychange',()=>{previous=0;if(document.hidden){cancelAnimationFrame(frame);frame=undefined;}else{for(const target of targets)target.dirty=true;schedule();}});
motion.addEventListener('change',()=>{for(const target of targets)target.dirty=true;schedule();});
new MutationObserver(()=>{palette=undefined;for(const target of targets)target.dirty=true;schedule();}).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','style','class']});

export function createMeetingOrb(host,{sample,detached}={}){
  host.dataset.mode='invitation';
  const canvas=document.createElement('canvas');canvas.className='meeting-orb-canvas';canvas.setAttribute('aria-hidden','true');
  host.append(canvas);
  const context=canvas.getContext('2d');if(!context)return {setEnded(){},setCall(inCall){host.dataset.mode=inCall?'call':'invitation';}};
  const target={canvas,context,host,sample,detached,visible:false,energy:0,pulse:0,inCall:false,call:0,time:0,ended:false,dirty:true};targets.add(target);
  visibility.observe(canvas);sizes.observe(canvas);
  if(!cleanup){cleanup=new MutationObserver(()=>{for(const target of targets)if(!target.canvas.isConnected)dispose(target);});cleanup.observe(document.body,{childList:true,subtree:true});}
  return {
    setCall(inCall){if(target.inCall!==inCall){target.inCall=inCall;host.dataset.mode=inCall?'call':'invitation';target.dirty=true;schedule();}},
    setEnded(ended){if(target.ended!==ended){target.ended=ended;target.dirty=true;}if(target.visible&&target.dirty&&!document.hidden&&!frame)frame=requestAnimationFrame(paint);else schedule();}
  };
}
