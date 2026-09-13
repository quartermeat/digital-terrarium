import { CAPACITY, emptyCreature, syncGroups, prepareCreature, emissionRate, stepCreatures, measured, clamp } from './ecology.mjs';
import { agentFresh, agentWaypoints } from './agent-activity.mjs';
import { visionFresh, faceWireOpacity, aspectScale, correctPoints, centroid, greyHead, alienEye } from './vision.mjs';
import { FACE_RINGS } from './vision-topology.mjs';
import { orphanShare, deadConfidence, approachRadius, chooseScrubTarget, stepScrubber, beginStrike, stepStrike, emptyScrubber, moteCount, bloomBurn, bloomLevel, KILL_CONFIDENCE } from './scrubber.mjs';

const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d');
const tooltip = document.querySelector('#tooltip');
const creatures = Array.from({ length: CAPACITY }, emptyCreature);
let snapshot = null, pending = null, networkError = false, pointer = null;
let agents = [], agentError = false;
let orphanGroups = {}, orphanCount = 0, motes = 0, scrubbing = false, bloomPending = 0, bloomOwed = 0, scrubArmed = false, salvageBytes = 0;
const scrubber = emptyScrubber();
let vision = null;
let audio = null, audioReceived = 0, musicLevel = 0, musicBass = 0, musicPhase = 0;
const musicWave = Array(40).fill(0);
let width = innerWidth, height = innerHeight, time = 0, last = 0;
const particles = [], accumulators = new Map(), rootPhases = new Map();
const operatorStates = new Map();
const wallpaper = new Image();
let wallpaperReady = false;
wallpaper.onload = () => { wallpaperReady = true; };
wallpaper.src = '/api/wallpaper';

