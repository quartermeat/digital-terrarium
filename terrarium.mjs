import { CAPACITY, emptyCreature, syncGroups, prepareCreature, emissionRate, stepCreatures, measured, clamp } from './ecology.mjs';
import { agentFresh, agentWaypoints } from './agent-activity.mjs';

const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d');
const tooltip = document.querySelector('#tooltip');
const creatures = Array.from({ length: CAPACITY }, emptyCreature);
let snapshot = null, pending = null, networkError = false, pointer = null;
let agents = [], agentError = false;
let audio = null, audioReceived = 0, musicLevel = 0, musicBass = 0, musicPhase = 0;
const musicWave = Array(40).fill(0);
let width = innerWidth, height = innerHeight, time = 0, last = 0;
const particles = [], accumulators = new Map(), rootPhases = new Map();
const operatorStates = new Map();
const wallpaper = new Image();
let wallpaperReady = false;
wallpaper.onload = () => { wallpaperReady = true; };
wallpaper.src = '/api/wallpaper';

async function poll() {
 try {
  const response = await fetch('/api/ecosystem', { signal: AbortSignal.timeout(1800), cache: 'no-store' });
  if (!response.ok) throw Error('Telemetry unavailable');
  const data = await response.json();
  if (data.version !== 1 || !Array.isArray(data.processes) || !Array.isArray(data.disks) || !Array.isArray(data.network)) throw Error('Incompatible telemetry');
  pending = data; networkError = false;
 } catch (error) { networkError = true; console.warn(error.message); }
 setTimeout(poll, 1000);
}
poll();
async function pollAgents() {
 try {
  const response = await fetch('/api/agents', { signal: AbortSignal.timeout(1800), cache: 'no-store' });
  if (!response.ok) throw Error('Agent activity unavailable');
  const data = await response.json();
  if(data.version!==1||!Array.isArray(data.agents))throw Error('Incompatible agent activity');
  agents=data.agents;agentError=false;
 } catch { agentError=true; }
 setTimeout(pollAgents, 500);
}
pollAgents();
async function pollAudio() {
 try {
  const response = await fetch('/api/audio', { signal: AbortSignal.timeout(1000), cache: 'no-store' });
  if (!response.ok) throw Error('Audio unavailable');
  const data = await response.json();
  audio = data.available && Number.isFinite(data.level) && Number.isFinite(data.bass)
   && Array.isArray(data.waveform) && data.waveform.length === 40 && data.waveform.every(Number.isFinite) ? data : null;
  audioReceived = performance.now();
 } catch { audio = null; }
 setTimeout(pollAudio, 50);
}
pollAudio();
function resize() {
 width = innerWidth; height = innerHeight;
 const ratio = Math.min(devicePixelRatio, 2);
 canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
 ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}
