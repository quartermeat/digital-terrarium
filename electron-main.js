const { app, BrowserWindow, session, screen, globalShortcut } = require('electron');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const { readHealth, ensureBridge: ensureVersionedBridge } = require('./bridge-lifecycle.cjs');

const interfaceUrl = 'http://' + (process.env.TERRARIUM_ADDRESS || '127.0.0.1:8091') + '/';
let bridgeProcess, visionWindow, sceneWindow, priorityTimer;
let priorityPaused = false, quitting = false, priorityError = '';
const terrarium = process.argv.includes('--terrarium');

app.on('gpu-info-update', () => {
  if (!terrarium) return;
  const features = app.getGPUFeatureStatus();
  console.log('[terrarium GPU]', JSON.stringify({
    canvas: features['2d_canvas'], compositing: features.gpu_compositing,
    rasterization: features.rasterization,
  }));
});

async function ensureBridge() {
  await ensureVersionedBridge({
    version: app.getVersion(),
    health: () => readHealth(interfaceUrl),
    replace: async () => {
      if (interfaceUrl !== 'http://127.0.0.1:8091/') throw new Error('Refusing to replace a bridge at a custom address');
      await run('systemctl', ['--user', 'is-active', '--quiet', 'terrarium-mood.service']);
      // Restart=always restores the backend; systemd may also recycle this
      // dependent display. The next startup rechecks the build version.
      await run('systemctl', ['--user', 'kill', '--kill-whom=main', '--signal=TERM', 'terrarium-mood.service']);
    },
    start: async () => {
      bridgeProcess = spawn('./bin/digital-terrarium', [], { cwd: __dirname, stdio: 'inherit' });
      bridgeProcess.on('error', error => console.error('[terrarium bridge]', error));
    },
  });
}

// The camera lives in its own hidden renderer: inference never competes with
// the habitat's frame budget, and a vision crash cannot take the scene down.
// Background throttling must stay off or Chromium clamps the detect loop to a
// frame a second once the window is hidden.
function createVisionSource() {
  visionWindow = new BrowserWindow({
    width: 320, height: 240, show: false, skipTaskbar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  visionWindow.on('closed', () => { visionWindow = undefined; });
  return visionWindow.loadURL(interfaceUrl + 'vision.html');
}

async function createWindow() {
  await ensureBridge();
  const window = new BrowserWindow({
    ...(terrarium ? { ...screen.getPrimaryDisplay().bounds, type: 'desktop', frame: false, skipTaskbar: true, alwaysOnTop: true } : {}),
    width: terrarium ? screen.getPrimaryDisplay().bounds.width : 1440,
    height: terrarium ? screen.getPrimaryDisplay().bounds.height : 900,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  sceneWindow = window;
  window.once('ready-to-show', () => {
    if (terrarium) {
      // Keep the ecology as the final visual layer while forwarding pointer
      // motion so hover inspection still works without stealing app focus.
      window.setAlwaysOnTop(true, 'floating');
      window.setIgnoreMouseEvents(true, { forward: true });
      window.showInactive();
    }
    else { window.maximize(); window.show(); }
  });
  // A hidden window still counts for window-all-closed, so the vision source
  // has to go when the scene does or the app would never quit.
  window.on('closed', () => visionWindow?.destroy());
  await window.loadURL(interfaceUrl + (terrarium ? 'terrarium.html' : ''));
  if (terrarium) {
    globalShortcut.register('CommandOrControl+Alt+Q', () => app.quit());
  }
}

// Unload both renderers instead of relying on Chromium background throttling:
// this stops animation, stream callbacks, inference, and camera capture.
async function setFullscreenPriority(pause, windowID) {
  if (quitting || sceneWindow.isDestroyed() || pause === priorityPaused) return;
  if (pause) {
    sceneWindow.hide();
    visionWindow?.destroy();
    priorityPaused = true;
    await sceneWindow.loadURL('about:blank');
    console.log('[terrarium priority] suspended for fullscreen window', windowID);
  } else {
    const loading = sceneWindow.loadURL(interfaceUrl + 'terrarium.html');
    // Show before waiting: a hidden renderer can defer painting/loading.
    sceneWindow.showInactive();
    await loading;
    if (quitting || sceneWindow.isDestroyed()) return;
    priorityPaused = false;
    createVisionSource().catch(error => console.error('[terrarium vision]', error));
    console.log('[terrarium priority] resumed');
  }
}

async function checkFullscreenPriority() {
  try {
    const { stdout } = await run('./bin/digital-terrarium', ['--fullscreen-state'], {
      cwd: __dirname, timeout: 2000,
    });
    const state = JSON.parse(stdout);
    const error = state.error || '';
    if (error !== priorityError) {
      if (error) console.warn('[terrarium priority]', error);
      priorityError = error;
    }
    // Detection failures fail open so an unavailable display/tool cannot leave
    // the wallpaper stuck off. A later successful check resumes normal control.
    await setFullscreenPriority(!error && state.fullscreen === true, state.window);
  } catch (error) {
    console.error('[terrarium priority]', error);
    await setFullscreenPriority(false).catch(error => console.error('[terrarium resume]', error));
  } finally {
    if (!quitting && !sceneWindow.isDestroyed()) {
      priorityTimer = setTimeout(checkFullscreenPriority, 1500);
    }
  }
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media' && webContents.getURL().startsWith(interfaceUrl));
  });
  await createWindow();
  // Vision is additive: a camera that will not open, or a renderer that fails
  // to load, must leave the ecology running rather than fail app startup.
  createVisionSource().catch(error => console.error('[terrarium vision]', error));
  if (terrarium && process.env.TERRARIUM_FULLSCREEN_PAUSE !== '0') {
    checkFullscreenPriority();
  }
}).catch(error => { console.error('[terrarium startup]', error); app.exit(1); });

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  quitting = true;
  clearTimeout(priorityTimer);
  visionWindow?.destroy();
  bridgeProcess?.kill();
});
