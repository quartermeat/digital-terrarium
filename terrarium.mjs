import { createCreatureCompute } from './creature-compute.mjs';
import { advanceMouse } from './circuit-mouse.mjs';
const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d');
let w, h, time = 0, last = 0, paused = false, aquarium = true, consumed = 0;
let stats = {}, statsAt = 0;
const wallpaper = new Image();
let wallpaperReady = false;
wallpaper.onload = () => { wallpaperReady = true; };
wallpaper.src = '/api/wallpaper';
async function pollStats(){
 try { const response = await fetch('/api/system-stats', {signal:AbortSignal.timeout(1500)}); if(!response.ok)throw Error('unavailable'); stats = await response.json(); statsAt = performance.now(); } catch { stats = {}; }
}
pollStats();setInterval(pollStats,2000);
const packets = [], creatures = Array.from({length:28}, (_,i)=>({x:Math.random(),y:Math.random(),phase:i*2.4,energy:.5,speed:.025+Math.random()*.025}));
let compute=null, computeStatus='CPU / checking GPU';
try {
 const response=await fetch('/api/habitat', {signal:AbortSignal.timeout(2000)});
 if(response.ok){const habitat=await response.json();if(habitat.version===1&&habitat.creatures?.length===28)creatures.splice(0,creatures.length,...habitat.creatures);}
} catch(error){console.warn('Go habitat setup unavailable; using local population',error);}
try { compute=await createCreatureCompute(creatures.length);computeStatus=compute.label; }
catch(error){computeStatus='CPU / GPU compute unavailable';console.warn(computeStatus,error);}
addEventListener('pagehide',()=>compute?.destroy());
const roots = Array.from({length:9},(_,i)=>({x:.06+i*.087,y:.78+Math.sin(i*5)*.12,charge:0}));
function resize(){w=innerWidth;h=innerHeight;const d=Math.min(devicePixelRatio,2);canvas.width=w*d;canvas.height=h*d;ctx.setTransform(d,0,0,d,0,0);}
addEventListener('resize',resize);resize();
const tooltip=document.querySelector('#tooltip');let pointer=null;
addEventListener('mousemove',event=>{pointer={x:event.clientX,y:event.clientY};});
addEventListener('mouseleave',()=>{pointer=null;tooltip.style.display='none';});
canvas.onclick=e=>{for(let i=0;i<8;i++)if(packets.length<120)packets.push({x:e.clientX/w+(Math.random()-.5)*.04,y:e.clientY/h+(Math.random()-.5)*.04,life:30});};
function line(points,color,width=1){ctx.beginPath();points.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();}
function dot(x,y,r,color){ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();}
function fissure(x,y,rx,ry){ctx.save();ctx.translate(x,y);ctx.beginPath();for(let i=0;i<32;i++){const a=i/32*Math.PI*2,k=1+.1*Math.sin(i*17);const px=Math.cos(a)*rx*k,py=Math.sin(a)*ry*k;i?ctx.lineTo(px,py):ctx.moveTo(px,py);}ctx.closePath();ctx.shadowBlur=22;ctx.shadowColor='#3effba';ctx.fillStyle='#041416';ctx.fill();ctx.strokeStyle=Number.isFinite(stats.memory)?`hsl(${160-stats.memory*110} 65% 65%)`:'#536c67';ctx.lineWidth=2;ctx.stroke();ctx.shadowBlur=0;ctx.clip();for(let j=0;j<12;j++){const yy=-ry+j*ry/6;line(Array.from({length:30},(_,i)=>[-rx+i*rx/14,yy+Math.sin(i*.6+time+j)*4]),'#236956',1);}for(let i=0;i<8;i++){const a=time*.2+i;dot(Math.sin(a*1.3)*rx*.8,Math.cos(a)*ry*.6,2,'#a0ffc9');}ctx.restore();for(let i=0;i<6;i++){const a=i*1.1;line([[x+Math.cos(a)*rx,y+Math.sin(a)*ry],[x+Math.cos(a)*rx*1.15,y+Math.sin(a)*ry*1.4],[x+Math.cos(a+.1)*rx*1.4,y+Math.sin(a+.1)*ry*1.8]],'#193e37',2);}}
async function frame(stamp){const dt=Math.min((stamp-last)/1000||0,.05);last=stamp;if(paused){requestAnimationFrame(frame);return;}time+=dt;
if(Math.random()<dt*2&&packets.length<120){const r=roots[Math.floor(Math.random()*roots.length)];packets.push({x:r.x,y:aquarium?.8:r.y-.1,life:25});}
for(let i=packets.length-1;i>=0;i--){const p=packets[i];p.life-=dt;p.y=Math.min(.95,p.y+dt*.008);if(p.life<=0)packets.splice(i,1);}
// Finish asynchronous simulation before repainting: never present a partial frame.
if(compute){
 try {await compute.step(creatures,packets,dt,time,aquarium);}
 catch(error){console.warn('Switching to CPU simulation',error);compute.destroy();compute=null;computeStatus='CPU / GPU compute failed';}
}
ctx.clearRect(0,0,w,h);

if(wallpaperReady){
 const scale=Math.max(w/wallpaper.naturalWidth,h/wallpaper.naturalHeight);
 const width=wallpaper.naturalWidth*scale,height=wallpaper.naturalHeight*scale;
 ctx.drawImage(wallpaper,(w-width)/2,(h-height)/2,width,height);
}else{
 const fallback=ctx.createRadialGradient(w*.65,h*.1,0,w*.5,h*.5,w);fallback.addColorStop(0,'#123c3d');fallback.addColorStop(1,'#02090e');ctx.fillStyle=fallback;ctx.fillRect(0,0,w,h);
}


roots.forEach((r,i)=>{r.charge=Math.max(0,r.charge-dt*.1);const x=r.x*w,y=(aquarium?.93:r.y)*h;const height=(50+i%3*30)*(1+r.charge*.4);fissure(x,y,25,6);for(let j=0;j<3;j++){const endX=x+(j-1)*27,endY=y-height+j*9;line([[x,y],[x,y-height*.4],[endX,y-height*.65],[endX,endY]],r.charge>0?'#9cf6bc':'#386e61',2);const p=(time*(.12+(stats.cpu??0)*1.6)+j*.3+i*.1)%1;dot(x+(endX-x)*p,y-height*p,2,'#a8ffb5');ctx.strokeStyle='#7cae7c';ctx.strokeRect(endX-5,endY-7,10,10);}});
for(const p of packets){ctx.fillStyle='#e0d992';ctx.fillRect(p.x*w-2,p.y*h-2,4,4);}
const foodSnapshot=packets.slice();
creatures.forEach((c,i)=>{
 let nearest=null,dist=Infinity;
 if(compute){nearest=foodSnapshot[c.target];dist=c.distance;}
 else {
  for(const p of packets){const d=Math.hypot(p.x-c.x,p.y-c.y);if(d<dist){dist=d;nearest=p;}}
  const tx=nearest?.x??(.5+Math.sin(time*.09+c.phase)*.43),ty=nearest?.y??(aquarium?.48+Math.cos(time*.12+c.phase)*.35:.77+Math.sin(time*.2+c.phase)*.15);
  const dx=tx-c.x,dy=ty-c.y,d=Math.hypot(dx,dy)||1;
  if(aquarium){const step=Math.min(d,c.speed*dt);c.x+=dx/d*step;c.y+=dy/d*step;c.heading=Math.atan2(dy,dx);}
  else{advanceMouse(c,dx,dy,dt,time);}
  c.energy=Math.max(.2,c.energy-dt*.015);
 }
 const foodIndex=packets.indexOf(nearest);
 if(foodIndex>=0&&dist<.015&&(aquarium||!c.nibble)){packets.splice(foodIndex,1);c.energy=1;c.nibble=.65;consumed++;roots[i%roots.length].charge=1;}
ctx.save();ctx.translate(c.x*w,c.y*h);ctx.rotate(Math.atan2(Math.sin(c.heading??0)*h,Math.cos(c.heading??0)*w));
ctx.shadowBlur=0;ctx.shadowColor='#66ffe0';ctx.lineWidth=1;
if(aquarium){
 // Aquatic packet grazers are self-contained glyphs: no tail, beam, or path.
 const size=10;ctx.strokeStyle=`rgba(114,239,214,${.4+c.energy*.6})`;ctx.beginPath();ctx.moveTo(size,0);ctx.lineTo(0,-size*.55);ctx.lineTo(-size,0);ctx.lineTo(0,size*.55);ctx.closePath();ctx.stroke();dot(size*.35,0,1.4,'#e1ffce');
}else{
 // Tiny circuit mice: articulated contacts, chip shell, sensor ears. No trail.
 ctx.scale(1.3,1.3);
 const step=c.activity==='scurrying'?Math.sin(time*24+i)*1.5:0;
 const twitch=c.activity==='scurrying'?0:Math.sin(time*19+i)*.7;
 for(const side of [-1,1])for(const x of [-5,4]){
  line([[x,side*4],[x+(x<0?step:-step),side*7]],'#82b9b1',1.5);
 }
 ctx.fillStyle='#102b30';ctx.strokeStyle='#7dcfc0';ctx.beginPath();
 ctx.ellipse(-2,0,8,5,0,0,Math.PI*2);ctx.fill();ctx.stroke();
 ctx.beginPath();ctx.moveTo(2,-4);ctx.lineTo(11,0);ctx.lineTo(2,4);ctx.closePath();ctx.fill();ctx.stroke();
 for(const side of [-1,1]){
  dot(2+twitch,side*5,3.2,'#6baba6');dot(2+twitch,side*5,1.7,'#17383e');
  dot(6,side*2,1,'#c4fff0');
 }
 ctx.fillStyle='#294e53';ctx.fillRect(-6,-2.5,5,5);
 line([[-5,0],[0,0],[1,1]],'#85e6c4');
 dot(11+twitch,0,c.activity==='nibbling'?1.8:1.2,'#f0d998');
 for(const side of [-1,1])line([[8,side*2],[11+twitch,side*4]],'#739e96',.7);
}
ctx.restore();});

if(pointer){
 let closest=null,distance=Infinity;
 creatures.forEach((c,i)=>{const d=Math.hypot(pointer.x/w-c.x,pointer.y/h-c.y)*Math.max(w,h);if(d<distance){distance=d;closest={text:`packet grazer ${String(i+1).padStart(2,'0')}\nenergy ${Math.round(c.energy*100)}%`,x:c.x*w,y:c.y*h};}});
 roots.forEach((r,i)=>{const d=Math.hypot(pointer.x/w-r.x,pointer.y/h-.93)*Math.max(w,h);if(d<distance){distance=d;closest={text:`circuit root ${String(i+1).padStart(2,'0')}\ncharge ${Math.round(r.charge*100)}%`,x:r.x*w,y:.93*h};}});
 if(closest&&distance<42){tooltip.textContent=closest.text;tooltip.style.left=`${Math.min(w-190,closest.x+14)}px`;tooltip.style.top=`${Math.max(8,closest.y-40)}px`;tooltip.style.display='block';}else tooltip.style.display='none';
}
requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
