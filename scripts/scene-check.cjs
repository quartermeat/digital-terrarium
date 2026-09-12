const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
// Drive the real feeds rather than stubbing them: agents through an isolated
// state directory, speaker audio through a synthetic recorder.
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terrarium-agents-'));
const agentFile = path.join(agentDir, 'scene-test.json');
const speakerMode = path.join(agentDir, 'speaker-mode');
const setSpeaker = mode => fs.writeFileSync(speakerMode, mode);
const setAgent = (phase, ageMs = 0) => fs.writeFileSync(agentFile, JSON.stringify({
 version: 1, id: 'scene-test', name: 'Local operator',
 sampledAt: new Date(Date.now() - ageMs).toISOString(),
 phase, detail: 'reading project', target: { kind: 'filesystem', name: '/' },
}));
let bridge, window;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const finish = code => { bridge?.kill(); fs.rmSync(agentDir,{recursive:true,force:true}); app.exit(code); };
const timeout = setTimeout(() => { console.error('Scene verification timed out'); finish(1); }, 45000);
app.whenReady().then(async () => {
 const portProbe = net.createServer();
 await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
 const port = portProbe.address().port;
 await new Promise(resolve => portProbe.close(resolve));
 const address = '127.0.0.1:' + port, url = 'http://' + address;
 setSpeaker('silent');
 bridge = spawn(path.join(root,'bin/digital-terrarium'),[],{cwd:root,env:{...process.env,
  TERRARIUM_ADDRESS:address,TERRARIUM_SPOTIFY_ENABLED:'false',TERRARIUM_AGENT_STATE_DIR:agentDir,
  TERRARIUM_AUDIO_COMMAND:process.execPath+' '+path.join(root,'scripts/test-speaker.mjs')+' '+speakerMode},stdio:'ignore'});
 for(let i=0;i<40;i++) {try{const r=await fetch(url+'/api/health');if(r.ok)break;}catch{}await pause(100);}
 await pause(1100);
 const data = await (await fetch(url+'/api/ecosystem')).json();
 assert.equal(data.version,1);assert.ok(data.processes.length>0);assert.equal(typeof data.cpu,'number');
 for(const name of ['package.json','.git/config','api/media']) assert.equal((await fetch(url+'/'+name)).status,404);
 window = new BrowserWindow({show:false,width:1440,height:900,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}});
 const errors=[];
 window.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
 await window.loadURL(url+'/terrarium.html');
 for(let i=0;i<60;i++) {if(await window.webContents.executeJavaScript("document.querySelector('canvas').dataset.fresh==='true'"))break;await pause(100);}
 const scene=await window.webContents.executeJavaScript(`({ ...document.querySelector('canvas').dataset, controls:document.querySelectorAll('button,header,nav').length, alpha:document.querySelector('canvas').getContext('2d').getImageData(0,0,1,1).data[3] })`);
 assert.equal(scene.fresh,'true');assert.ok(Number(scene.creatures)>0);assert.equal(scene.controls,0);assert.equal(scene.alpha,255);
 // Hover the memory pool, then leave the scene. No persistent text is allowed.
 await window.webContents.executeJavaScript("document.querySelector('canvas').dispatchEvent(new PointerEvent('pointermove',{clientX:innerWidth*.84,clientY:innerHeight*.84}))");
 await pause(200);
 const popup=await window.webContents.executeJavaScript("document.querySelector('#tooltip').textContent");
 assert.ok(popup.includes('MEMORY / electrolyte'));
 await window.webContents.executeJavaScript("document.querySelector('canvas').dispatchEvent(new PointerEvent('pointerleave'))");
 assert.equal(await window.webContents.executeJavaScript("document.querySelector('#tooltip').style.display"),'none');
 const motion=await window.webContents.executeJavaScript(`(async()=>{
  const { emptyCreature, prepareCreature, stepCreatures } = await import('./ecology.mjs');
  const creatures=[0,.2].map(cpu=>({...emptyCreature(),group:{cpu,rssBytes:1e7}}));
  creatures.forEach(c=>prepareCreature(c,.05,true));
  stepCreatures(creatures,.05,1);
  return {idle:creatures[0].x===.5&&creatures[0].y===.5,active:creatures[1].x!==.5||creatures[1].y!==.5};
 })()`);
 assert.ok(motion.idle&&motion.active);
 // Real speaker capture moves the well, then fades on silence or capture loss.
 setSpeaker('playing');await pause(1000);
 assert.ok(Number(await window.webContents.executeJavaScript("document.querySelector('canvas').dataset.musicLevel"))>.5);
 assert.ok(Number(await window.webContents.executeJavaScript("document.querySelector('canvas').dataset.musicAmplitude"))>25);
 setSpeaker('silent');await pause(1000);
 assert.ok(Number(await window.webContents.executeJavaScript("document.querySelector('canvas').dataset.musicLevel"))<.02);
 assert.ok(Number(await window.webContents.executeJavaScript("document.querySelector('canvas').dataset.musicAmplitude"))<1);
 setSpeaker('exit');await pause(1600);
 assert.equal(await window.webContents.executeJavaScript("document.querySelector('canvas').dataset.audioAvailable"),'false');
 // Verify generic agent states through the real state directory and bridge.
 setAgent('tool');
 await pause(1000);
 assert.equal(await window.webContents.executeJavaScript("document.querySelector('canvas').dataset.agentPhase"),'tool');
 assert.equal(await window.webContents.executeJavaScript("document.querySelector('canvas').dataset.agentCount"),'1');
 // Hold the courier at its destination for the hover check; active couriers teleport.
 setAgent('waiting');await pause(900);
 await window.webContents.executeJavaScript(`{
  const canvas=document.querySelector('canvas');
  canvas.dispatchEvent(new PointerEvent('pointermove',{clientX:Number(canvas.dataset.agentX),clientY:Number(canvas.dataset.agentY)}));
 }`);
 await pause(100);
 assert.ok((await window.webContents.executeJavaScript("document.querySelector('#tooltip').textContent")).includes('Local operator / fast agent courier'));
 fs.writeFileSync('/tmp/digital-terrarium-agent.png',(await window.webContents.capturePage()).toPNG());
 setAgent('idle');await pause(900);
 assert.equal(await window.webContents.executeJavaScript("document.querySelector('canvas').dataset.agentPhase"),'idle');
 setAgent('tool',10000);await pause(900);
 assert.equal(await window.webContents.executeJavaScript("document.querySelector('canvas').dataset.agentCount"),'0');
 await window.webContents.executeJavaScript("document.querySelector('canvas').dispatchEvent(new PointerEvent('pointerleave'))");
 // Camera input through the real bridge and the real scene. A verification run
 // cannot lean into a camera, so synthetic landmarks drive the genuine feed the
 // same way synthetic PCM drives speaker capture above.
 const postVision = body => fetch(url+'/api/vision',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 // A ring of landmarks is not a face, but it exercises every path the head
 // derives: an extent to build a cranium from, eye positions to seat the eyes
 // on, and a span that gates the reveal.
 const faceAt = span => ({score:1,span,
  points:Array.from({length:68},(_,i)=>({x:.5+Math.cos(i/68*Math.PI*2)*span/2,y:.5+Math.sin(i/68*Math.PI*2)*span*.65}))});
 const dataset = key => window.webContents.executeJavaScript(`document.querySelector('canvas').dataset.${key}`);
 let visionBody={version:1,available:true,aspect:16/9,camera:'scene-check',face:faceAt(.14)};
 // The head expires in half a second by design, so the feed has to keep reporting.
 const visionFeed=setInterval(()=>postVision(visionBody).catch(()=>{}),100);
 // Sitting back shows nothing; leaning in brings the head up.
 await pause(600);
 assert.equal(await dataset('head'),'false');
 visionBody={...visionBody,face:faceAt(.34)};
 await pause(400);
 assert.equal(await dataset('head'),'true');
 fs.writeFileSync('/tmp/digital-terrarium-head.png',(await window.webContents.capturePage()).toPNG());
 // The geometry the head is derived from, exercised through the real modules.
 const grey=await window.webContents.executeJavaScript(`(async()=>{
  const { greyHead, alienEye, centroid, faceWireOpacity } = await import('./vision.mjs');
  const { FACE_RINGS } = await import('./vision-topology.mjs');
  const oval=Array.from({length:24},(_,i)=>{
   const angle=i/24*Math.PI*2;
   return {x:Math.cos(angle)*50,y:Math.sin(angle)*70+70};
  });
  const head=greyHead(oval);
  const xs=head.map(p=>p.x),ys=head.map(p=>p.y);
  const widest=head.reduce((best,p)=>Math.abs(p.x)>Math.abs(best.x)?p:best);
  const eye=alienEye({x:0,y:0},100,40,.42,1);
  const outer=eye.reduce((best,p)=>p.x>best.x?p:best);
  const inner=eye.reduce((best,p)=>p.x<best.x?p:best);
  return {
   risesAbove:Math.min(...ys)<Math.min(...oval.map(p=>p.y)),
   chinRises:Math.max(...ys)<Math.max(...oval.map(p=>p.y)),
   mostlyCranium:widest.y-Math.min(...ys)>Math.max(...ys)-widest.y,
   slants:outer.y<inner.y,
   mirrors:Math.abs(alienEye({x:0,y:0},100,40,.42,-1).reduce((b,p)=>p.x<b.x?p:b).x+outer.x)<1e-9,
   parts:Object.keys(FACE_RINGS).sort().join(','),
   faded:faceWireOpacity(.28)>0&&faceWireOpacity(.28)<1,
  };
 })()`);
 assert.ok(grey.risesAbove,'the cranium must carry above the measured face');
 assert.ok(grey.chinRises,'a grey has little face below the eyes');
 assert.ok(grey.mostlyCranium,'the cranium must outweigh the face below it');
 assert.ok(grey.slants,'eyes must slant up and out');
 assert.ok(grey.mirrors,'the second eye must mirror the first');
 assert.equal(grey.parts,'cranium,leftEye,rightEye','only drawn parts may travel');
 assert.ok(grey.faded,'the head must fade rather than snap on');
 // A camera that stops reporting must leave nothing behind.
 clearInterval(visionFeed);
 await pause(900);
 assert.equal(await dataset('head'),'false');
 // A failed bridge must visibly become stale rather than invent activity.
 fs.writeFileSync('/tmp/digital-terrarium-scene.png',(await window.webContents.capturePage()).toPNG());
 bridge.kill();await pause(3500);
 assert.equal(await window.webContents.executeJavaScript("document.querySelector('canvas').dataset.fresh"),'false');
 const unexpected=errors.filter(message=>!message.includes('ERR_CONNECTION_REFUSED')&&!message.includes('Failed to fetch'));
 assert.deepEqual(unexpected,[]);
 console.log(JSON.stringify({scene,motion,hover:true,stale:true,agent:true,grey:{hidden:true,revealed:true,...grey,expires:true,screenshot:'/tmp/digital-terrarium-head.png'},processGroups:data.processes.length,interfaces:data.network.length,filesystems:data.disks.length,screenshot:'/tmp/digital-terrarium-scene.png'},null,2));
 clearTimeout(timeout);finish(0);
}).catch(error=>{console.error(error);clearTimeout(timeout);finish(1);});
