// Run: node_modules/.bin/electron scripts/fullscreen-check.cjs
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const binary = path.join(__dirname, '../bin/digital-terrarium');
let window;
const deadline = setTimeout(() => app.exit(1), 15000);
async function waitFor(fullscreen) {
  for (let i = 0; i < 40; i++) {
    const state = JSON.parse(execFileSync(binary, ['--fullscreen-state'], { timeout: 2000 }));
    assert.ok(!state.error, state.error);
    if (state.fullscreen === fullscreen) return;
    await pause(100);
  }
  assert.fail('Desktop did not report fullscreen=' + fullscreen);
}
app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 640, height: 360, title: 'Terrarium fullscreen verification' });
  await window.loadURL('data:text/html,<body style="background:%23151b23;color:white;font:24px sans-serif">Checking Terrarium fullscreen detection…</body>');
  window.show();
  window.focus();
  window.setFullScreen(true);
  await waitFor(true);
  await pause(2500); // Allow the running desktop scene to observe and suspend.
  window.setFullScreen(false);
  await waitFor(false);
  await pause(2500); // Allow the desktop scene to restore before closing.
  console.log('PASS: real fullscreen application detected; exiting fullscreen clears priority');
  clearTimeout(deadline);
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
