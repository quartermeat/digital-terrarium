// Verifies the real camera path end to end: the model loads, the device opens,
// and landmarks reach the bridge. Unlike scene-check this needs hardware and a
// person in frame, so it reports what it saw rather than asserting a subject.
//   npm run test:vision
const { app, BrowserWindow, session } = require('electron');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const root = path.join(__dirname, '..');
const seconds = Number(process.argv.find(argument => /^\d+$/.test(argument)) ?? 12);
let bridge, source, viewer;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const finish = code => { bridge?.kill(); app.exit(code); };
const timeout = setTimeout(() => { console.error('Vision verification timed out'); finish(1); }, (seconds + 60) * 1000);
app.whenReady().then(async () => {
 const probe = net.createServer();
 await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
 const port = probe.address().port;
 await new Promise(resolve => probe.close(resolve));
 const address = '127.0.0.1:' + port, url = 'http://' + address;
 session.defaultSession.setPermissionRequestHandler((contents, permission, callback) =>
  callback(permission === 'media' && contents.getURL().startsWith(url)));
 bridge = spawn(path.join(root, 'bin/digital-terrarium'), [], { cwd: root, stdio: 'ignore',
  env: { ...process.env, TERRARIUM_ADDRESS: address, TERRARIUM_SPOTIFY_ENABLED: 'false' } });
 for (let i = 0; i < 60; i++) { try { if ((await fetch(url + '/api/health')).ok) break; } catch {} await pause(100); }
 source = new BrowserWindow({ show: false, width: 320, height: 240,
  webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
 const problems = [];
 source.webContents.on('console-message', event => { if (event.level === 'error') problems.push(event.message); });
 // The camera is an exclusive device: the terrarium service holds it while it
 // runs, so this check needs it stopped first.
 await source.loadURL(url + '/vision.html');
 // Model download and camera open both happen on load; give them room.
 let state = '';
 for (let i = 0; i < 300; i++) {
  state = await source.webContents.executeJavaScript("document.querySelector('#state').textContent");
  if (!/^(starting|loading model|opening camera)$/.test(state)) break;
  await pause(200);
 }
 viewer = new BrowserWindow({ show: false, width: 1440, height: 900,
  webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
 await viewer.loadURL(url + '/terrarium.html');
 const seen = { minSpan: Infinity, maxSpan: 0, faceFrames: 0, frames: 0, available: false, camera: '', aspect: 0 };
 const deadline = Date.now() + seconds * 1000;
 let best = null;
 while (Date.now() < deadline) {
  const frame = await (await fetch(url + '/api/vision')).json();
  if (frame.available) {
   seen.frames += 1; seen.available = true; seen.camera = frame.camera ?? ''; seen.aspect = frame.aspect ?? 0;
   if (frame.face) {
    seen.faceFrames += 1;
    seen.minSpan = Math.min(seen.minSpan, frame.face.span);
    seen.maxSpan = Math.max(seen.maxSpan, frame.face.span);
    // Keep the closest moment for the screenshot, where the skull is brightest.
    if (!best || frame.face.span > best.span) {
     best = { span: frame.face.span };
     fs.writeFileSync('/tmp/digital-terrarium-camera.png', (await viewer.webContents.capturePage()).toPNG());
     // Keep the landmarks too. Replaying a real face is the only way to judge
     // how the skull looks without a person holding still in front of a camera.
     fs.writeFileSync('/tmp/digital-terrarium-face.json', JSON.stringify(frame));
    }
   }
  }
  await pause(250);
 }
 // The thresholds come from the module itself, so this report cannot drift
 // from what the scene actually draws.
 const { NEAR_SPAN, FULL_SPAN } = await import(pathToFileURL(path.join(root, 'vision.mjs')).href);
 const opacity = span => Math.max(0, Math.min(1, (span - NEAR_SPAN) / (FULL_SPAN - NEAR_SPAN)));
 console.log(JSON.stringify({ state, ...seen,
  minSpan: seen.faceFrames ? seen.minSpan : null,
  headOpacity: seen.faceFrames ? `${(opacity(seen.minSpan) * 100).toFixed(0)}%-${(opacity(seen.maxSpan) * 100).toFixed(0)}%` : null,
  screenshot: '/tmp/digital-terrarium-camera.png',
  landmarks: seen.faceFrames ? '/tmp/digital-terrarium-face.json' : null,
  problems: problems.slice(0, 5) }, null, 2));
 clearTimeout(timeout);
 finish(seen.available ? 0 : 1);
}).catch(error => { console.error(error); clearTimeout(timeout); finish(1); });
