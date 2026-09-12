// Replays a real face captured by scripts/vision-check.cjs into the scene at a
// chosen span, and screenshots the result. Judging how the skull looks otherwise
// means a person holding still in front of a camera at an exact distance while
// someone else reads the screen.
//   npm run test:vision            # captures /tmp/digital-terrarium-face.json
//   npm run skull:replay -- 0.30   # renders it at a lean-in span
const { app, BrowserWindow, screen } = require('electron');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const root = path.join(__dirname, '..');
const capturePath = process.env.TERRARIUM_FACE ?? '/tmp/digital-terrarium-face.json';
const output = '/tmp/digital-terrarium-skull-replay.png';
const span = Number(process.argv.find(argument => /^0?\.\d+$/.test(argument)) ?? .3);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let bridge;
const finish = code => { bridge?.kill(); app.exit(code); };
app.whenReady().then(async () => {
 if (!fs.existsSync(capturePath)) throw new Error('No capture at ' + capturePath + '; run npm run test:vision first');
 const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
 if (!captured.face) throw new Error('That capture holds no face');
 const probe = net.createServer();
 await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
 const port = probe.address().port;
 await new Promise(resolve => probe.close(resolve));
 const url = 'http://127.0.0.1:' + port;
 bridge = spawn(path.join(root, 'bin/digital-terrarium'), [], { cwd: root, stdio: 'ignore',
  env: { ...process.env, TERRARIUM_ADDRESS: '127.0.0.1:' + port, TERRARIUM_SPOTIFY_ENABLED: 'false' } });
 for (let i = 0; i < 60; i++) { try { if ((await fetch(url + '/api/health')).ok) break; } catch {} await pause(100); }
 // Scale the real landmarks about their own centre to the requested span, and
 // centre them in frame so the jaw is not cropped by wherever the subject sat.
 const points = captured.face.points;
 const middle = {
  x: points.reduce((total, point) => total + point.x, 0) / points.length,
  y: points.reduce((total, point) => total + point.y, 0) / points.length,
 };
 const scale = span / captured.face.span;
 const body = { ...captured, face: { ...captured.face, span,
  points: points.map(point => ({ x: .5 + (point.x - middle.x) * scale, y: .44 + (point.y - middle.y) * scale })) } };
 const feed = setInterval(() => fetch(url + '/api/vision', { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {}), 100);
 // The desktop's own shape decides how much camera space is squeezed, so a
 // replay at any other aspect would judge proportions the scene never draws.
 const { width, height } = screen.getPrimaryDisplay().bounds;
 const viewer = new BrowserWindow({ show: false, width: Math.round(width / 2), height: Math.round(height / 2),
  webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
 await viewer.loadURL(url + '/terrarium.html');
 await pause(2500);
 const drawn = await viewer.webContents.executeJavaScript("document.querySelector('canvas').dataset.skull");
 fs.writeFileSync(output, (await viewer.webContents.capturePage()).toPNG());
 clearInterval(feed);
 console.log(JSON.stringify({ span, capturedSpan: captured.face.span, drawn: drawn === 'true',
  aspect: (width / height).toFixed(3), screenshot: output }, null, 2));
 finish(drawn === 'true' ? 0 : 1);
}).catch(error => { console.error(error.message); finish(1); });
