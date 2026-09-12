const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
let bridge, window;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const finish = code => { bridge?.kill(); app.exit(code); };
const timeout = setTimeout(() => { console.error('Scene verification timed out'); finish(1); }, 25000);
app.whenReady().then(async () => {
 const portProbe = net.createServer();
 await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
 const port = portProbe.address().port;
 await new Promise(resolve => portProbe.close(resolve));
 const address = '127.0.0.1:' + port, url = 'http://' + address;
 bridge = spawn(path.join(root,'bin/digital-terrarium'),[],{cwd:root,env:{...process.env,TERRARIUM_ADDRESS:address,TERRARIUM_SPOTIFY_ENABLED:'false'},stdio:'ignore'});
 for(let i=0;i<40;i++) {try{const r=await fetch(url+'/api/health');if(r.ok)break;}catch{}await pause(100);}
 await pause(1100);
 const data = await (await fetch(url+'/api/ecosystem')).json();
 assert.equal(data.version,1);assert.ok(data.processes.length>0);assert.equal(typeof data.cpu,'number');
 for(const name of ['package.json','.git/config','api/media']) assert.equal((await fetch(url+'/'+name)).status,404);
 window = new BrowserWindow({show:false,width:1440,height:900,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false}});
 const errors=[];
 window.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
 await window.loadURL(url+'/terrarium.html');
 for(let i=0;i<60;i++) {if(await window.webContents.executeJavaScript("document.querySelector('canvas').dataset.fresh==='true' && document.querySelector('canvas').dataset.backend.includes('GPU')"))break;await pause(100);}
 const scene=await window.webContents.executeJavaScript(`({ ...document.querySelector('canvas').dataset, controls:document.querySelectorAll('button,header,nav').length, alpha:document.querySelector('canvas').getContext('2d').getImageData(0,0,1,1).data[3] })`);
 assert.equal(scene.fresh,'true');assert.ok(Number(scene.creatures)>0);assert.equal(scene.controls,0);assert.equal(scene.alpha,255);assert.equal(scene.gpuFailed,'false');
 // Hover the memory pool, then leave the scene. No persistent text is allowed.
 await window.webContents.executeJavaScript("document.querySelector('canvas').dispatchEvent(new PointerEvent('pointermove',{clientX:innerWidth*.84,clientY:innerHeight*.84}))");
 await pause(200);
 const popup=await window.webContents.executeJavaScript("document.querySelector('#tooltip').textContent");
 assert.ok(popup.includes('MEMORY / electrolyte'));
 await window.webContents.executeJavaScript("document.querySelector('canvas').dispatchEvent(new PointerEvent('pointerleave'))");
 assert.equal(await window.webContents.executeJavaScript("document.querySelector('#tooltip').style.display"),'none');
 const gpu=await window.webContents.executeJavaScript(`(async()=>{
  const { createCreatureCompute } = await import('./creature-compute.mjs');
  const { emptyCreature, prepareCreature } = await import('./ecology.mjs');
  const engine=await createCreatureCompute(2);
  const creatures=[0,.2].map(cpu=>({...emptyCreature(),group:{cpu,rssBytes:1e7}}));
  creatures.forEach(c=>prepareCreature(c,.05,true));
  await engine.step(creatures,[],.05,1,true);
  const result={backend:engine.label,idle:creatures[0].x===.5&&creatures[0].y===.5,active:creatures[1].x!==.5||creatures[1].y!==.5};engine.destroy();return result;
 })()`);
 assert.ok(gpu.idle&&gpu.active);
 // Speaker input moves the well, then fades on silence or capture failure.
 await window.webContents.executeJavaScript(`
  window.audioFetch=window.fetch; window.audioMode='playing';
  window.fetch=(url,opts)=>url==='/api/audio'
   ? Promise.resolve(new Response(JSON.stringify({available:window.audioMode!=='offline',level:window.audioMode==='playing'?.7:0,bass:window.audioMode==='playing'?.4:0,waveform:Array(40).fill(window.audioMode==='playing'?.3:0)})))
   : window.audioFetch(url,opts);
  undefined;
 `);
 await pause(700);
 assert.ok(Number(await window.webContents.executeJavaScript("document.querySelector('canvas').dataset.musicLevel"))>.5);
 assert.ok(Number(await window.webContents.executeJavaScript("document.querySelector('canvas').dataset.musicAmplitude"))>25);
 await window.webContents.executeJavaScript("window.audioMode='silent'");await pause(700);
 assert.ok(Number(await window.webContents.executeJavaScript("document.querySelector('canvas').dataset.musicLevel"))<.02);
 assert.ok(Number(await window.webContents.executeJavaScript("document.querySelector('canvas').dataset.musicAmplitude"))<1);
 await window.webContents.executeJavaScript("window.audioMode='offline'");await pause(700);
 assert.equal(await window.webContents.executeJavaScript("document.querySelector('canvas').dataset.audioAvailable"),'false');
 await window.webContents.executeJavaScript("window.fetch=window.audioFetch;undefined");
 // Verify generic agent states without changing the live activity directory.
 await window.webContents.executeJavaScript(`
  window.originalFetch=window.fetch;
  window.agentTestPhase='tool';
  window.fetch=(url,opts)=>url==='/api/agents'
   ? Promise.resolve(new Response(JSON.stringify({version:1,sampledAt:new Date().toISOString(),agents:[{
     version:1,id:'scene-test',name:'Local operator',
     sampledAt:new Date(Date.now()-(window.agentTestPhase==='stale'?10000:0)).toISOString(),
     phase:window.agentTestPhase,detail:'reading project',target:{kind:'filesystem',name:'/'}
   }]})))
   : window.originalFetch(url,opts);
  undefined;
 `);
 await pause(1000);
 assert.equal(await window.webContents.executeJavaScript("document.querySelector('canvas').dataset.agentPhase"),'tool');
 assert.equal(await window.webContents.executeJavaScript("document.querySelector('canvas').dataset.agentCount"),'1');
 // Hold the courier at its destination for the hover check; active couriers teleport.
 await window.webContents.executeJavaScript("window.agentTestPhase='waiting'");await pause(700);
 await window.webContents.executeJavaScript(`{
  const canvas=document.querySelector('canvas');
  canvas.dispatchEvent(new PointerEvent('pointermove',{clientX:Number(canvas.dataset.agentX),clientY:Number(canvas.dataset.agentY)}));
 }`);
 await pause(100);
 assert.ok((await window.webContents.executeJavaScript("document.querySelector('#tooltip').textContent")).includes('Local operator / fast agent courier'));
 fs.writeFileSync('/tmp/digital-terrarium-agent.png',(await window.webContents.capturePage()).toPNG());
 await window.webContents.executeJavaScript("window.agentTestPhase='idle'");await pause(700);
 assert.equal(await window.webContents.executeJavaScript("document.querySelector('canvas').dataset.agentPhase"),'idle');
 await window.webContents.executeJavaScript("window.agentTestPhase='stale'");await pause(700);
 assert.equal(await window.webContents.executeJavaScript("document.querySelector('canvas').dataset.agentCount"),'0');
 await window.webContents.executeJavaScript("window.fetch=window.originalFetch;document.querySelector('canvas').dispatchEvent(new PointerEvent('pointerleave'))");
 // A failed bridge must visibly become stale rather than invent activity.
 fs.writeFileSync('/tmp/digital-terrarium-scene.png',(await window.webContents.capturePage()).toPNG());
 bridge.kill();await pause(3500);
 assert.equal(await window.webContents.executeJavaScript("document.querySelector('canvas').dataset.fresh"),'false');
 const unexpected=errors.filter(message=>!message.includes('ERR_CONNECTION_REFUSED')&&!message.includes('Failed to fetch'));
 assert.deepEqual(unexpected,[]);
 console.log(JSON.stringify({scene,gpu,hover:true,stale:true,agent:true,processGroups:data.processes.length,interfaces:data.network.length,filesystems:data.disks.length,screenshot:'/tmp/digital-terrarium-scene.png'},null,2));
 clearTimeout(timeout);finish(0);
}).catch(error=>{console.error(error);clearTimeout(timeout);finish(1);});