addEventListener('resize', resize); resize();
canvas.addEventListener('pointermove', event => { pointer = { x: event.clientX, y: event.clientY }; });
const leave = () => { pointer = null; tooltip.hidden = true; tooltip.style.display = 'none'; };
canvas.addEventListener('pointerleave', leave); addEventListener('blur', leave);
function line(points, color, weight = 1) {
 ctx.beginPath(); points.forEach(([x,y], i) => i ? ctx.lineTo(x,y) : ctx.moveTo(x,y));
 ctx.strokeStyle = color; ctx.lineWidth = weight; ctx.stroke();
}
function dot(x,y,r,color) { ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fillStyle=color; ctx.fill(); }
const bytes = value => {
 if (!measured(value)) return 'unavailable';
 for (const [unit, scale] of [['GiB',1073741824],['MiB',1048576],['KiB',1024]]) if (value >= scale) return (value/scale).toFixed(1)+' '+unit;
 return Math.round(value)+' B';
};
const percent = value => measured(value) ? (value*100).toFixed(1)+'%' : 'unavailable';
const rate = value => measured(value) ? bytes(value)+'/s' : 'unavailable';
function emit(key, amount, dt, make) {
 let debt = (accumulators.get(key) ?? 0) + amount * dt;
 while (debt >= 1) { if (particles.length < 160) particles.push(make()); debt--; }
 accumulators.set(key, debt);
}
function crack(x,y,rx,ry,color) {
 ctx.beginPath();
 for(let i=0;i<32;i++) {
  const a=i/32*Math.PI*2,k=1+.1*Math.sin(i*17),px=x+Math.cos(a)*rx*k,py=y+Math.sin(a)*ry*k;
  i?ctx.lineTo(px,py):ctx.moveTo(px,py);
 }
 ctx.closePath(); ctx.fillStyle='#041416';ctx.fill();ctx.strokeStyle=color;ctx.lineWidth=1.5;ctx.stroke();
}
function drawMemory(fresh, hits, dt) {
 const memory = snapshot?.memory ?? {}, x=width*.84, y=height*.84, rx=width*.115, ry=height*.058;
 const color=fresh&&measured(memory.used)?'hsl('+(165-memory.used*110)+' 65% 62%)':'#596b69';
 crack(x,y,rx,ry,color);
 const pressure=fresh?(memory.pressure??0):0;
 const swapping=fresh?emissionRate((memory.swapInBytesPerSec??0)+(memory.swapOutBytesPerSec??0)):0;
 const agitation=pressure*25+swapping*.3;
 const sound = audio && performance.now()-audioReceived<500 ? audio : null;
 const ease = 1-Math.exp(-dt*24);
 musicLevel += ((sound?.level??0)-musicLevel)*ease;
 musicBass += ((sound?.bass??0)-musicBass)*ease;
 musicPhase += dt*(2+musicLevel*12);
 musicWave.forEach((value,i)=>{musicWave[i]=value+((sound?.waveform[i]??0)-value)*ease;});
 canvas.dataset.audioAvailable=String(Boolean(sound));
 canvas.dataset.musicLevel=musicLevel.toFixed(3);
 // Compress the measured level so normal listening volumes visibly move the well.
 const energy=Math.pow(Math.max(0,musicLevel-.008),.55);
 const bass=Math.pow(Math.max(0,musicBass-.008),.6);
 const amplitude=ry*(energy*.7+bass*.55);
 canvas.dataset.musicAmplitude=amplitude.toFixed(2);
 ctx.save();ctx.clip();
 ctx.shadowColor='#91ffe5';ctx.shadowBlur=energy*14;
 for(let j=0;j<7;j++) {
  const points=musicWave.map((sample,i)=>{
   const p=i/(musicWave.length-1), envelope=Math.sin(p*Math.PI);
   const ripple=Math.sin(p*10-musicPhase+j*.65)*amplitude;
   return [x-rx+p*rx*2,y-ry+j*ry/3+Math.sin(i*.6+time*(.5+agitation)+j)*(1+agitation)
    +envelope*(sample*ry*.8+ripple)];
  });
  line(points,energy>.05?'hsl(165 85% '+(65+energy*25)+'%)':color, .7+energy*2);
 }
 ctx.shadowBlur=0;
 // Fill represents RAM; waves combine memory pressure with measured speaker audio.
 if(fresh&&measured(memory.used)) {ctx.fillStyle=color;ctx.globalAlpha=.14;ctx.fillRect(x-rx,y+ry-2*ry*memory.used,2*rx,2*ry*memory.used);}
 ctx.restore();
 hits.push({x,y,rx,ry,text:'MEMORY / electrolyte\nRAM used '+percent(memory.used)+'\nMemory stalls (10 s) '+percent(memory.pressure)+'\nSwap occupied '+bytes(memory.swapBytes)+'\nSwap in '+rate(memory.swapInBytesPerSec)+'\nSwap out '+rate(memory.swapOutBytesPerSec)});
}
function drawRoots(fresh,hits,dt) {
 (snapshot?.disks??[]).slice(0,8).forEach((disk,i,disks)=>{
  const x=width*(.07+i*.57/Math.max(1,disks.length-1)), y=height*.91, h=58+disk.used*65;
  const color=fresh?'hsl('+(155-disk.used*125)+' 50% 62%)':'#596b69';
  crack(x,y,23,6,color);
  const io=fresh?emissionRate((disk.readBytesPerSec??0)+(disk.writeBytesPerSec??0)):0;
  const phase=(rootPhases.get(disk.id)??0)+dt*io*.12;rootPhases.set(disk.id,phase);
  for(let j=0;j<3;j++){
   const endX=x+(j-1)*28,endY=y-h+j*10;
   line([[x,y],[x,y-h*.4],[endX,y-h*.65],[endX,endY]],color,1.4);
   ctx.strokeStyle=color;ctx.strokeRect(endX-4,endY-7,8,8);
   if(io>0){const p=(phase+j*.3)%1;dot(x+(endX-x)*p,y-h*p,2,'#c5efd0');}
  }
  hits.push({x,y:y-h/2,rx:44,ry:h/2+12,text:'FILESYSTEM '+disk.mount+'\nAvailable '+bytes(disk.availableBytes)+' / '+bytes(disk.totalBytes)+'\nUnavailable space '+percent(disk.used)+'\nReads '+rate(disk.readBytesPerSec)+'\nWrites '+rate(disk.writeBytesPerSec)});
 });
}
function drawNetwork(fresh,hits,dt) {
 (snapshot?.network??[]).slice(0,6).forEach((net,i)=>{
  const x=width*.95,y=height*(.2+i*.095);
  ctx.strokeStyle=fresh?'#619fa8':'#596b69';ctx.strokeRect(x-8,y-8,16,16);
  line([[x-4,y],[x+4,y]],'#619fa8');
  for(const direction of ['rx','tx']){
   const value=net[direction+'BytesPerSec'], color=direction==='rx'?'#74dfe0':'#dfba7d';
   if(fresh)emit(net.name+direction,emissionRate(value),dt,()=>({x:x+(Math.random()-.5)*12,y,vy:direction==='rx'?32:-32,vx:-12,life:2,color,kind:'bubble'}));
  }
  hits.push({x,y,rx:18,ry:18,text:'INTERFACE '+net.name+'\nReceive ↓ '+rate(net.rxBytesPerSec)+'\nTransmit ↑ '+rate(net.txBytesPerSec)+'\nBubbles summarize traffic; each is not one packet.'});
 });
}
function drawCreature(c,fresh,hits,dt) {
 if(!c.group)return;
 const x=c.x*width,y=c.y*height,s=c.size;
 const valid=fresh&&measured(c.group.cpu);
 ctx.save();ctx.translate(x,y);ctx.rotate(Math.atan2(Math.sin(c.heading)*height,Math.cos(c.heading)*width));ctx.globalAlpha=c.alpha;
 const color=valid?'hsl('+c.hue+' 55% '+(40+c.level*40)+'%)':'#687b7a';
 // Compact floating chip: a single body and status bars, with no animal-like legs.
 // Stacked outlines behind it count the processes sharing the group name.
 ctx.strokeStyle=color;ctx.lineWidth=1.2;
 for(let i=c.stack;i>0;i--){
  ctx.globalAlpha=c.alpha*.16;const o=i*s*.13;
  ctx.beginPath();ctx.roundRect(-s*.8+o,-s*.42-o,s*1.6,s*.84,s*.18);ctx.stroke();
 }
 ctx.globalAlpha=c.alpha;
 ctx.fillStyle='#102b30';
 ctx.beginPath();ctx.roundRect(-s*.8,-s*.42,s*1.6,s*.84,s*.18);ctx.fill();ctx.stroke();
 // The ring closes in proportion to the share of this group's threads that are
 // runnable, so a saturated group reads as a full circle rather than an arc.
 ctx.globalAlpha=.45;ctx.beginPath();ctx.arc(0,0,s*.62,0,Math.PI*2);ctx.stroke();
 if(c.runnable>0){
  ctx.globalAlpha=.95;ctx.lineWidth=2;
  ctx.beginPath();ctx.arc(0,0,s*.62,-Math.PI/2,-Math.PI/2+c.runnable*Math.PI*2);ctx.stroke();
  ctx.lineWidth=1.2;
 }
 // One bar per doubling of thread count, so a thread-heavy group is visibly denser.
 ctx.globalAlpha=1;ctx.fillStyle=color;
 const pitch=s*1.2/c.bars;
 for(let i=0;i<c.bars;i++)ctx.fillRect(-s*.5+i*pitch,-s*.12,Math.max(1.2,pitch*.55),s*.24);
 ctx.restore();
 if(valid)emit('cpu:'+c.group.name,c.level*2,dt,()=>({x,y,vx:0,vy:-12,life:.7,color:'#9ef5b9',kind:'spark'}));
 hits.push({x,y,rx:s+8,ry:s+8,text:c.group.name+' / '+c.group.count+' processes\nCPU '+percent(c.group.cpu)+' of whole machine\nRSS sum '+bytes(c.group.rssBytes)+' (shared pages may repeat)\nThreads '+c.group.threads+' · runnable '+c.group.running+'\n'+(!valid?'Waiting for measurements':c.level>0?'Active':'Resting')});
}
function hover(hits,fresh) {
 if(!pointer){tooltip.style.display='none';return;}
 const candidates=hits.filter(hit=>Math.pow((pointer.x-hit.x)/hit.rx,2)+Math.pow((pointer.y-hit.y)/hit.ry,2)<=1);
 const hit=candidates.sort((a,b)=>a.rx*a.ry-b.rx*b.ry)[0];
 if(!hit){tooltip.style.display='none';return;}
 tooltip.textContent=hit.text+(fresh?'':'\nMeasurements unavailable or stale')+(snapshot?.processes.length>CAPACITY?'\nShowing '+CAPACITY+' of '+snapshot.processes.length+' groups':'');
 tooltip.hidden=false;tooltip.style.display='block';
 tooltip.style.left=Math.max(6,Math.min(width-tooltip.offsetWidth-8,pointer.x+16))+'px';
 tooltip.style.top=Math.max(6,Math.min(height-tooltip.offsetHeight-8,pointer.y+16))+'px';
}
function drawAgent(agent,index,hits,dt) {
 if(!agentFresh(agent))return;
 const route=agentWaypoints(agent,creatures,snapshot?.disks??[],width,height);
 const active=['thinking','working','tool'].includes(agent.phase);
 let state=operatorStates.get(agent.id);
 if(!state){state={x:width*.5,y:height*.48,target:'',time:0,hop:0,flash:0,routeIndex:0};operatorStates.set(agent.id,state);}
 state.time+=dt;state.hop+=dt;state.flash=Math.max(0,state.flash-dt);
 if(state.primary!==route[0].label){state.primary=route[0].label;state.routeIndex=0;state.hop=0;}
 const interval=agent.phase==='tool'?.18:active?.3:Infinity;
 let jumped=false;
 if(state.hop>=interval&&route.length>1){state.hop=0;state.routeIndex=(state.routeIndex+1)%route.length;jumped=true;}
 if(!active)state.routeIndex=0;
 const destination=route[state.routeIndex%route.length];
 const distance=Math.hypot(destination.x-state.x,destination.y-state.y);
 if(jumped&&distance>45){
  state.fromX=state.x;state.fromY=state.y;state.x=destination.x;state.y=destination.y;state.flash=.14;
  for(let i=0;i<24&&particles.length<160;i++){
   const along=Math.random();particles.push({x:state.fromX+(state.x-state.fromX)*along,y:state.fromY+(state.y-state.fromY)*along,vx:(Math.random()-.5)*55,vy:(Math.random()-.5)*55,life:.2+Math.random()*.35,color:'#83ffc1',kind:'code'});
  }
 }
 state.target=destination.label;
 const speed=1-Math.exp(-dt*(active?28:12));state.x+=(destination.x-state.x)*speed;state.y+=(destination.y-state.y)*speed;
 // An agent that is merely alive still coasts: a slow loop around its anchor,
 // so an idle session reads as present rather than as nothing at all.
 const coastX=active?0:Math.cos(state.time*.55)*26,coastY=active?0:Math.sin(state.time*.8)*14;
 const x=state.x+index*9+coastX,y=state.y-22-index*5+coastY;
 const pulse=active?(1+Math.sin(state.time*22))*.5:0;
 const color=agent.phase==='error'?'#ff6f78':agent.phase==='waiting'?'#e0c477':'#80ffc0';
 if(state.flash>0&&Number.isFinite(state.fromX)){
  ctx.save();ctx.globalAlpha=state.flash/.14*.55;line([[state.fromX,state.fromY],[x,y]],color,2.5);ctx.restore();
 }
 ctx.save();ctx.translate(x,y);
 // A fast luminous courier: needle body, bright eyes, and rapidly beating wings.
 // Idle couriers face along their coast, not at a destination they already sit on.
 const angle=active?Math.atan2(destination.y-state.y,destination.x-state.x)
  :Math.atan2(Math.cos(state.time*.8)*11.2,-Math.sin(state.time*.55)*14.3);
 ctx.rotate(Number.isFinite(angle)?angle:0);
 ctx.shadowColor=color;ctx.shadowBlur=active?22+pulse*18:15;ctx.strokeStyle=color;ctx.fillStyle='#071211';ctx.lineWidth=2;
 ctx.globalAlpha=.18+pulse*.12;dot(0,0,30+pulse*7,color);ctx.globalAlpha=1;
 ctx.beginPath();ctx.moveTo(-23,0);ctx.lineTo(12,-6);ctx.lineTo(23,0);ctx.lineTo(12,6);ctx.closePath();ctx.fill();ctx.stroke();
 const wing=9+(active?pulse*11:Math.sin(state.time*5)*2.5);
 ctx.globalAlpha=.45+pulse*.45;ctx.beginPath();ctx.ellipse(-2,-wing,16,5,-.35,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();
 ctx.beginPath();ctx.ellipse(-2,wing,16,5,.35,0,Math.PI*2);ctx.fill();ctx.globalAlpha=1;
 dot(14,-2.5,2.6,'#edfff6');dot(14,2.5,2.6,'#edfff6');
 line([[-21,0],[-34-pulse*12,0]],color,1.7);
 if(state.flash>0){ctx.globalAlpha=state.flash/.14;ctx.lineWidth=3;ctx.beginPath();ctx.arc(0,0,48-state.flash/.14*18,0,Math.PI*2);ctx.stroke();}
 ctx.restore();
 if(active)emit('agent:'+agent.id,6+pulse*8,dt,()=>({x:x+(Math.random()-.5)*22,y:y+30,vx:(Math.random()-.5)*5,vy:-20-Math.random()*20,life:.35+Math.random()*.45,color,kind:'code'}));
 const phase={idle:'Resting',thinking:'Thinking / local inference',working:'Following active threads',tool:'Using a tool',waiting:'Waiting for direction',error:'Needs attention'}[agent.phase]||agent.phase;
 hits.push({x,y,rx:48,ry:40,text:agent.name+' / fast agent courier\n'+phase+(agent.detail?'\n'+agent.detail:'')+'\nVisiting: '+destination.label});
 if(index===0){canvas.dataset.agentPhase=agent.phase;canvas.dataset.agentX=String(x);canvas.dataset.agentY=String(y);canvas.dataset.agentTarget=destination.label;}
}
function frame(stamp) {
 const dt=Math.min((stamp-last)/1000||0,.05);last=stamp;time+=dt;
 if(pending){snapshot=pending;pending=null;syncGroups(creatures,snapshot.processes);const allowed=new Set([...snapshot.processes.map(g=>'cpu:'+g.name),...snapshot.network.flatMap(n=>[n.name+'rx',n.name+'tx'])]);for(const key of accumulators.keys())if(!allowed.has(key))accumulators.delete(key);}
 const fresh=!!snapshot&&!networkError&&Date.now()-Date.parse(snapshot.sampledAt)<5000;
 creatures.forEach(c=>prepareCreature(c,dt,fresh));
 stepCreatures(creatures,dt,time);
 // Redraw the wallpaper every frame; alpha clearing alone caused desktop trails.
 ctx.clearRect(0,0,width,height);
 ctx.fillStyle='#071719';ctx.fillRect(0,0,width,height);
 if(wallpaperReady) {
  const scale=Math.max(width/wallpaper.naturalWidth,height/wallpaper.naturalHeight);
  const w=wallpaper.naturalWidth*scale,h=wallpaper.naturalHeight*scale;
  ctx.drawImage(wallpaper,(width-w)/2,(height-h)/2,w,h);
 }
 const hits=[];
 drawMemory(fresh,hits,dt);drawRoots(fresh,hits,dt);drawNetwork(fresh,hits,dt);
 creatures.forEach(c=>drawCreature(c,fresh,hits,dt));
 agents.forEach((agent,index)=>drawAgent(agent,index,hits,dt));
 for(const id of operatorStates.keys())if(!agents.some(agent=>agent.id===id))operatorStates.delete(id);
 for(let i=particles.length-1;i>=0;i--) {
  const p=particles[i];p.life-=dt;p.x+=p.vx*dt;p.y+=p.vy*dt;
  if(p.life<=0){particles.splice(i,1);continue;}
  ctx.globalAlpha=Math.min(1,p.life);
   if(p.kind==='bubble'){ctx.strokeStyle=p.color;ctx.beginPath();ctx.arc(p.x,p.y,2.5,0,Math.PI*2);ctx.stroke();}
   else if(p.kind==='code'){ctx.fillStyle=p.color;ctx.font='8px monospace';ctx.fillText(Math.random()>.5?'1':'0',p.x,p.y);}
  else {ctx.fillStyle=p.color;ctx.fillRect(p.x-1,p.y-1,2,2);}
 }
 ctx.globalAlpha=1;hover(hits,fresh);
 // Machine-readable diagnostics for local verification; no permanent HUD.
 canvas.dataset.ready='true';canvas.dataset.fresh=String(fresh);
 canvas.dataset.creatures=String(creatures.filter(c=>c.group).length);
 canvas.dataset.agentCount=String(agentError?0:agents.filter(agent=>agentFresh(agent)).length);
 requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
