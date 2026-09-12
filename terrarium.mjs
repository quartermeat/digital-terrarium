import { CAPACITY, emptyCreature, syncGroups, prepareCreature, emissionRate, stepCreatures, measured, clamp } from './ecology.mjs';
import { agentFresh, agentWaypoints } from './agent-activity.mjs';
import { visionFresh, faceWireOpacity, aspectScale, correctPoints, centroid, expandRing, roundRing, toothBand, nasalCavity, skullSilhouette } from './vision.mjs';
import { FACE_EDGES, FACE_RINGS } from './vision-topology.mjs';

const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d');
const tooltip = document.querySelector('#tooltip');
const creatures = Array.from({ length: CAPACITY }, emptyCreature);
let snapshot = null, pending = null, networkError = false, pointer = null;
let agents = [], agentError = false;
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
stream.addEventListener('error', () => { networkError = true; agentError = true; audio = null; vision = null; });
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
// The camera no longer reaches into the habitat; it hangs a skull over it. A
// straight run of wire reads as a diagram, so every edge is re-jittered each
// frame: the skull crackles instead of sitting still.
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
function drawSkull(face,hits,dt) {
 const opacity=faceWireOpacity(face.span);
 if(opacity<=0)return;
 const points=face.points.map(point=>({x:point.x*width,y:point.y*height}));
 const ring=indices=>indices.map(index=>points[index]);
 const cranium=ring(FACE_RINGS.cranium[0]);
 // Mains hum: a fast flicker under a slower sag, like a tube not quite making
 // contact. Never fully dark, so the skull reads as lit rather than blinking.
 const buzz=.76+Math.sin(time*57)*.08+Math.sin(time*13.7)*.06+Math.random()*.1;
 const glow=opacity*buzz;
 const hot='rgba(198,255,250,'+glow+')',wire='rgba(96,232,255,'+glow+')',dim='rgba(58,168,226,'+glow*.7+')';
 const hollow='rgba(0,4,7,'+opacity*.94+')';
 ctx.save();ctx.lineCap='round';
 // Bone before wire: a dark vault gives the skull mass instead of leaving it a
 // net laid flat over the desktop. The brow line springs the cranium, so it is
 // measured before anything is drawn.
 const browY=Math.min(...[...FACE_EDGES.leftBrow,...FACE_EDGES.rightBrow].flat().map(index=>points[index].y));
 const silhouette=skullSilhouette(cranium,browY);
 ringPath(silhouette);ctx.fillStyle='rgba(3,15,21,'+opacity*.7+')';ctx.fill();
 ctx.shadowColor='#5ee6ff';ctx.shadowBlur=20*opacity;
 arcRing(silhouette,wire,2.4,3);
 // Brows and lips are soft tissue and a skull has neither: drawing them is what
 // makes a face. The brow line is used only to seat the top of each socket, and
 // the mouth only to place the teeth.
 const sockets=[],irises=[];
 for(const [lid,iris,brow] of [
  [FACE_RINGS.leftEye[0],FACE_RINGS.leftIris[0],FACE_EDGES.leftBrow],
  [FACE_RINGS.rightEye[0],FACE_RINGS.rightIris[0],FACE_EDGES.rightBrow]]) {
  const lidRing=ring(lid);
  const centre=centroid(lidRing);
  // Grow the hollow about the lid's own centre, then lift it under the brow
  // ridge. Expanding about an offset point would fling the ring away from it
  // rather than open it out, which is not what an orbit does.
  const lift=(centre.y-Math.min(...brow.flat().map(index=>points[index].y)))*.5;
  const seated={x:centre.x,y:centre.y-lift};
  const socket=roundRing(expandRing(lidRing,2.1),.58).map(point=>({x:point.x,y:point.y-lift}));
  sockets.push({socket,centre:seated});
  irises.push(centroid(ring(iris)));
  ringPath(socket);ctx.fillStyle=hollow;ctx.fill();
  arcRing(socket,wire,2.1,2.6);
 }
 // An ember deep in each hollow, pulsing out of step with the mains flicker, so
 // the sockets read as lit from within rather than as pupils.
 const ember=(1+Math.sin(time*6.3))*.5;
 for(const [index,{centre}] of sockets.entries()) {
  const look=irises[index];
  // Drift the ember toward where the eye actually points, but keep it deep.
  const at={x:centre.x+(look.x-centre.x)*.45,y:centre.y+(look.y-centre.y)*.45};
  const radius=Math.max(2,face.span*width*.009)*(.75+ember*.5);
  ctx.shadowBlur=28*opacity;
  dot(at.x,at.y,radius*3.2,'rgba(96,232,255,'+opacity*.13*(.5+ember)+')');
  dot(at.x,at.y,radius,'rgba(226,255,252,'+glow+')');
  ctx.shadowBlur=20*opacity;
 }
 // Teeth: a straight band of bone across the jaw, wider than the lips that
 // normally cover it, split into upper and lower rows.
 const band=toothBand(ring(FACE_RINGS.mouth[0]),9);
 if(band) {
  ctx.beginPath();ctx.rect(band.left,band.top,band.right-band.left,band.bottom-band.top);
  ctx.fillStyle=hollow;ctx.fill();
  // Two rows of bone rather than a grid: the seam between the jaws is the
  // bright line, the divisions between teeth only faintly scored.
  for(const x of band.bars)line([[x,band.top],[x,band.bottom]],dim,1.1);
  line([[band.left,band.top],[band.right,band.top]],wire,1.5);
  line([[band.left,band.bottom],[band.right,band.bottom]],wire,1.5);
  line([[band.left,band.midline],[band.right,band.midline]],hot,1.8);
 }
 // The mesh has no nasal aperture, so it is derived from the bridge between the
 // sockets down toward the teeth.
 const nose=nasalCavity(sockets[0].centre,sockets[1].centre,band?band.top:Math.max(...cranium.map(point=>point.y)));
 if(nose.length) {
  ringPath(nose);ctx.fillStyle=hollow;ctx.fill();
  arcRing(nose,dim,1.6,2);
 }
 // A skull that only glows is a diagram; one that discharges is alive. Bolts
 // crawl between neighbouring points on the outline: a chord straight across
 // the face reads as a scratch on the screen, not as electricity on bone.
 if(Math.random()<dt*7&&discharges.length<6) {
  const from=Math.floor(Math.random()*silhouette.length);
  discharges.push({from,span:2+Math.floor(Math.random()*4),life:.22});
 }
 for(let i=discharges.length-1;i>=0;i--) {
  const bolt=discharges[i];bolt.life-=dt;
  if(bolt.life<=0){discharges.splice(i,1);continue;}
  // Indices, not coordinates: a bolt stays anchored to the skull as it moves.
  const a=silhouette[bolt.from%silhouette.length],b=silhouette[(bolt.from+bolt.span)%silhouette.length];
  const fade=Math.min(1,bolt.life/.22);
  arcLine(a.x,a.y,b.x,b.y,'rgba(224,255,255,'+opacity*fade+')',2,Math.hypot(b.x-a.x,b.y-a.y)*.9);
  if(particles.length<160&&Math.random()<.5)
   particles.push({x:b.x,y:b.y,vx:(Math.random()-.5)*70,vy:(Math.random()-.5)*70,life:.2+Math.random()*.3,color:'#d6fbff',kind:'spark'});
 }
 ctx.restore();
 const xs=points.map(point=>point.x),ys=points.map(point=>point.y);
 hits.push({x:(Math.min(...xs)+Math.max(...xs))/2,y:(Math.min(...ys)+Math.max(...ys))/2,
  rx:(Math.max(...xs)-Math.min(...xs))/2,ry:(Math.max(...ys)-Math.min(...ys))/2,
  text:'Electric skull / camera\nYour face, spanning '+(face.span*100).toFixed(0)+'% of the frame\nLean closer to bring it up'});
}
function frame(stamp) {
 const dt=Math.min((stamp-last)/1000||0,.05);last=stamp;time+=dt;
 if(pending){snapshot=pending;pending=null;syncGroups(creatures,snapshot.processes);const allowed=new Set([...snapshot.processes.map(g=>'cpu:'+g.name),...snapshot.network.flatMap(n=>[n.name+'rx',n.name+'tx'])]);for(const key of accumulators.keys())if(!allowed.has(key))accumulators.delete(key);}
 const fresh=!!snapshot&&!networkError&&Date.now()-Date.parse(snapshot.sampledAt)<5000;
 creatures.forEach(c=>prepareCreature(c,dt,fresh));
 stepCreatures(creatures,dt,time);
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
 if(face)drawSkull(face,hits,dt);
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
 canvas.dataset.skull=String(!!face&&faceWireOpacity(face.span)>0);
 requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