// One event stream carries all three feeds, each pushed at the cadence the
// bridge actually samples it, instead of three polling loops guessing at it.
const stream = new EventSource('/api/stream');
stream.addEventListener('ecosystem', event => {
 try {
  const data = JSON.parse(event.data);
  if (data.version !== 1 || !Array.isArray(data.processes) || !Array.isArray(data.disks) || !Array.isArray(data.network)) throw Error('Incompatible telemetry');
  pending = data; networkError = false;
 } catch (error) { networkError = true; console.warn(error.message); }
});
stream.addEventListener('agents', event => {
 try {
  const data = JSON.parse(event.data);
  if (data.version !== 1 || !Array.isArray(data.agents)) throw Error('Incompatible agent activity');
  agents = data.agents; agentError = false;
 } catch { agentError = true; }
});
// Ownership, unlike movement, only changes when a session ends, so this feed
// arrives slowly and is held until superseded rather than expiring on a timer.
stream.addEventListener('orphans', event => {
 try {
  const data = JSON.parse(event.data);
  if (data.version !== 1 || typeof data.groups !== 'object' || !data.groups) throw Error('Incompatible orphan sweep');
  orphanGroups = data.groups; orphanCount = Array.isArray(data.orphans) ? data.orphans.length : 0;
  motes = Number.isFinite(data.balance) ? data.balance : motes;
  scrubArmed = data.auto === true;
  salvageBytes = Number.isFinite(data.salvageBytes) ? data.salvageBytes : 0;
 } catch { orphanGroups = {}; orphanCount = 0; salvageBytes = 0; }
});
stream.addEventListener('vision', event => {
 try {
  const data = JSON.parse(event.data);
  vision = visionFresh(data) ? data : null;
 } catch { vision = null; }
});
stream.addEventListener('audio', event => {
 try {
  const data = JSON.parse(event.data);
  audio = data.available && Number.isFinite(data.level) && Number.isFinite(data.bass)
   && Array.isArray(data.waveform) && data.waveform.length === 40 && data.waveform.every(Number.isFinite) ? data : null;
  audioReceived = performance.now();
 } catch { audio = null; }
});
// EventSource reconnects on its own; until it does, the scene goes stale rather
// than holding the last reading as though it were current.
stream.addEventListener('error', () => { networkError = true; agentError = true; audio = null; vision = null; orphanGroups = {}; orphanCount = 0; salvageBytes = 0; });
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
 const rot=orphanShare(c.group,orphanGroups);
 ctx.save();ctx.translate(x,y);ctx.rotate(Math.atan2(Math.sin(c.heading)*height,Math.cos(c.heading)*width));ctx.globalAlpha=c.alpha;
 // Abandonment is not stillness, so it cannot be drawn as stillness: the
 // dead share drains the body's colour toward rust instead of freezing it.
 const hue=c.hue-(c.hue-18)*rot, saturation=55-38*rot;
 const color=valid?'hsl('+hue+' '+saturation+'% '+(40+c.level*40)+'%)':'#687b7a';
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
 // A broken arc over the share of the group that no living session owns.
 if(rot>0){
  ctx.globalAlpha=.9;ctx.strokeStyle='hsl(18 70% 58%)';ctx.lineWidth=2;ctx.setLineDash([3,3]);
  ctx.beginPath();ctx.arc(0,0,s*.86,-Math.PI/2,-Math.PI/2+rot*Math.PI*2);ctx.stroke();
  ctx.setLineDash([]);ctx.lineWidth=1.2;
 }
 ctx.restore();
 if(valid)emit('cpu:'+c.group.name,c.level*2,dt,()=>({x,y,vx:0,vy:-12,life:.7,color:'#9ef5b9',kind:'spark'}));
 // Rot sheds regardless of activity: this is the one emission that does not
 // depend on the group doing anything, because being abandoned is not an act.
 if(rot>0)emit('rot:'+c.group.name,rot*3,dt,()=>({x:x+(Math.random()-.5)*s,y,vx:(Math.random()-.5)*8,vy:14,life:1.4,color:'hsl(18 65% 55%)',kind:'spark'}));
 hits.push({x,y,rx:s+8,ry:s+8,text:c.group.name+' / '+c.group.count+' processes\nCPU '+percent(c.group.cpu)+' of whole machine\nRSS sum '+bytes(c.group.rssBytes)+' (shared pages may repeat)\nThreads '+c.group.threads+' · runnable '+c.group.running+'\n'+(!valid?'Waiting for measurements':c.level>0?'Active':'Resting')+(rot>0?'\nABANDONED '+orphanGroups[c.group.name].dead+' of '+c.group.count+': holding a session that ended'+'\nDead with '+Math.round(deadConfidence(c.group,orphanGroups)*100)+'% confidence':'')});
}
// The scrubber is the one body in the tank that is not a process. It exists
// only while something is abandoned, it consumes what the sweep proved dead,
// and it is what turns reclaimed memory into motes.
function burstMotes(amount,color) {
 const specks=moteCount(amount);
 for(let i=0;i<specks;i++)particles.push({x:scrubber.x*width,y:scrubber.y*height,
  vx:(Math.random()-.5)*50,vy:-30-Math.random()*50,life:2.6,color,kind:'mote'});
}
// A kill. The strike begins on the frame the decision is made rather than when
// the bridge answers, so what you watch is the killer committing, not a
// round trip completing.
function consumeCorpse() {
 if(scrubbing||!scrubArmed)return;
 scrubbing=true;
 beginStrike(scrubber,'reclaimed',0);
 fetch('/api/scrub',{method:'POST'}).then(response=>response.json()).then(result=>{
  if(Number.isFinite(result.balance))motes=result.balance;
  if(scrubber.strike)scrubber.strike.amount=result.minted;
  burstMotes(result.minted,'#ffd98a');
 }).catch(()=>{}).finally(()=>{scrubbing=false;});
}
// Free currency. Nothing is killed here -- these bodies already left -- so it
// needs no arming, and the animation is a gathering rather than a blow.
function harvestSalvage() {
 if(scrubbing||salvageBytes<=0)return;
 scrubbing=true; salvageBytes=0;
 beginStrike(scrubber,'salvaged',0);
 fetch('/api/salvage',{method:'POST'}).then(response=>response.json()).then(result=>{
  if(Number.isFinite(result.balance))motes=result.balance;
  if(scrubber.strike)scrubber.strike.amount=result.minted;
  burstMotes(result.minted,'#9fe8d0');
 }).catch(()=>{}).finally(()=>{scrubbing=false;});
}
// The two acts must not look alike. A reclaim throws a hot ring outward and
// breaks the body apart; a salvage draws quiet rings inward, because nothing
// was taken from anything still living.
function drawStrike(strike) {
 if(!strike)return;
 const x=scrubber.x*width,y=scrubber.y*height,t=Math.min(1,strike.t);
 ctx.save();
 if(strike.kind==='reclaimed'){
  const r=10+t*72;
  ctx.globalAlpha=(1-t)*.9;ctx.strokeStyle='#ffca7a';ctx.lineWidth=3*(1-t)+.6;
  ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.stroke();
  ctx.globalAlpha=(1-t)*.5;ctx.strokeStyle='#fff3d6';
  ctx.beginPath();ctx.arc(x,y,r*.58,0,Math.PI*2);ctx.stroke();
  ctx.globalAlpha=(1-t)*.8;ctx.strokeStyle='#ffca7a';ctx.lineWidth=1.4;
  for(let i=0;i<8;i++){
   const a=i*Math.PI/4+t*1.6;
   ctx.beginPath();ctx.moveTo(x+Math.cos(a)*r*.45,y+Math.sin(a)*r*.45);
   ctx.lineTo(x+Math.cos(a)*r,y+Math.sin(a)*r);ctx.stroke();
  }
 } else {
  ctx.strokeStyle='#9fe8d0';ctx.lineWidth=1.4;
  for(let i=0;i<3;i++){
   const p=Math.min(1,Math.max(0,t*1.4-i*.18)),r=48*(1-p)+6;
   ctx.globalAlpha=(1-p)*.5;
   ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.stroke();
  }
 }
 ctx.restore();ctx.globalAlpha=1;
}
function spendBloom(amount) {
 fetch('/api/motes',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({amount,reason:'habitat bloom'})})
  .then(response=>response.json()).then(result=>{if(Number.isFinite(result.balance))motes=result.balance;}).catch(()=>{});
}
function drawScrubber(hits,dt) {
 if(scrubber.alpha<=.01)return;
 const x=scrubber.x*width,y=scrubber.y*height,s=13;
 ctx.save();ctx.translate(x,y);ctx.globalAlpha=scrubber.alpha;
 // Bristles: the one organism here that reads as alive rather than mechanical,
 // because it is the only one doing something to the tank rather than in it.
 ctx.strokeStyle='#bdfff0';ctx.lineWidth=1.1;
 for(let i=0;i<10;i++){
  const a=scrubber.phase*.5+i*Math.PI/5,r=s*(.62+.24*Math.sin(scrubber.phase*2+i));
  ctx.beginPath();ctx.moveTo(Math.cos(a)*s*.44,Math.sin(a)*s*.44);ctx.lineTo(Math.cos(a)*r,Math.sin(a)*r);ctx.stroke();
 }
 ctx.fillStyle='#0d3b3a';ctx.strokeStyle='#e8fffb';ctx.lineWidth=1.6;
 ctx.beginPath();ctx.arc(0,0,s*.42,0,Math.PI*2);ctx.fill();ctx.stroke();
 ctx.fillStyle='#e8fffb';ctx.globalAlpha=scrubber.alpha*(.55+.45*Math.sin(scrubber.phase*3));
 ctx.beginPath();ctx.arc(0,0,s*.17,0,Math.PI*2);ctx.fill();
 ctx.restore();ctx.globalAlpha=1;
 hits.push({x,y,rx:s+10,ry:s+10,text:'SCRUBBER\n'+orphanCount+' abandoned process'+(orphanCount===1?'':'es')+' in the tank'
  +(scrubber.target?'\nStalking '+scrubber.target+' at '+Math.round(scrubber.confidence*100)+'% confidence'
    +(scrubber.confidence>=KILL_CONFIDENCE?' (sure enough to strike)':' (holding off)'):'\nNothing to consume')
  +'\nMotes '+Math.round(motes)+(salvageBytes>0?'\nSalvage waiting: '+bytes(salvageBytes):'')
  +(scrubArmed?'':'\nNot armed: it may salvage, but never kill')});
}
// Light the tank earned. A balance that is never replenished burns down to
// dark on its own, so a clean machine is a bright one.
function drawBloom() {
 const level=bloomLevel(motes);
 if(level<=.01)return;
 const glow=ctx.createRadialGradient(width/2,height*.55,0,width/2,height*.55,Math.max(width,height)*.7);
 glow.addColorStop(0,'rgba(150,255,226,'+(level*.09).toFixed(3)+')');
 glow.addColorStop(1,'rgba(150,255,226,0)');
 ctx.fillStyle=glow;ctx.fillRect(0,0,width,height);
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
// The camera does not reach into the habitat; it hangs a head over it, derived
// from the tracked face rather than traced from it.
function visionSpace() {
 // Re-checked every frame, not only on arrival: a stream that stalls without
 // erroring must let the skull expire rather than pin it where it was last seen.
 if(!visionFresh(vision)||!vision.face) return null;
 const scale=aspectScale(vision.aspect,width/height);
 return {...vision.face,points:correctPoints(vision.face.points,scale)};
}
function arcLine(ax,ay,bx,by,color,weight,jitter) {
 const nx=ay-by,ny=bx-ax,length=Math.hypot(nx,ny)||1;
 ctx.beginPath();ctx.moveTo(ax,ay);
 for(let i=1;i<4;i++) {
  const t=i/4,offset=(Math.random()-.5)*jitter;
  ctx.lineTo(ax+(bx-ax)*t+nx/length*offset,ay+(by-ay)*t+ny/length*offset);
 }
 ctx.lineTo(bx,by);ctx.strokeStyle=color;ctx.lineWidth=weight;ctx.stroke();
}
function arcEdges(points,edges,color,weight,jitter) {
 for(const [a,b] of edges)arcLine(points[a].x,points[a].y,points[b].x,points[b].y,color,weight,jitter);
}
function arcRing(ring,color,weight,jitter) {
 for(let i=0;i<ring.length;i++) {
  const a=ring[i],b=ring[(i+1)%ring.length];
  arcLine(a.x,a.y,b.x,b.y,color,weight,jitter);
 }
}
function ringPath(ring) {
 ctx.beginPath();ring.forEach((point,i)=>i?ctx.lineTo(point.x,point.y):ctx.moveTo(point.x,point.y));ctx.closePath();
}
const discharges=[];
function drawGrey(face,hits,dt) {
 const opacity=faceWireOpacity(face.span);
 if(opacity<=0)return;
 const points=face.points.map(point=>({x:point.x*width,y:point.y*height}));
 const ring=indices=>indices.map(index=>points[index]);
 const head=greyHead(ring(FACE_RINGS.cranium[0]));
 if(!head.length)return;
 const xs=head.map(point=>point.x);
 const span=Math.max(...xs)-Math.min(...xs),middle=(Math.max(...xs)+Math.min(...xs))/2;
 // Mains hum: a fast flicker under a slower sag, like a tube not quite making
 // contact. Never fully dark, so the head reads as lit rather than blinking.
 const buzz=.76+Math.sin(time*57)*.08+Math.sin(time*13.7)*.06+Math.random()*.1;
 const glow=opacity*buzz;
 const hot='rgba(198,255,250,'+glow+')',wire='rgba(96,232,255,'+glow+')',dim='rgba(58,168,226,'+glow*.7+')';
 ctx.save();ctx.lineCap='round';
 // A grey has smooth skin, so the cranium is stroked once and cleanly. Only the
 // habitat's own electricity crackles, and it crawls the outline rather than
 // roughening every edge the way bone did.
 ringPath(head);ctx.fillStyle='rgba(4,17,23,'+opacity*.72+')';ctx.fill();
 ctx.shadowColor='#5ee6ff';ctx.shadowBlur=22*opacity;
 arcRing(head,wire,2.4,1.1);
 // The eyes track the real ones, so turning your head turns theirs, but they
 // are sized against the derived cranium: a grey's eyes are a fraction of its
 // skull, not of the human face underneath.
 const eyes=[centroid(ring(FACE_RINGS.leftEye[0])),centroid(ring(FACE_RINGS.rightEye[0]))];
 for(const eye of eyes) {
  const outward=eye.x<middle?-1:1;
  // The reference's eyes sit wider than human eye landmarks, at roughly 43%
  // of the head width centre-to-centre. Move the tracked point into that alien
  // spacing, then build the eye around it.
  const seat={x:eye.x+outward*span*.055,y:eye.y+span*.025};
  const shape=alienEye(seat,span*.4,span*.25,.34,outward);
  ringPath(shape);
  // Kill the glow while filling: a lit shadow bleeds through the fill and turns
  // a black eye grey, which is the one colour it must not be.
  ctx.shadowBlur=0;
  ctx.fillStyle='rgba(0,0,0,'+opacity*.97+')';ctx.fill();
  ctx.shadowBlur=22*opacity;
  arcRing(shape,wire,1.9,1);
  // The bright circle is the tracked human eye. Keep it at the visual centre of
  // the large black eye so the camera mapping reads directly on the grey.
  ctx.shadowBlur=18*opacity;
  dot(seat.x,seat.y,Math.max(1.4,span*.013),'rgba(226,255,252,'+glow*.85+')');
  ctx.shadowBlur=22*opacity;
 }
 const brow=(eyes[0].y+eyes[1].y)/2;
 const chinY=Math.max(...head.map(point=>point.y));
 // No nose and no lips: two nostril slits and a short seam, both derived, since
 // the mesh measures a human face that has neither of these.
 const mouthY=brow+(chinY-brow)*.66,nostrilY=brow+(chinY-brow)*.44;
 for(const side of [-1,1])
  line([[middle+side*span*.028,nostrilY],[middle+side*span*.034,nostrilY+span*.026]],dim,1.6);
 // A shallow downward bow, not a tick: a straight segment floating on a blank
 // face reads as a stray mark rather than as a mouth.
 ctx.beginPath();
 ctx.moveTo(middle-span*.085,mouthY);
 ctx.quadraticCurveTo(middle,mouthY+span*.022,middle+span*.085,mouthY);
 ctx.strokeStyle=hot;ctx.lineWidth=1.7;ctx.stroke();
 // Electricity is the habitat's, not the creature's: bolts crawl between
 // neighbouring points on the outline, anchored by index so they stay on the
 // head as it moves. A chord across the face would read as a screen scratch.
 if(Math.random()<dt*6&&discharges.length<5) {
  const from=Math.floor(Math.random()*head.length);
  discharges.push({from,span:2+Math.floor(Math.random()*4),life:.22});
 }
 for(let i=discharges.length-1;i>=0;i--) {
  const bolt=discharges[i];bolt.life-=dt;
  if(bolt.life<=0){discharges.splice(i,1);continue;}
  const a=head[bolt.from%head.length],b=head[(bolt.from+bolt.span)%head.length];
  arcLine(a.x,a.y,b.x,b.y,'rgba(224,255,255,'+opacity*Math.min(1,bolt.life/.22)+')',2,Math.hypot(b.x-a.x,b.y-a.y)*.9);
  if(particles.length<160&&Math.random()<.5)
   particles.push({x:b.x,y:b.y,vx:(Math.random()-.5)*70,vy:(Math.random()-.5)*70,life:.2+Math.random()*.3,color:'#d6fbff',kind:'spark'});
 }
 ctx.restore();
 const ys=head.map(point=>point.y);
 hits.push({x:middle,y:(Math.min(...ys)+Math.max(...ys))/2,rx:span/2,ry:(Math.max(...ys)-Math.min(...ys))/2,
  text:'Grey / camera\nYour face, spanning '+(face.span*100).toFixed(0)+'% of the frame\nLean closer to bring it up'});
}
function frame(stamp) {
 const dt=Math.min((stamp-last)/1000||0,.05);last=stamp;time+=dt;
 if(pending){snapshot=pending;pending=null;syncGroups(creatures,snapshot.processes);const allowed=new Set([...snapshot.processes.map(g=>'rot:'+g.name),...snapshot.processes.map(g=>'cpu:'+g.name),...snapshot.network.flatMap(n=>[n.name+'rx',n.name+'tx'])]);for(const key of accumulators.keys())if(!allowed.has(key))accumulators.delete(key);}
 const fresh=!!snapshot&&!networkError&&Date.now()-Date.parse(snapshot.sampledAt)<5000;
 creatures.forEach(c=>prepareCreature(c,dt,fresh));
 stepCreatures(creatures,dt,time);
 const corpse=chooseScrubTarget(scrubber,creatures,orphanGroups);
 const certainty=corpse?deadConfidence(corpse.group,orphanGroups):0;
 const committed=stepScrubber(scrubber,corpse,certainty,dt);
 if(!scrubber.strike){
  if(committed)consumeCorpse();
  else if(salvageBytes>0)harvestSalvage();
 }
 const strike=stepStrike(scrubber,dt);
 // The habitat burns its balance down in whole motes, batched so the bloom
 // does not talk to the bridge every other frame.
 const burn=bloomBurn(bloomPending,motes,dt);bloomPending=burn.pending;bloomOwed+=burn.spend;
 if(bloomOwed>=5){const owed=bloomOwed;bloomOwed=0;motes=Math.max(0,motes-owed);spendBloom(owed);}
 const face=visionSpace();
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
 drawScrubber(hits,dt);drawStrike(strike);
 if(face)drawGrey(face,hits,dt);
 for(const id of operatorStates.keys())if(!agents.some(agent=>agent.id===id))operatorStates.delete(id);
 for(let i=particles.length-1;i>=0;i--) {
  const p=particles[i];p.life-=dt;p.x+=p.vx*dt;p.y+=p.vy*dt;
  if(p.life<=0){particles.splice(i,1);continue;}
  ctx.globalAlpha=Math.min(1,p.life);
   if(p.kind==='bubble'){ctx.strokeStyle=p.color;ctx.beginPath();ctx.arc(p.x,p.y,2.5,0,Math.PI*2);ctx.stroke();}
   else if(p.kind==='code'){ctx.fillStyle=p.color;ctx.font='8px monospace';ctx.fillText(Math.random()>.5?'1':'0',p.x,p.y);}
   else if(p.kind==='mote'){ctx.fillStyle=p.color;ctx.beginPath();ctx.arc(p.x,p.y,1.8,0,Math.PI*2);ctx.fill();
    ctx.globalAlpha=Math.min(1,p.life)*.35;ctx.beginPath();ctx.arc(p.x,p.y,4.2,0,Math.PI*2);ctx.fill();}
  else {ctx.fillStyle=p.color;ctx.fillRect(p.x-1,p.y-1,2,2);}
 }
 ctx.globalAlpha=1;drawBloom();hover(hits,fresh);
 // Machine-readable diagnostics for local verification; no permanent HUD.
 canvas.dataset.ready='true';canvas.dataset.fresh=String(fresh);
 canvas.dataset.creatures=String(creatures.filter(c=>c.group).length);
 canvas.dataset.agentCount=String(agentError?0:agents.filter(agent=>agentFresh(agent)).length);
 canvas.dataset.head=String(!!face&&faceWireOpacity(face.span)>0);
 canvas.dataset.orphans=String(orphanCount);
 canvas.dataset.motes=String(Math.round(motes));
 canvas.dataset.scrubber=String(scrubber.alpha>.01);
 canvas.dataset.scrubConfidence=String(Math.round(scrubber.confidence*100));
 canvas.dataset.strike=scrubber.strike?scrubber.strike.kind:'';
 requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
