const { app, BrowserWindow, session, screen, globalShortcut } = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');

const interfaceUrl = 'http://127.0.0.1:8090/';
let bridgeProcess;
const terrarium = process.argv.includes('--terrarium');

app.on('gpu-info-update', () => {
  if (!terrarium) return;
  const features = app.getGPUFeatureStatus();
  console.log('[terrarium GPU]', JSON.stringify({
    canvas: features['2d_canvas'], compositing: features.gpu_compositing,
    rasterization: features.rasterization,
  }));
});

function bridgeIsRunning() {
  return new Promise(resolve => {
    const request = http.get(interfaceUrl, response => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.setTimeout(300, () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function ensureBridge() {
  if (await bridgeIsRunning()) return;
  bridgeProcess = spawn('./bin/digital-terrarium', [], { cwd: __dirname, stdio: 'inherit' });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (await bridgeIsRunning()) return;
  }
  throw new Error('Local interface bridge did not start');
}

async function createWindow() {
  await ensureBridge();
  const window = new BrowserWindow({
    ...(terrarium ? { ...screen.getPrimaryDisplay().bounds, type: 'desktop', frame: false, skipTaskbar: true } : {}),
    width: terrarium ? screen.getPrimaryDisplay().bounds.width : 1440,
    height: terrarium ? screen.getPrimaryDisplay().bounds.height : 900,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.once('ready-to-show', () => {
    if (terrarium) { window.showInactive(); }
    else { window.maximize(); window.show(); }
  });
  await window.loadURL(interfaceUrl + (terrarium ? 'terrarium.html' : ''));
  if (terrarium) {
    globalShortcut.register('CommandOrControl+Alt+Q', () => app.quit());
  }
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media' && webContents.getURL().startsWith(interfaceUrl));
  });
  await createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => bridgeProcess?.kill());
