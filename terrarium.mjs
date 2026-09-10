import { createCreatureCompute } from './creature-compute.mjs';
import { CAPACITY, emptyCreature, syncGroups, prepareCreature, emissionRate, fallbackStep, measured, clamp } from './ecology.mjs';

const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d');
const tooltip = document.querySelector('#tooltip');
const creatures = Array.from({ length: CAPACITY }, emptyCreature);
let snapshot = null, pending = null, networkError = false, pointer = null;
let width = innerWidth, height = innerHeight, time = 0, last = 0;
let compute = null, backend = 'CPU', computeFailed = false;
const particles = [], accumulators = new Map(), rootPhases = new Map();
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
createCreatureCompute(CAPACITY).then(value => {
 compute = value; backend = value.label; console.info('Simulation:', backend);
}).catch(error => { console.warn('CPU simulation:', error.message); });
addEventListener('pagehide', () => compute?.destroy());
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
 ctx.save();ctx.clip();
 for(let j=0;j<7;j++) {
  const points=Array.from({length:33},(_,i)=>[x-rx+i*rx/16,y-ry+j*ry/3+Math.sin(i*.6+time*(.5+agitation)+j)*(1+agitation)]);
  line(points,color, .7);
 }
 // Liquid fill height represents RAM usage; waves represent measured stalls/swap.
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
 // Chip body, paired sensor ears and short contact feet; no trailing appendage.
 ctx.fillStyle='#102b30';ctx.strokeStyle=color;ctx.lineWidth=1.2;
 ctx.beginPath();ctx.ellipse(-s*.15,0,s*.75,s*.43,0,0,Math.PI*2);ctx.fill();ctx.stroke();
 ctx.beginPath();ctx.moveTo(s*.2,-s*.35);ctx.lineTo(s,0);ctx.lineTo(s*.2,s*.35);ctx.closePath();ctx.fill();ctx.stroke();
 const stride=c.level>0?Math.sin(time*(8+24*c.level)+c.phase)*2:0;
 for(const side of [-1,1]) {
  dot(s*.15,side*s*.45,s*.23,color);dot(s*.15,side*s*.45,s*.12,'#102b30');
  line([[-s*.5,side*s*.4],[-s*.5+stride,side*s*.62]],color);
  dot(s*.55,side*s*.13,1.2,valid?'#e3ffe1':'#718883');
 }
 ctx.fillStyle=color;ctx.fillRect(-s*.45,-s*.16,s*.28,s*.32);ctx.restore();
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
async function frame(stamp) {
 const dt=Math.min((stamp-last)/1000||0,.05);last=stamp;time+=dt;
 if(pending){snapshot=pending;pending=null;syncGroups(creatures,snapshot.processes);const allowed=new Set([...snapshot.processes.map(g=>'cpu:'+g.name),...snapshot.network.flatMap(n=>[n.name+'rx',n.name+'tx'])]);for(const key of accumulators.keys())if(!allowed.has(key))accumulators.delete(key);}
 const fresh=!!snapshot&&!networkError&&Date.now()-Date.parse(snapshot.sampledAt)<5000;
 creatures.forEach(c=>prepareCreature(c,dt,fresh));
 if(compute) {
  try {await compute.step(creatures,[],dt,time,true);}
  catch(error){console.warn('GPU compute failed; continuing on CPU',error);compute.destroy();compute=null;computeFailed=true;backend='CPU';fallbackStep(creatures,dt,time);}
 } else fallbackStep(creatures,dt,time);
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
 for(let i=particles.length-1;i>=0;i--) {
  const p=particles[i];p.life-=dt;p.x+=p.vx*dt;p.y+=p.vy*dt;
  if(p.life<=0){particles.splice(i,1);continue;}
  ctx.globalAlpha=Math.min(1,p.life);
  if(p.kind==='bubble'){ctx.strokeStyle=p.color;ctx.beginPath();ctx.arc(p.x,p.y,2.5,0,Math.PI*2);ctx.stroke();}
  else {ctx.fillStyle=p.color;ctx.fillRect(p.x-1,p.y-1,2,2);}
 }
 ctx.globalAlpha=1;hover(hits,fresh);
 // Machine-readable diagnostics for local verification; no permanent HUD.
 canvas.dataset.ready='true';canvas.dataset.backend=backend;canvas.dataset.fresh=String(fresh);
 canvas.dataset.creatures=String(creatures.filter(c=>c.group).length);canvas.dataset.gpuFailed=String(computeFailed);
 requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
